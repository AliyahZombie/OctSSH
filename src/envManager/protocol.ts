import { getDefaultSshConfigPath } from "../ssh/config/paths.js";
import { DEFAULT_CONFIG } from "../state/config.js";
import { getDefaultOctsshDir } from "../state/paths.js";

const PROTOCOL_VERSION = "1.0" as const;
export const ENV_MANAGER_PROTOCOL_FLAG = "--env-manager-protocol";

type EnvVarType = "secret" | "string" | "number" | "boolean" | "enum" | "path";

type EnvVarDefault = string | number | boolean | null;

export type EnvVarDefinition = {
  name: string;
  type: EnvVarType;
  /**
   * Static built-in default for the env var. This intentionally does not read
   * process.env or config.json, so env managers do not mistake current values
   * for defaults.
   */
  default: EnvVarDefault;
};

export type EnvManagerProtocolDoc = {
  version: typeof PROTOCOL_VERSION;
  program: "octssh";
  env_vars: EnvVarDefinition[];
};

function commonEnvVars(): EnvVarDefinition[] {
  return [{ name: "OCTSSH_HOME", type: "path", default: getDefaultOctsshDir() }];
}

function clientEnvVars(): EnvVarDefinition[] {
  return [
    ...commonEnvVars(),
    { name: "OCTSSH_SSH_CONFIG", type: "path", default: getDefaultSshConfigPath() },
    { name: "OCTSSH_TOOL_PREFIX", type: "string", default: "" },
    { name: "OCTSSH_REMOTE_SHELL", type: "string", default: "sh" },
  ];
}

function initEnvVars(): EnvVarDefinition[] {
  return [
    ...commonEnvVars(),
    { name: "OCTSSH_SSH_CONFIG", type: "path", default: getDefaultSshConfigPath() },
    { name: "OCTSSH_REMOTE_SHELL", type: "string", default: "sh" },
  ];
}

function serveEnvVars(): EnvVarDefinition[] {
  return [
    ...commonEnvVars(),
    { name: "OCTSSH_TOOL_PREFIX", type: "string", default: "" },
    { name: "OCTSSH_SHELL", type: "enum", default: "" },
    { name: "OCTSSH_SERVE_HOST", type: "string", default: DEFAULT_CONFIG.httpServer.host },
    { name: "OCTSSH_SERVE_PORT", type: "number", default: DEFAULT_CONFIG.httpServer.port },
    { name: "OCTSSH_SERVE_KEY", type: "secret", default: "" },
    { name: "OCTSSH_SERVE_DEBUG", type: "boolean", default: false },
    { name: "OCTSSH_DEBUG", type: "boolean", default: false },
  ];
}

function detectSubcommand(args: string[]) {
  for (const arg of args) {
    if (arg === ENV_MANAGER_PROTOCOL_FLAG) continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function hasEnvManagerProtocolFlag(args: string[]) {
  return args.includes(ENV_MANAGER_PROTOCOL_FLAG);
}

export function getEnvManagerProtocolDoc(args: string[]): EnvManagerProtocolDoc {
  const subcommand = detectSubcommand(args);
  const env_vars =
    subcommand === "serve"
      ? serveEnvVars()
      : subcommand === "init"
        ? initEnvVars()
        : clientEnvVars();

  return {
    version: PROTOCOL_VERSION,
    program: "octssh",
    env_vars,
  };
}
