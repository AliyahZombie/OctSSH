# OctSSH

[中文 README](README.zh.md)

[![XEnvManager V1.0](https://img.shields.io/badge/XEnvManager-V1.0-blue)](https://github.com/AliyahZombie/XEnvMananger)

<p align="center">This project supports the XEnvManager protocol.</p>

I was just VibeCoding and suddenly thought: **Why can't I just let my agent deploy code to the server for me?**

So, I built **OctSSH**.

<img src="logo.png" width="200" />

**OctSSH** is an MCP server that gives LLMs **safe, controllable, and stateful** access to shell environments.

### Note
**By default (stdio mode), OctSSH only connects to machines already configured in your local `ssh_config` for passwordless login.**

---

> [!TIP]
> **So... what makes OctSSH special?**

## Async Support

OctSSH provides a complete set of async tools to prevent LLMs from timing out on long-running tasks:

| Tool | Description |
|:---|:---|
| `exec(machine, command, confirm_code?)` | Run short commands synchronously |
| `sudo-exec(machine, command, confirm_code?)` | Run synchronously as root (`sudo -n`) |
| `exec-async(machine, command, confirm_code?)` | Run long tasks in background (screen) |
| `exec-async-sudo(...)` | Run background tasks as root |
| `write-stdin(session_id, data, append_newline?)` | Write to stdin of a running async task |
| `get-result(session_id, lines?)` | Inspect async task output |
| `grep-result(session_id, pattern, ...)` | Search task logs |
| `cancel(session_id)` | Terminate a task |
| `sleep(time)` | Pause (useful for polling) |

> **Note**: In **HTTP Serve mode**, these tools operate directly on the *local* machine, and the `machine` parameter is omitted.

## Security Design

OctSSH features a **Virtual Mode** and **Confirm Code** verification flow:

### 🔒 Safety Mechanism: Virtual Mode

We don't want AI to become a world-ending terminator, so we designed Virtual Mode.
When the AI attempts the following, OctSSH **will not execute immediately**, but instead returns a `confirm_code`:

- 📁 **File Overwrite**: Uploading to a path that already exists.
- 💀 **High-Risk Commands**: `rm -rf` and similar "delete everything" commands.
- 🔍 **Regex Blocklist**: Custom sensitive patterns defined in config.

**Execution Flow Example**:
1. AI calls `exec("web", "rm -rf /var/www/html")`
2. 🛑 OctSSH intercepts: Recursive delete detected -> Returns `confirm_code: a1b2c3` + file impact preview.
3. 👤 User reviews and tells AI: "Confirm execution".
4. ✅ AI calls `exec("web", "rm -rf /var/www/html", "a1b2c3")` -> Actually executes.

## Quick Start

### Installation

```bash
npm install -g @aliyahzombie/octssh
octssh init
```

### Usage Modes

#### 1. Default Client Mode (stdio)
Runs locally and controls remote machines via SSH (reads `~/.ssh/config`):
```bash
octssh
```

##### Remote command shell

Remote commands use `sh -lc` by default. Set `OCTSSH_REMOTE_SHELL` on the
OctSSH process to use another remote shell for synchronous, sudo, and async
commands:

```bash
export OCTSSH_REMOTE_SHELL=bash
octssh
```

The value may be an executable name or path, such as `bash`, `/bin/bash`, or
`zsh`. The selected shell must exist on every target machine and support the
`-lc` options. This setting only affects SSH client mode; HTTP Serve mode uses
`OCTSSH_SHELL` instead.

#### 2. Streamable HTTP Server Mode (Local Control)
Install this **on the target server**. It exposes the server to LLMs via a secure HTTP interface.
In this mode, OctSSH controls the **local machine** directly (no outbound SSH).

```bash
octssh serve
```
- **Default Listen**: `127.0.0.1:8787` (Override via `OCTSSH_SERVE_HOST` / `OCTSSH_SERVE_PORT`)
- **Auth**: Prints a random key on startup. Clients must send header `X-OctSSH-Key: <key>`.
  - Set fixed key: `export OCTSSH_SERVE_KEY="my-secret"`
- **Tool Changes**: Tools run on *this* machine. **`machine` parameter is omitted**. SSH transfer tools (`upload`/`download`) are disabled.

#### Windows notes (serve mode)

On Windows, OctSSH serve will auto-select a local shell in this order:

1) `sh` (if available, e.g. Git-Bash/MSYS)
2) `pwsh`
3) `powershell`
4) `cmd`

Override with:

```bash
set OCTSSH_SHELL=powershell
```

### Tool Prefix (optional)

To avoid tool name collisions when you run multiple OctSSH instances, you can prefix all exposed tools:

```bash
export OCTSSH_TOOL_PREFIX="us1_"
```

Example: `list` becomes `us1_list`.

### write-stdin (async interactive input)

`write-stdin` lets you send input to a running `exec-async` session.

Typical flow:
1) Start a long-running command that reads stdin (via `exec-async`)
2) Send data with `write-stdin(session_id, data)`
3) Poll output with `get-result(session_id)`

Notes:
- Default `append_newline` is `true`.
- Max payload is **64KiB per call**.
- This is a streaming stdin: **EOF is not sent**. If the program exits on EOF, cancel the session instead.
- If you set `OCTSSH_TOOL_PREFIX`, tool names are prefixed too (e.g. `us1_write-stdin`).

### MCP Client Configuration

#### General (stdio)
Add to your MCP client config:
```json
{
  "mcpServers": {
    "octssh": {
      "command": "octssh",
      "args": [],
      "env": {
        "OCTSSH_REMOTE_SHELL": "bash"
      }
    }
  }
}
```

#### Claude Code CLI
```bash
claude mcp add octssh -- octssh
```

#### OpenCode CLI
```json
{
  "mcp": {
    "octssh": {
      "type": "local",
      "command": "octssh",
      "args": [],
      "enabled": true
    }
  }
}
```
Or:
```bash
opencode mcp add octssh --command octssh
```

> [!CAUTION]
> This project connects to real servers (or executes on the local machine). Please carefully review LLM operations. Using this project means you agree that the developer is not responsible for any accidental damage.
