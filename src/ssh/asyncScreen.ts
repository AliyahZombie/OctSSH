import crypto from "node:crypto";
import type { Client } from "ssh2";
import { runCommand } from "./runCommand.js";
import { buildRemoteShellPrefix, quoteForSh, wrapRemoteShell } from "./shell.js";
import { saveSession } from "../state/sessions.js";
import { getOctsshDir } from "../state/paths.js";

export type StartAsyncParams = {
  machine: string;
  command: string;
  sudo: boolean;
};

export type StartedAsync = {
  session_id: string;
  screenName: string;
  cmdPid?: number;
  remoteDir: string;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
  stdinPath: string;
  stdinLogPath: string;
};

function nowIso() {
  return new Date().toISOString();
}

function buildWrapperFile(params: { sessionId: string; sudo: boolean }) {
  // Write a real script file to avoid multi-level quote escaping.
  // The wrapper expects the user command in $1.
  const runDir = `$HOME/.octssh/runs/${params.sessionId}`;
  const inner = `${buildRemoteShellPrefix(params.sudo)} "$1"`;

  return [
    '#!/bin/sh',
    'set -u',
    `run="${runDir}"`,
    'stdout="$run/stdout.log"',
    'stderr="$run/stderr.log"',
    'meta="$run/meta.json"',
    'pidfile="$run/cmd.pid"',
    'stdin="$run/stdin.fifo"',
    'stdinlog="$run/stdin.log"',
    'ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'printf "{\\"status\\":\\"running\\",\\"startedAt\\":\\"%s\\"}\\n" "$ts" > "$meta"',
    'rm -f "$stdin" 2>/dev/null || true',
    'mkfifo "$stdin"',
    ': > "$stdinlog"',
    'exec 3<> "$stdin"',
    `(${inner}) <&3 >"$stdout" 2>"$stderr" & cmdpid=$!`,
    'echo "$cmdpid" > "$pidfile"',
    'wait "$cmdpid"; code=$?',
    'ts2=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'printf "{\\"status\\":\\"done\\",\\"exitCode\\":%s,\\"endedAt\\":\\"%s\\"}\\n" "$code" "$ts2" > "$meta"',
  ].join('\n');
}

export async function startAsyncInScreen(
  client: Client,
  params: StartAsyncParams
): Promise<StartedAsync> {
  const sessionId = crypto.randomUUID();
  const screenName = `octssh-${sessionId}`;

  // Remote locations are standardized.
  // Store paths relative to $HOME so we can reliably address them remotely.
  const remoteDir = `.octssh/runs/${sessionId}`;
  const stdoutPath = `${remoteDir}/stdout.log`;
  const stderrPath = `${remoteDir}/stderr.log`;
  const metaPath = `${remoteDir}/meta.json`;
  const stdinPath = `${remoteDir}/stdin.fifo`;
  const stdinLogPath = `${remoteDir}/stdin.log`;

  // Preflight: require screen.
  const hasScreen = await runCommand(client, wrapRemoteShell("command -v screen >/dev/null 2>&1"));
  if (hasScreen.exitCode !== 0) {
    throw new Error("Remote prerequisite missing: `screen` is required on the server.");
  }

  const hasMkfifo = await runCommand(client, wrapRemoteShell("command -v mkfifo >/dev/null 2>&1"));
  if (hasMkfifo.exitCode !== 0) {
    throw new Error("Remote prerequisite missing: `mkfifo` is required on the server.");
  }

  const wrapperFile = buildWrapperFile({ sessionId, sudo: params.sudo });

  // Start a detached screen session.
  // After starting, try to read cmd.pid (best-effort).
  const launcher = [
    `run=\"$HOME/.octssh/runs/${sessionId}\"`,
    `mkdir -p \"$run\"`,
    `: > \"$run/stdout.log\"`,
    `: > \"$run/stderr.log\"`,
    `cat > \"$run/wrapper.sh\" <<'OCTSSH_EOF'`,
    wrapperFile,
    'OCTSSH_EOF',
    `chmod +x \"$run/wrapper.sh\"`,
    // Run wrapper in detached screen and pass the user command as $1.
    `screen -dmS ${quoteForSh(screenName)} sh \"$run/wrapper.sh\" ${quoteForSh(params.command)}`,
    `screen -ls | grep -F ${quoteForSh(screenName)} >/dev/null 2>&1 || { echo 'screen session not found' 1>&2; screen -ls 1>&2 || true; exit 1; }`,
    `i=0; while [ $i -lt 5 ]; do if [ -f \"$run/cmd.pid\" ]; then cat \"$run/cmd.pid\"; exit 0; fi; i=$((i+1)); sleep 1; done; echo 'cmd.pid not created' 1>&2; ls -la \"$run\" 1>&2 || true; exit 1`,
  ].join("\n");

  const runLauncher = async (pty: boolean) =>
    runCommand(client, wrapRemoteShell(launcher), {
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      pty,
    });

  // Prefer no-pty to preserve stderr separation. Retry with pty if needed.
  let started = await runLauncher(false);
  if (started.exitCode !== 0) {
    const combined = `${started.stdout}\n${started.stderr}`.toLowerCase();
    if (
      combined.includes('cannot open your terminal') ||
      combined.includes('no tty') ||
      combined.includes('not a terminal')
    ) {
      started = await runLauncher(true);
    }
  }

  if (started.exitCode !== 0) {
    const msg = [
      started.stderr.trim() ? `stderr: ${started.stderr.trim()}` : null,
      started.stdout.trim() ? `stdout: ${started.stdout.trim()}` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    // Best-effort diagnostics to help debug remote environments.
    const diagCmd = [
      `run=\"$HOME/.octssh/runs/${sessionId}\"`,
      `echo '---run-dir---'`,
      `ls -la \"$run\" || true`,
      `echo '---meta---'`,
      `cat \"$run/meta.json\" 2>/dev/null || true`,
      `echo '---stdout---'`,
      `cat \"$run/stdout.log\" 2>/dev/null || true`,
      `echo '---stderr---'`,
      `cat \"$run/stderr.log\" 2>/dev/null || true`,
      `echo '---screen-match---'`,
      `screen -ls | grep -F ${quoteForSh(screenName)} || true`,
      `echo '---screen-ls---'`,
      `screen -ls | head -n 50 || true`,
    ].join('; ');

    let diagOut = '';
    try {
      const diag = await runCommand(client, wrapRemoteShell(diagCmd), {
        maxStdoutBytes: 32 * 1024,
        maxStderrBytes: 8 * 1024,
      });
      diagOut = diag.stdout || diag.stderr ? `\n${diag.stdout}${diag.stderr}` : '';
    } catch {
      // ignore
    }

    throw new Error(
      `Failed to start remote screen session (session_id=${sessionId}, screen=${screenName}, ${msg || 'unknown error'})${diagOut}`
    );
  }

  let cmdPid: number | undefined;
  const pidText = started.stdout.trim();
  if (pidText) {
    const n = Number(pidText);
    if (Number.isFinite(n) && n > 0) cmdPid = n;
  }

  // Persist local session record.
  const now = nowIso();
  saveSession(
    {
      session_id: sessionId,
      machine: params.machine,
      createdAt: now,
      updatedAt: now,
      status: "running",
      screenName,
      cmdPid,
      remoteDir,
      stdoutPath,
      stderrPath,
      metaPath,
      stdinPath,
      stdinLogPath,
    },
    getOctsshDir()
  );

  return {
    session_id: sessionId,
    screenName,
    cmdPid,
    remoteDir,
    stdoutPath,
    stderrPath,
    metaPath,
    stdinPath,
    stdinLogPath,
  };
}
