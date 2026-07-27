import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import { z } from "zod";
import { ConnectionPool } from "../ssh/connectionPool.js";
import { connectDirect, connectWithProxyJump } from "../ssh/connect.js";
import { planMachineConnection } from "../ssh/machine.js";
import { runCommand } from "../ssh/runCommand.js";
import {
  wrapRemoteShell,
  wrapSudoRemoteShell,
  isSudoPasswordError,
} from "../ssh/shell.js";
import { discoverHostAliases } from "../ssh/config/hosts.js";
import { loadConfig } from "../state/config.js";
import { getOctsshDir } from "../state/paths.js";
import { startAsyncInScreen } from "../ssh/asyncScreen.js";
import { loadSession, saveSession } from "../state/sessions.js";
import { quoteForSh } from "../ssh/shell.js";
import { findExpiredSessions, deleteSessionFile } from "../state/cleanup.js";
import { loadInventory, saveInventory } from "../state/inventory.js";
import { collectExtendedInfo } from "../init/extended.js";
import { guardExecCommand } from "../security/policy.js";
import { createPending, deletePending, loadPending } from "../state/pending.js";
import { planUpload, findUploadConflicts, performUpload } from "../transfer/upload.js";
import { planDownload, findDownloadConflicts, performDownload } from "../transfer/download.js";
import { startUploadAsync, startDownloadAsync, cancelTransfer } from "../transfer/manager.js";

type ToolResult = {
  ok: boolean;
  tool: string;
  error?: string;
  data?: unknown;
};

function respond(result: ToolResult) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

function notImplemented(tool: string) {
  return respond({ ok: false, tool, error: "not implemented" });
}

function isoNow() {
  return new Date().toISOString();
}

function tailLocalFile(filePath: string, lines: number) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parts = raw.split(/\r?\n/);
    const tail = parts.slice(Math.max(0, parts.length - lines)).filter(Boolean);
    return tail.join("\n");
  } catch {
    return "";
  }
}

function toHomeAbs(remotePath: string) {
  // Session records store paths either as `.octssh/...` or `~/.octssh/...`.
  // We normalize to a shell-safe `$HOME/...` reference.
  const p = remotePath.trim();
  if (p.startsWith("~/")) return `$HOME/${p.slice(2)}`;
  if (p.startsWith(".")) return `$HOME/${p}`;
  return p;
}

function normalizeToolPrefix(raw: string | undefined) {
  const v = (raw ?? "").trim();
  if (!v) return "";
  return v.endsWith("_") ? v : `${v}_`;
}

