import type { Client } from "ssh2";
import { runCommand } from "../ssh/runCommand.js";
import { wrapRemoteShell } from "../ssh/shell.js";

const homeCache = new WeakMap<object, string>();

async function getRemoteHome(client: Client) {
  const cached = homeCache.get(client as any);
  if (cached) return cached;

  const res = await runCommand(client, wrapRemoteShell('printf %s "$HOME"'), {
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });
  const home = res.stdout.trim();
  if (!home.startsWith("/")) {
    throw new Error(`Failed to resolve remote $HOME (got: ${home})`);
  }
  homeCache.set(client as any, home);
  return home;
}

export async function resolveRemotePath(client: Client, p: string) {
  const raw = p.trim();
  if (!raw) throw new Error("remotePath is empty");
  if (raw.startsWith("/")) return raw;

  const home = await getRemoteHome(client);
  if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
  if (raw.startsWith("./")) return `${home}/${raw.slice(2)}`;
  return `${home}/${raw}`;
}
