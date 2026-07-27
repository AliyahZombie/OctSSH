import type { Client } from "ssh2";
import { runCommand } from "../ssh/runCommand.js";
import { wrapRemoteShell } from "../ssh/shell.js";

export type ExtendedInfo = {
  os?: string;
  arch?: string;
  cpu?: string;
  cores?: number;
  mem?: string;
  disk?: string;
};

function firstLine(s: string) {
  return s.trim().split(/\r?\n/)[0] ?? "";
}

export async function collectExtendedInfo(client: Client): Promise<ExtendedInfo> {
  const info: ExtendedInfo = {};

  // OS
  const osr = await runCommand(
    client,
    wrapRemoteShell("(test -f /etc/os-release && . /etc/os-release && echo \"$PRETTY_NAME\") || uname -s"),
    { maxStdoutBytes: 4096, maxStderrBytes: 4096 }
  );
  const osName = firstLine(osr.stdout);
  if (osName) info.os = osName;

  // Arch
  const ar = await runCommand(client, wrapRemoteShell("uname -m"), {
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
  const arch = firstLine(ar.stdout);
  if (arch) info.arch = arch;

  // CPU model + cores
  const lscpu = await runCommand(
    client,
    wrapRemoteShell("(command -v lscpu >/dev/null 2>&1 && lscpu) || (test -f /proc/cpuinfo && cat /proc/cpuinfo) || true"),
    { maxStdoutBytes: 64 * 1024, maxStderrBytes: 4096 }
  );
  const modelLine = lscpu.stdout
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().includes("model name"));
  if (modelLine) {
    info.cpu = modelLine.split(":").slice(1).join(":").trim();
  }
  const cores = await runCommand(
    client,
    wrapRemoteShell("(command -v nproc >/dev/null 2>&1 && nproc) || (getconf _NPROCESSORS_ONLN 2>/dev/null) || true"),
    { maxStdoutBytes: 128, maxStderrBytes: 128 }
  );
  const coresN = Number(firstLine(cores.stdout));
  if (Number.isFinite(coresN) && coresN > 0) info.cores = coresN;

  // Memory
  const mem = await runCommand(
    client,
    wrapRemoteShell("(command -v free >/dev/null 2>&1 && free -h) || (test -f /proc/meminfo && head -n 5 /proc/meminfo) || true"),
    { maxStdoutBytes: 4096, maxStderrBytes: 1024 }
  );
  const memLine = firstLine(mem.stdout);
  if (memLine) info.mem = memLine;

  // Disk
  const disk = await runCommand(client, wrapRemoteShell("df -h / | tail -n 1"), {
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
  const diskLine = firstLine(disk.stdout);
  if (diskLine) info.disk = diskLine;

  return info;
}