export function createOctsshServer() {
  const cfg = loadConfig(getOctsshDir());

  type MachineConn = {
    ssh: { client: any; end: () => void };
    warnings: string[];
  };

  const pool = new ConnectionPool<string, MachineConn>({
    create: async (machine) => {
      const plan = planMachineConnection(machine);
      const ssh = plan.jump
        ? await connectWithProxyJump({ jump: plan.jump, target: plan.target })
        : await connectDirect(plan.target);
      return { ssh, warnings: plan.warnings };
    },
    close: async (v) => {
      v.ssh.end();
    },
    options: {
      maxConnections: cfg.maxConnections,
      idleTtlMs: cfg.idleTtlSeconds * 1000,
    },
  });

  // Best-effort background sweep. This doesn't need to be perfect; the pool
  // also evicts on demand when hitting caps.
  setInterval(() => {
    pool.sweep().catch(() => undefined);
  }, Math.min(cfg.idleTtlSeconds * 1000, 60_000)).unref();

  // TTL cleanup (local + remote best-effort). Default retention is 7 days.
  setInterval(async () => {
    try {
      const currentCfg = loadConfig(getOctsshDir());
      const expired = findExpiredSessions({
        baseDir: getOctsshDir(),
        retentionDays: currentCfg.retentionDays,
      });
      for (const rec of expired) {
        // Local-only transfer sessions.
        if ((rec as any).kind === "transfer") {
          const logPath = (rec as any).localLogPath as string | undefined;
          if (logPath) {
            try {
              fs.rmSync(logPath, { force: true });
            } catch {
              // ignore
            }
          }
          deleteSessionFile(rec.session_id, getOctsshDir());
          continue;
        }

        // Best-effort remote cleanup.
        try {
          const lease = await pool.get(rec.machine);
          try {
            await runCommand(
              lease.value.ssh.client,
              wrapRemoteShell(
                [
                  `rm -rf \"$HOME/${rec.remoteDir}\" 2>/dev/null || true`,
                  `screen -S ${quoteForSh(rec.screenName)} -X quit 2>/dev/null || true`,
                ].join("; ")
              ),
              { maxStdoutBytes: 8 * 1024, maxStderrBytes: 8 * 1024 }
            );
          } finally {
            lease.release();
          }
        } catch {
          // ignore remote errors
        }

        // Always delete local record when expired.
        deleteSessionFile(rec.session_id, getOctsshDir());
      }
    } catch {
      // ignore cleanup errors
    }
  }, 60 * 60 * 1000).unref();

  const server = new McpServer({
    name: "octssh",
    version: "0.0.0",
  });

  const toolPrefix = normalizeToolPrefix(process.env.OCTSSH_TOOL_PREFIX);
  const toolName = (name: string) => `${toolPrefix}${name}`;

  server.registerTool(
    toolName("list"),
    {
      title: "List SSH Hosts",
      description:
        "List configured SSH hosts from local ssh_config. Optionally return cached extended fields.",
      inputSchema: z
        .object({
          target: z.array(z.string()).optional(),
        })
        .optional(),
    },
    async (input) => {
      const hosts = discoverHostAliases();
      const target = (input as any)?.target as string[] | undefined;

      const inv = loadInventory(getOctsshDir());
      if (target && inv && inv.extended) {
        const byName = new Map(inv.machines.map((m) => [m.name, m]));
        const machines = hosts.map((h) => {
          const m = byName.get(h);
          const out: any = { name: h };
          for (const t of target) {
            if (m && Object.prototype.hasOwnProperty.call(m, t)) out[t] = (m as any)[t];
          }
          return out;
        });

        return respond({ ok: true, tool: "list", data: { machines, target } });
      }

      return respond({ ok: true, tool: "list", data: { hosts } });
    }
  );

  server.registerTool(
    toolName("info"),
    {
      title: "Machine Info",
      description:
        "Get cached (or refreshed) extended info for a machine via SSH.",
      inputSchema: z.object({
        machine: z.string().min(1),
        refresh: z.boolean().optional(),
      }),
    },
    async ({ machine, refresh }) => {
      const baseDir = getOctsshDir();
      const inv = loadInventory(baseDir);

      if (!refresh) {
        const entry = inv?.machines.find((m) => m.name === machine);
        if (!entry) {
          return respond({
            ok: false,
            tool: "info",
            error:
              "No cached info. Run `octssh init` (Extended) or call info(refresh=true).",
          });
        }
        return respond({ ok: true, tool: "info", data: entry });
      }

      const lease = await pool.get(machine);
      try {
        const info = await collectExtendedInfo(lease.value.ssh.client);
        const updated = { name: machine, updatedAt: isoNow(), ...info };

        const existing = inv ?? { extended: true, machines: [] };
        const filtered = existing.machines.filter((m) => m.name !== machine);
        saveInventory({ extended: true, machines: [...filtered, updated] }, baseDir);

        return respond({ ok: true, tool: "info", data: updated });
      } catch (err: any) {
        return respond({ ok: false, tool: "info", error: String(err?.message ?? err) });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("exec"),
    {
      title: "Execute Command",
      description: "Execute a command on a machine (no sudo).",
      inputSchema: z.object({
        machine: z.string().min(1),
        command: z.string().min(1),
        confirm_code: z.string().optional(),
      }),
    },
    async ({ machine, command, confirm_code }) => {
      const lease = await pool.get(machine);
      try {
        const decision = await guardExecCommand({
          client: lease.value.ssh.client,
          machine,
          command,
          allowSudo: false,
          confirm_code,
          security: cfg.security,
        });
        if (decision.action === "block") {
          return respond({ ok: false, tool: "exec", error: decision.message });
        }
        if (decision.action === "confirm") {
          return respond({
            ok: false,
            tool: "exec",
            error: decision.message,
            data: {
              confirm_code: decision.confirm_code,
              preview: {
                total: decision.preview.total,
                truncated: decision.preview.truncated,
                sample: decision.preview.sample.slice(0, 10),
              },
            },
          });
        }

        const res = await runCommand(lease.value.ssh.client, wrapRemoteShell(command));
        return respond({
          ok: res.exitCode === 0,
          tool: "exec",
          data: {
            machine,
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated,
            warnings: lease.value.warnings,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("sudo-exec"),
    {
      title: "Execute Command (sudo)",
      description:
        "Execute a command on a machine using passwordless sudo (sudo -n).",
      inputSchema: z.object({
        machine: z.string().min(1),
        command: z.string().min(1),
        confirm_code: z.string().optional(),
      }),
    },
    async ({ machine, command, confirm_code }) => {
      const lease = await pool.get(machine);
      try {
        const decision = await guardExecCommand({
          client: lease.value.ssh.client,
          machine,
          command,
          allowSudo: true,
          confirm_code,
          security: cfg.security,
        });
        if (decision.action === "block") {
          return respond({ ok: false, tool: "sudo-exec", error: decision.message });
        }
        if (decision.action === "confirm") {
          return respond({
            ok: false,
            tool: "sudo-exec",
            error: decision.message,
            data: {
              confirm_code: decision.confirm_code,
              preview: {
                total: decision.preview.total,
                truncated: decision.preview.truncated,
                sample: decision.preview.sample.slice(0, 10),
              },
            },
          });
        }

        const res = await runCommand(lease.value.ssh.client, wrapSudoRemoteShell(command));
        const sudoHint =
          res.exitCode !== 0 && isSudoPasswordError(res.stderr)
            ? "Passwordless sudo is required. Configure sudoers to allow sudo without password for the SSH user."
            : null;

        return respond({
          ok: res.exitCode === 0,
          tool: "sudo-exec",
          data: {
            machine,
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated,
            sudoHint,
            warnings: lease.value.warnings,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("exec-async"),
    {
      title: "Execute Async",
      description:
        "Execute a long-running command in background (remote screen session).",
      inputSchema: z.object({
        machine: z.string().min(1),
        command: z.string().min(1),
        confirm_code: z.string().optional(),
      }),
    },
    async ({ machine, command, confirm_code }) => {
      const lease = await pool.get(machine);
      try {
        const decision = await guardExecCommand({
          client: lease.value.ssh.client,
          machine,
          command,
          allowSudo: false,
          confirm_code,
          security: cfg.security,
        });
        if (decision.action === "block") {
          return respond({ ok: false, tool: "exec-async", error: decision.message });
        }
        if (decision.action === "confirm") {
          return respond({
            ok: false,
            tool: "exec-async",
            error: decision.message,
            data: {
              confirm_code: decision.confirm_code,
              preview: {
                total: decision.preview.total,
                truncated: decision.preview.truncated,
                sample: decision.preview.sample.slice(0, 10),
              },
            },
          });
        }

        const started = await startAsyncInScreen(lease.value.ssh.client, {
          machine,
          command,
          sudo: false,
        });
        return respond({ ok: true, tool: "exec-async", data: started });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("exec-async-sudo"),
    {
      title: "Execute Async (sudo)",
      description:
        "Execute a long-running command in background using passwordless sudo.",
      inputSchema: z.object({
        machine: z.string().min(1),
        command: z.string().min(1),
        confirm_code: z.string().optional(),
      }),
    },
    async ({ machine, command, confirm_code }) => {
      const lease = await pool.get(machine);
      try {
        const decision = await guardExecCommand({
          client: lease.value.ssh.client,
          machine,
          command,
          allowSudo: true,
          confirm_code,
          security: cfg.security,
        });
        if (decision.action === "block") {
          return respond({ ok: false, tool: "exec-async-sudo", error: decision.message });
        }
        if (decision.action === "confirm") {
          return respond({
            ok: false,
            tool: "exec-async-sudo",
            error: decision.message,
            data: {
              confirm_code: decision.confirm_code,
              preview: {
                total: decision.preview.total,
                truncated: decision.preview.truncated,
                sample: decision.preview.sample.slice(0, 10),
              },
            },
          });
        }

        const started = await startAsyncInScreen(lease.value.ssh.client, {
          machine,
          command,
          sudo: true,
        });
        return respond({ ok: true, tool: "exec-async-sudo", data: started });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("upload"),
    {
      title: "Upload Files/Directory",
      description:
        "Upload a file or directory to the remote machine. Refuses to overwrite unless confirm_code is provided after a conflict preview.",
      inputSchema: z.object({
        machine: z.string().min(1),
        localPath: z.string().min(1),
        remotePath: z.string().min(1),
        confirm_code: z.string().optional(),
      }),
    },
    async ({ machine, localPath, remotePath, confirm_code }) => {
      const lease = await pool.get(machine);
      try {
        const plan = await planUpload(lease.value.ssh.client, localPath, remotePath);
        const conflicts = await findUploadConflicts(lease.value.ssh.client, plan);

        if (conflicts.length > 0) {
          if (!confirm_code) {
            const code = createPending(
              {
                kind: "upload",
                createdAt: isoNow(),
                machine,
                localPath,
                remotePath,
                conflicts,
              },
              getOctsshDir()
            );
            return respond({
              ok: false,
              tool: "upload",
              error:
                "VIRTUAL MODE: upload would overwrite existing remote files. Re-run upload with confirm_code to proceed.",
              data: {
                confirm_code: code,
                conflicts: conflicts.slice(0, 10),
                totalConflicts: conflicts.length,
              },
            });
          }

          const pending = loadPending(confirm_code, getOctsshDir());
          if (!pending || pending.kind !== "upload") {
            return respond({
              ok: false,
              tool: "upload",
              error:
                "Invalid confirm_code. Re-run upload without confirm_code to get a new conflict preview.",
            });
          }
          if (
            pending.machine !== machine ||
            pending.localPath !== localPath ||
            pending.remotePath !== remotePath
          ) {
            return respond({
              ok: false,
              tool: "upload",
              error:
                "confirm_code does not match this upload request. Re-run upload without confirm_code to preview again.",
            });
          }
          deletePending(confirm_code, getOctsshDir());
        }

        const result = await performUpload(lease.value.ssh.client, plan);
        return respond({ ok: true, tool: "upload", data: { machine, ...result } });
      } catch (err: any) {
        return respond({ ok: false, tool: "upload", error: String(err?.message ?? err) });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("download"),
    {
      title: "Download Files/Directory",
      description:
        "Download a file or directory from the remote machine. Never overwrites local files; on conflict, you must choose a new local directory.",
      inputSchema: z.object({
        machine: z.string().min(1),
        remotePath: z.string().min(1),
        localPath: z.string().min(1),
      }),
    },
    async ({ machine, remotePath, localPath }) => {
      const lease = await pool.get(machine);
      try {
        const plan = await planDownload(lease.value.ssh.client, remotePath, localPath);
        const conflicts = findDownloadConflicts(plan);
        if (conflicts.length > 0) {
          return respond({
            ok: false,
            tool: "download",
            error:
              "Refusing to overwrite local files. Choose a new localPath (empty or non-existent directory).",
            data: { conflicts: conflicts.slice(0, 10), totalConflicts: conflicts.length },
          });
        }

        const result = await performDownload(lease.value.ssh.client, plan);
        return respond({ ok: true, tool: "download", data: { machine, ...result } });
      } catch (err: any) {
        return respond({ ok: false, tool: "download", error: String(err?.message ?? err) });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("upload-async"),
    {
      title: "Upload Async",
      description:
        "Async upload. Only creates a session if the transfer actually starts. Uses the same overwrite confirmation logic as upload.",
      inputSchema: z.object({
        machine: z.string().min(1),
        localPath: z.string().min(1),
        remotePath: z.string().min(1),
        confirm_code: z.string().optional(),
      }),
    },
    async ({ machine, localPath, remotePath, confirm_code }) => {
      const lease = await pool.get(machine);
      try {
        const plan = await planUpload(lease.value.ssh.client, localPath, remotePath);
        const conflicts = await findUploadConflicts(lease.value.ssh.client, plan);
        if (conflicts.length > 0) {
          if (!confirm_code) {
            const code = createPending(
              {
                kind: "upload",
                createdAt: isoNow(),
                machine,
                localPath,
                remotePath,
                conflicts,
              },
              getOctsshDir()
            );
            return respond({
              ok: false,
              tool: "upload-async",
              error:
                "VIRTUAL MODE: upload would overwrite existing remote files. Re-run upload-async with confirm_code to proceed.",
              data: {
                confirm_code: code,
                conflicts: conflicts.slice(0, 10),
                totalConflicts: conflicts.length,
              },
            });
          }
          const pending = loadPending(confirm_code, getOctsshDir());
          if (!pending || pending.kind !== "upload") {
            return respond({
              ok: false,
              tool: "upload-async",
              error:
                "Invalid confirm_code. Re-run upload-async without confirm_code to get a new conflict preview.",
            });
          }
          if (
            pending.machine !== machine ||
            pending.localPath !== localPath ||
            pending.remotePath !== remotePath
          ) {
            return respond({
              ok: false,
              tool: "upload-async",
              error:
                "confirm_code does not match this upload request. Re-run upload-async without confirm_code to preview again.",
            });
          }
          deletePending(confirm_code, getOctsshDir());
        }

        const started = startUploadAsync({
          client: lease.value.ssh.client,
          machine,
          localPath,
          remotePath,
          plan,
        });
        return respond({ ok: true, tool: "upload-async", data: started });
      } catch (err: any) {
        return respond({ ok: false, tool: "upload-async", error: String(err?.message ?? err) });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("download-async"),
    {
      title: "Download Async",
      description:
        "Async download. Only creates a session if the transfer actually starts. Never overwrites local files.",
      inputSchema: z.object({
        machine: z.string().min(1),
        remotePath: z.string().min(1),
        localPath: z.string().min(1),
      }),
    },
    async ({ machine, remotePath, localPath }) => {
      const lease = await pool.get(machine);
      try {
        const plan = await planDownload(lease.value.ssh.client, remotePath, localPath);
        const conflicts = findDownloadConflicts(plan);
        if (conflicts.length > 0) {
          return respond({
            ok: false,
            tool: "download-async",
            error:
              "Refusing to overwrite local files. Choose a new localPath (empty or non-existent directory).",
            data: { conflicts: conflicts.slice(0, 10), totalConflicts: conflicts.length },
          });
        }

        const started = startDownloadAsync({
          client: lease.value.ssh.client,
          machine,
          remotePath,
          localPath,
          plan,
        });
        return respond({ ok: true, tool: "download-async", data: started });
      } catch (err: any) {
        return respond({ ok: false, tool: "download-async", error: String(err?.message ?? err) });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("get-result"),
    {
      title: "Get Async Result",
      description:
        "Get async command status; optionally tail last N lines from logs.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        lines: z.number().int().positive().max(2000).optional(),
      }),
    },
    async ({ session_id, lines }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) {
        return respond({ ok: false, tool: "get-result", error: "session not found" });
      }

      // Local transfer session.
      if ((rec as any).kind === "transfer") {
        const n = lines ? Math.max(1, Math.min(2000, Math.floor(lines))) : null;
        const logPath = (rec as any).localLogPath as string | undefined;
        const tails =
          n && logPath
            ? {
                log: tailLocalFile(logPath, n),
              }
            : null;

        return respond({
          ok: true,
          tool: "get-result",
          data: {
            session_id,
            kind: "transfer",
            machine: rec.machine,
            status: rec.status,
            direction: (rec as any).direction,
            localPath: (rec as any).localPath,
            remotePath: (rec as any).remotePath,
            bytesDone: (rec as any).bytesDone ?? null,
            bytesTotal: (rec as any).bytesTotal ?? null,
            error: (rec as any).error ?? null,
            tails,
          },
        });
      }

      const lease = await pool.get(rec.machine);
      try {
        // Read remote meta.json (best-effort).
        const metaCmd = wrapRemoteShell(
          `test -f \"${toHomeAbs(rec.metaPath)}\" && cat \"${toHomeAbs(rec.metaPath)}\" || true`
        );
        const metaRes = await runCommand(lease.value.ssh.client, metaCmd, {
          maxStdoutBytes: 16 * 1024,
          maxStderrBytes: 4 * 1024,
        });

        let remoteMeta: any = null;
        try {
          remoteMeta = metaRes.stdout.trim() ? JSON.parse(metaRes.stdout) : null;
        } catch {
          remoteMeta = null;
        }

        let status = rec.status;
        let exitCode = rec.exitCode ?? null;
        if (remoteMeta && typeof remoteMeta.status === "string") {
          if (remoteMeta.status === "running") status = "running";
          if (remoteMeta.status === "done") {
            status = remoteMeta.exitCode === 0 ? "done" : "failed";
            if (typeof remoteMeta.exitCode === "number") exitCode = remoteMeta.exitCode;
          }
        }

        // Persist status update.
        if (status !== rec.status || exitCode !== rec.exitCode) {
          saveSession(
            {
              ...rec,
              status,
              exitCode: exitCode === null ? undefined : exitCode,
              updatedAt: isoNow(),
            },
            getOctsshDir()
          );
        }

        let tails: any = null;
        if (lines) {
          const n = Math.max(1, Math.min(2000, Math.floor(lines)));
          const tailStdout = await runCommand(
            lease.value.ssh.client,
            wrapRemoteShell(
              `tail -n ${n} \"${toHomeAbs(rec.stdoutPath)}\" 2>/dev/null || true`
            ),
            { maxStdoutBytes: 64 * 1024, maxStderrBytes: 4 * 1024 }
          );
          const tailStderr = await runCommand(
            lease.value.ssh.client,
            wrapRemoteShell(
              `tail -n ${n} \"${toHomeAbs(rec.stderrPath)}\" 2>/dev/null || true`
            ),
            { maxStdoutBytes: 64 * 1024, maxStderrBytes: 4 * 1024 }
          );
          tails = {
            stdout: tailStdout.stdout,
            stderr: tailStderr.stdout,
          };
        }

        return respond({
          ok: true,
          tool: "get-result",
          data: {
            session_id,
            machine: rec.machine,
            status,
            exitCode,
            screenName: rec.screenName,
            cmdPid: rec.cmdPid ?? null,
            tails,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("grep-result"),
    {
      title: "Search Async Logs",
      description: "Search async stdout/stderr logs by pattern.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        pattern: z.string().min(1),
        maxMatches: z.number().int().positive().max(500).optional(),
        contextLines: z.number().int().min(0).max(50).optional(),
      }),
    },
    async ({ session_id, pattern, maxMatches, contextLines }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) {
        return respond({ ok: false, tool: "grep-result", error: "session not found" });
      }

      const lease = await pool.get(rec.machine);
      try {
        const m = Math.max(1, Math.min(500, Math.floor(maxMatches ?? 50)));
        const c = Math.max(0, Math.min(50, Math.floor(contextLines ?? 2)));

        const grep = (file: string) =>
          wrapRemoteShell(
            `command -v grep >/dev/null 2>&1 && grep -n -E -m ${m} -C ${c} -e ${quoteForSh(
              pattern
            )} \"${toHomeAbs(file)}\" 2>/dev/null || true`
          );

        const outStdout = await runCommand(lease.value.ssh.client, grep(rec.stdoutPath), {
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 4 * 1024,
        });
        const outStderr = await runCommand(lease.value.ssh.client, grep(rec.stderrPath), {
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 4 * 1024,
        });

        return respond({
          ok: true,
          tool: "grep-result",
          data: {
            session_id,
            machine: rec.machine,
            pattern,
            maxMatches: m,
            contextLines: c,
            matches: {
              stdout: outStdout.stdout,
              stderr: outStderr.stdout,
            },
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("write-stdin"),
    {
      title: "Write to Async stdin",
      description:
        "Write data to a running async session stdin. Works for exec-async sessions (remote screen).",
      inputSchema: z.object({
        session_id: z.string().min(1),
        data: z.string(),
        append_newline: z.boolean().optional(),
      }),
    },
    async ({ session_id, data, append_newline }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) {
        return respond({ ok: false, tool: "write-stdin", error: "session not found" });
      }

      if ("kind" in rec && rec.kind === "transfer") {
        return respond({
          ok: false,
          tool: "write-stdin",
          error: "write-stdin is not supported for transfer sessions",
        });
      }

      if ("kind" in rec && rec.kind === "local") {
        return respond({
          ok: false,
          tool: "write-stdin",
          error: "write-stdin is not supported for local sessions in SSH mode",
        });
      }

      const stdinPath = rec.stdinPath;
      const stdinLogPath = rec.stdinLogPath;
      if (!stdinPath || !stdinLogPath) {
        return respond({
          ok: false,
          tool: "write-stdin",
          error:
            "stdin is not available for this session (created by older OctSSH version?). Start a new exec-async session.",
        });
      }

      const expectedRemoteDir = `.octssh/runs/${rec.session_id}`;
      if (rec.remoteDir !== expectedRemoteDir) {
        return respond({ ok: false, tool: "write-stdin", error: "invalid session remoteDir" });
      }
      if (stdinPath !== `${rec.remoteDir}/stdin.fifo`) {
        return respond({ ok: false, tool: "write-stdin", error: "invalid stdinPath" });
      }
      if (stdinLogPath !== `${rec.remoteDir}/stdin.log`) {
        return respond({ ok: false, tool: "write-stdin", error: "invalid stdinLogPath" });
      }

      const wantNewline = append_newline ?? true;
      const payload = wantNewline ? `${data}\n` : data;
      const buf = Buffer.from(payload, "utf8");
      if (buf.byteLength > 64 * 1024) {
        return respond({
          ok: false,
          tool: "write-stdin",
          error: "payload too large (max 64KiB per call)",
          data: { bytes: buf.byteLength },
        });
      }

      const lease = await pool.get(rec.machine);
      try {
        const metaCmd = wrapRemoteShell(
          `test -f "${toHomeAbs(rec.metaPath)}" && cat "${toHomeAbs(rec.metaPath)}" || true`
        );
        const metaRes = await runCommand(lease.value.ssh.client, metaCmd, {
          maxStdoutBytes: 16 * 1024,
          maxStderrBytes: 4 * 1024,
        });
        let meta: any = null;
        try {
          meta = JSON.parse(metaRes.stdout || "null");
        } catch {
          meta = null;
        }
        if (meta && typeof meta.status === "string" && meta.status === "done") {
          const exitCode = typeof meta.exitCode === "number" ? meta.exitCode : undefined;
          saveSession(
            {
              ...rec,
              status: exitCode === 0 ? "done" : "failed",
              exitCode,
              updatedAt: isoNow(),
            },
            getOctsshDir()
          );
        }

        const latest = loadSession(session_id, getOctsshDir());
        if (!latest || latest.status !== "running") {
          const latestExitCode =
            latest && "exitCode" in latest && typeof latest.exitCode === "number"
              ? latest.exitCode
              : null;
          return respond({
            ok: false,
            tool: "write-stdin",
            error: "session is not running",
            data: { status: latest?.status ?? null, exitCode: latestExitCode },
          });
        }

        const b64 = buf.toString("base64");
        const runDir = rec.remoteDir;

        const cmd = wrapRemoteShell(
          [
            `command -v base64 >/dev/null 2>&1 || { echo "base64 not found" >&2; exit 1; }`,
            `run=\"$HOME/${runDir}\"`,
            `chunk=\"$run/stdin.chunk.$$\"`,
            `stdin=\"${toHomeAbs(stdinPath)}\"`,
            `stdinlog=\"${toHomeAbs(stdinLogPath)}\"`,
            `test -p \"$stdin\" || { echo "stdin is not a fifo" >&2; exit 1; }`,
            `test ! -L \"$stdin\" || { echo "stdin is a symlink" >&2; exit 1; }`,
            `test ! -L \"$stdinlog\" || { echo "stdin log is a symlink" >&2; exit 1; }`,
            `printf %s ${quoteForSh(b64)} | base64 -d > \"$chunk\"`,
            `cat \"$chunk\" >> \"$stdinlog\" 2>/dev/null || true`,
            `(cat \"$chunk\" > \"$stdin\") & wpid=$!`,
            `i=0; while kill -0 \"$wpid\" 2>/dev/null; do i=$((i+1)); if [ \"$i\" -ge 20 ]; then kill \"$wpid\" 2>/dev/null || true; rm -f \"$chunk\"; echo \"stdin write blocked\" >&2; exit 1; fi; sleep 0.1; done`,
            `wait \"$wpid\" 2>/dev/null || true`,
            `rm -f \"$chunk\"`,
          ].join("; ")
        );

        const res = await runCommand(lease.value.ssh.client, cmd, {
          maxStdoutBytes: 8 * 1024,
          maxStderrBytes: 8 * 1024,
        });

        if (res.exitCode !== 0) {
          return respond({
            ok: false,
            tool: "write-stdin",
            error: res.stderr || "failed to write stdin",
            data: { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr },
          });
        }

        return respond({
          ok: true,
          tool: "write-stdin",
          data: {
            session_id,
            machine: rec.machine,
            bytes: buf.byteLength,
            append_newline: wantNewline,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("cancel"),
    {
      title: "Cancel Async Session",
      description:
        "Terminate a running async session by session_id (signal is optional).",
      inputSchema: z.object({
        session_id: z.string().min(1),
        signal: z.string().optional(),
      }),
    },
    async ({ session_id, signal }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) {
        return respond({ ok: false, tool: "cancel", error: "session not found" });
      }

      if ((rec as any).kind === "transfer") {
        const ok = cancelTransfer(session_id);
        // Even if we can't abort (process restart), mark as cancelled per policy.
        saveSession(
          {
            ...(rec as any),
            status: "cancelled",
            updatedAt: isoNow(),
            error: ok ? "cancelled" : "cancel requested (no runtime found)"
          },
          getOctsshDir()
        );
        return respond({
          ok: true,
          tool: "cancel",
          data: {
            session_id,
            kind: "transfer",
            status: "cancelled",
            note: ok ? "aborted" : "no runtime found (server restart?)",
          },
        });
      }

      if (rec.status !== "running") {
        return respond({
          ok: true,
          tool: "cancel",
          data: {
            session_id,
            machine: rec.machine,
            status: rec.status,
            note: "session is not running",
          },
        });
      }

      const lease = await pool.get(rec.machine);
      try {
        const sig = (signal ?? "TERM").toUpperCase();
        const safeSig = /^[A-Z0-9]+$/.test(sig) ? sig : "TERM";

        const parts: string[] = [];
        if (rec.cmdPid) {
          parts.push(`kill -s ${safeSig} ${rec.cmdPid} 2>/dev/null || true`);
        }
        parts.push(
          `screen -S ${quoteForSh(rec.screenName)} -X quit 2>/dev/null || true`
        );

        await runCommand(lease.value.ssh.client, wrapRemoteShell(parts.join("; ")), {
          maxStdoutBytes: 8 * 1024,
          maxStderrBytes: 8 * 1024,
        });

        saveSession(
          {
            ...rec,
            status: "cancelled",
            updatedAt: isoNow(),
          },
          getOctsshDir()
        );

        return respond({
          ok: true,
          tool: "cancel",
          data: {
            session_id,
            machine: rec.machine,
            status: "cancelled",
            signal: safeSig,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    toolName("sleep"),
    {
      title: "Sleep",
      description: "Sleep for a duration (ms).",
      inputSchema: z.object({
        time: z.number().int().min(0).max(60_000),
      }),
    },
    async ({ time }) => {
      await new Promise((r) => setTimeout(r, time));
      return respond({ ok: true, tool: "sleep", data: { sleptMs: time } });
    }
  );

  return server;
}
