import type { Client } from "ssh2";
import { runCommand } from "../ssh/runCommand.js";
import { wrapRemoteShell } from "../ssh/shell.js";
import { splitShellWords } from "./shellwords.js";
import { createPending, deletePending, loadPending } from "../state/pending.js";
import { getOctsshDir } from "../state/paths.js";

export type SecurityConfig = {
  denyRegex: string[];
  denyExecutables: string[];
  requireConfirmRegex: string[];
};

const BUILTIN_DENY_REGEX: string[] = [
  // Firewall / lockout risk
  "\\bufw\\s+disable\\b",
  "\\bsystemctl\\s+(stop|disable)\\s+(ufw|firewalld)\\b",
  "\\biptables\\b.*\\b(-P\\s+INPUT\\s+ACCEPT|-P\\s+INPUT\\s+DROP|-F\\b|-X\\b)\\b",
  "\\bnft\\s+flush\\s+ruleset\\b",
  // Common 'open everything' patterns
  "\\bfirewall-cmd\\b.*--add-port\\s*=?\\s*1-65535/(tcp|udp)\\b",
  // Device wipe / formatting
  "\\bdd\\b.*\\bof=/dev/(sd[a-z]|nvme\\d+n\\d+)\\b",
  "\\bmkfs\\.[a-z0-9]+\\s+/dev/",
  // Fork bomb
  ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:\\s*",
];

const BUILTIN_DENY_EXECUTABLES: string[] = [
  // Broad deny list for tools commonly used to lock yourself out.
  "iptables",
  "ufw",
  "nft",
  "firewall-cmd",
];

const BUILTIN_CONFIRM_REGEX: string[] = [
  // (Fallback) Any rm with -r/-R in the flag cluster.
  "\\brm\\b\\s+-\\S*[rR]\\S*",
  // Any rm --recursive
  "\\brm\\b\\s+--recursive\\b",
];

const homeCache = new WeakMap<object, string>();

async function getRemoteHome(client: Client) {
  const cached = homeCache.get(client as any);
  if (cached) return cached;
  const res = await runCommand(client, wrapRemoteShell('printf %s "$HOME"'), {
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });
  const home = res.stdout.trim();
  if (!home.startsWith('/')) throw new Error(`Failed to resolve remote $HOME (got: ${home})`);
  homeCache.set(client as any, home);
  return home;
}

export function buildEffectiveSecurityConfig(user: SecurityConfig) {
  return {
    denyRegex: [...BUILTIN_DENY_REGEX, ...(user.denyRegex ?? [])],
    denyExecutables: [...BUILTIN_DENY_EXECUTABLES, ...(user.denyExecutables ?? [])],
    requireConfirmRegex: [...BUILTIN_CONFIRM_REGEX, ...(user.requireConfirmRegex ?? [])],
  } satisfies SecurityConfig;
}

function tryRegex(pattern: string) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function matchesAnyRegex(command: string, patterns: string[]) {
  for (const p of patterns) {
    const re = tryRegex(p);
    if (!re) continue;
    if (re.test(command)) return p;
  }
  return null;
}

