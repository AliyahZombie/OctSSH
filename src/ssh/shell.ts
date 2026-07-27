export function quoteForSh(value: string) {
  // Wrap value in single quotes and escape embedded single quotes.
  // 'abc' -> 'abc'
  // a'b -> 'a'\''b'
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const DEFAULT_REMOTE_SHELL = "sh";

export function getRemoteShell(env: NodeJS.ProcessEnv = process.env) {
  return env.OCTSSH_REMOTE_SHELL?.trim() || DEFAULT_REMOTE_SHELL;
}

function quoteRemoteShell(value: string) {
  // Preserve the existing `sh -lc` command shape for ordinary executable
  // names and paths while safely handling unexpected environment values.
  return /^[A-Za-z0-9_./+-]+$/.test(value) ? value : quoteForSh(value);
}

export function buildRemoteShellPrefix(
  sudo: boolean,
  remoteShell: string = getRemoteShell()
) {
  const shell = quoteRemoteShell(remoteShell.trim() || DEFAULT_REMOTE_SHELL);
  return sudo ? `sudo -n -- ${shell} -lc` : `${shell} -lc`;
}

export function wrapRemoteShell(command: string, remoteShell: string = getRemoteShell()) {
  return `${buildRemoteShellPrefix(false, remoteShell)} ${quoteForSh(command)}`;
}

export function wrapSudoRemoteShell(command: string, remoteShell: string = getRemoteShell()) {
  return `${buildRemoteShellPrefix(true, remoteShell)} ${quoteForSh(command)}`;
}

// Backward-compatible aliases for consumers importing the previous helpers.
export const wrapSh = wrapRemoteShell;
export const wrapSudoSh = wrapSudoRemoteShell;

export function isSudoPasswordError(stderr: string) {
  const s = stderr.toLowerCase();
  return (
    s.includes("a password is required") ||
    s.includes("password is required") ||
    s.includes("sudo: a password is required")
  );
}