function matchesExecutable(command: string, exe: string) {
  const escaped = exe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s;&|()])(?:sudo\\s+)?(?:\\S*/)?${escaped}\\b`, "i");
  return re.test(command);
}

export type CommandGuardResult =
  | { action: "allow" }
  | { action: "block"; reason: string; message: string }
  | {
      action: "confirm";
      confirm_code: string;
      message: string;
      preview: { type: string; total: number; truncated: boolean; sample: string[] };
    };

function isSudoInvocation(command: string) {
  // Conservative: if the command contains `sudo` as a word, treat as sudo usage.
  return /(^|[\s;&|()])sudo(\s|$)/i.test(command);
}

function extractRmTargets(command: string) {
  const words = splitShellWords(command);
  if (words.length === 0) return null;

  // Only handle simple "rm ..." in the first command segment.
  // If the user is chaining commands, we still want to block/confirm, but
  // preview is only supported for the rm targets we can parse.
  const rmIndex = words.findIndex((w) => w === "rm" || w.endsWith("/rm"));
  if (rmIndex === -1) return null;

  const after = words.slice(rmIndex + 1);
  const targets: string[] = [];
  for (const w of after) {
    if (w === "--") continue;
    if (w.startsWith("-")) continue;
    targets.push(w);
  }
  return targets.length ? targets : null;
}

function isRecursiveRm(command: string) {
  const words = splitShellWords(command);
  const rmIndex = words.findIndex((w) => w === "rm" || w.endsWith("/rm"));
  if (rmIndex === -1) return false;

  for (const w of words.slice(rmIndex + 1)) {
    if (w === "--") break;
    if (w === "--recursive") return true;
    if (!w.startsWith("-")) break;
    // flags like -rf, -r, -R
    if (w.includes("r") || w.includes("R")) return true;
  }
  return false;
}

function isClearlyDangerousRootDelete(targets: string[]) {
  // Hard block obvious catastrophic cases.
  for (const t of targets) {
    if (t === "/" || t === "/*" || t.startsWith("/ --")) return true;
    if (t.startsWith("/etc") || t.startsWith("/bin") || t.startsWith("/usr")) {
      // still allow preview+confirm (not hard-block) unless it's exactly root.
      continue;
    }
  }
  return false;
}

async function previewDeletePaths(client: Client, targets: string[]) {
  // Bounded preview: collect up to 10001 paths total, then truncate.
  // This avoids remote CPU/disk meltdown on huge trees.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const home = await getRemoteHome(client);
  const normalized = targets.map((t) => {
    const raw = t.trim();
    // Expand common home-variable forms so previews work for commands like:
    // rm -rf "$HOME/\$HOME" (delete literal "$HOME" dir inside home)
    if (raw === "$HOME" || raw === "${HOME}") return home;
    if (raw.startsWith("$HOME/")) return `${home}/${raw.slice("$HOME/".length)}`;
    if (raw.startsWith("${HOME}/")) return `${home}/${raw.slice("${HOME}/".length)}`;
    if (raw === "~") return home;
    if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
    return raw;
  });
  const args = normalized.map((t) => q(t)).join(" ");

  const script = [
    "set -eu",
    "limit=10001",
    // Print up to 10 sample lines, plus bounded total and truncated markers.
    "(for p in \"$@\"; do if [ -e \"$p\" ]; then find \"$p\" -print 2>/dev/null; fi; done)" +
      " | head -n $limit" +
      " | awk -v limit=$limit 'NR<=10{print} END{print \"__OCTSSH_TOTAL__:\" NR; print \"__OCTSSH_TRUNCATED__:\" (NR>=limit?\"true\":\"false\")}'",
  ].join("; ");

  const cmd = `sh -lc ${q(script)} sh ${args}`;
  const res = await runCommand(client, cmd, {
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 8 * 1024,
  });
  const lines = res.stdout.split(/\r?\n/).filter(Boolean);
  const sample: string[] = [];
  let total = 0;
  let truncated = false;
  for (const l of lines) {
    if (l.startsWith("__OCTSSH_TOTAL__:")) {
      total = Number(l.split(":")[1] ?? 0) || 0;
      continue;
    }
    if (l.startsWith("__OCTSSH_TRUNCATED__:")) {
      truncated = (l.split(":")[1] ?? "").trim() === "true";
      continue;
    }
    sample.push(l);
  }
  return { type: "rm-preview", total, truncated, sample };
}

export async function guardExecCommand(params: {
  client: Client;
  machine: string;
  command: string;
  allowSudo: boolean;
  confirm_code?: string;
  security: SecurityConfig;
}) : Promise<CommandGuardResult> {
  const effective = buildEffectiveSecurityConfig(params.security);

  if (!params.allowSudo && isSudoInvocation(params.command)) {
    return {
      action: "block",
      reason: "sudo_not_allowed",
      message:
        "This tool does not allow sudo. Use `sudo-exec` / `exec-async-sudo` instead (passwordless sudo only).",
    };
  }

  for (const exe of effective.denyExecutables) {
    if (matchesExecutable(params.command, exe)) {
      return {
        action: "block",
        reason: "blocked_executable",
        message: `Blocked high-risk executable: ${exe}`,
      };
    }
  }

  const deny = matchesAnyRegex(params.command, effective.denyRegex);
  if (deny) {
    return {
      action: "block",
      reason: "blocked_pattern",
      message: `Blocked by security policy pattern: ${deny}`,
    };
  }

  const needConfirm =
    isRecursiveRm(params.command) ||
    !!matchesAnyRegex(params.command, effective.requireConfirmRegex);
  if (!needConfirm) return { action: "allow" };

  // Confirmation path.
  if (params.confirm_code) {
    const rec = loadPending(params.confirm_code, getOctsshDir());
    if (!rec || rec.kind !== "exec") {
      return {
        action: "block",
        reason: "invalid_confirm_code",
        message:
          "Invalid confirm code. Re-run the command without confirm_code to get a new preview.",
      };
    }
    if (rec.machine !== params.machine || rec.command !== params.command) {
      return {
        action: "block",
        reason: "confirm_mismatch",
        message:
          "Confirm code does not match this command/machine. Re-run without confirm_code to preview again.",
      };
    }
    deletePending(params.confirm_code, getOctsshDir());
    return { action: "allow" };
  }

  // Only preview rm-based destructive commands.
  const targets = extractRmTargets(params.command) ?? [];
  if (targets.length === 0) {
    return {
      action: "block",
      reason: "requires_confirm_no_preview",
      message:
        "Destructive command requires confirmation but preview is not available for this syntax. Rewrite the command into an explicit `rm -r <path>` form.",
    };
  }
  if (isClearlyDangerousRootDelete(targets)) {
    return {
      action: "block",
      reason: "root_delete_blocked",
      message: "Refusing to run: this appears to delete root filesystem.",
    };
  }

  const preview = await previewDeletePaths(params.client, targets);
  const code = createPending(
    {
      kind: "exec",
      createdAt: new Date().toISOString(),
      machine: params.machine,
      command: params.command,
      preview,
    },
    getOctsshDir()
  );

  const msg =
    "DANGEROUS OPERATION DETECTED.\n" +
    "This command can permanently delete files. OctSSH is running in VIRTUAL MODE and refused to execute it.\n" +
    `Previewed ${preview.total}${preview.truncated ? "+" : ""} affected paths.\n` +
    "If you are 100% sure, re-run the SAME command with confirm_code.\n" +
    "Before confirming: enumerate the listed paths and explain WHY each is safe to delete.";

  return {
    action: "confirm",
    confirm_code: code,
    message: msg,
    preview,
  };
}
