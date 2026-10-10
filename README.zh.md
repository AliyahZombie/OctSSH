# OctSSH

[English README](README.md)

[![XEnvManager V1.0](https://img.shields.io/badge/XEnvManager-V1.0-blue)](https://github.com/AliyahZombie/XEnvMananger)

<p align="center">本项目支持 XEnvManager 协议</p>

VibeCoding 的时候，我突然想到，能不能让 agent 帮我上服务器部署代码呢，于是，我开发了

<img src="logo.png" width="200" />

**OctSSH** 是一个 MCP 服务，允许 LLM **安全、可控**地访问您的服务器 shell 环境。

### 注意
**默认模式（stdio）下，OctSSH 只支持连接到您本机 `ssh_config` 中配置好的免密登录的机器。**

---

> [!TIP]
> **那么... OctSSH 有什么特别之处呢？**

## 异步支持

OctSSH 提供了一套完整的异步任务工具，防止 LLM 等待长任务超时：

| 工具 | 说明 |
|:---|:---|
| `exec(machine, command, confirm_code?)` | 同步执行短命令 |
| `sudo-exec(machine, command, confirm_code?)` | 以 root 身份同步执行 (sudo -n) |
| `exec-async(machine, command, confirm_code?)` | 后台运行长任务 (screen) |
| `exec-async-sudo(...)` | 以 root 身份后台运行 |
| `write-stdin(session_id, data, append_newline?)` | 向运行中的异步任务写入 stdin |
| `get-result(session_id, lines?)` | 查看异步任务输出 |
| `grep-result(session_id, pattern, ...)` | 搜索任务日志 |
| `cancel(session_id)` | 终止任务 |
| `sleep(time)` | 暂停（轮询场景适用） |

> **注意**：在 **HTTP Serve 模式**下，上述工具直接作用于本机，不需要 `machine` 参数。

## 安全设计

OctSSH 设计了一套 **Virtual Mode** 操作模式和 **Confirm Code** 安全验证，工作流程如下：

### 🔒 安全机制：Virtual Mode

我们不希望 AI 变成毁灭世界的终结者，所以设计了 Virtual Mode。
当 AI 尝试以下操作时，OctSSH **不会直接执行**，而是返回 `confirm_code` 确认码：

- 📁 **文件覆盖**：上传的目标路径已存在同名文件
- 💀 **高危指令**：`rm -rf` 等“删库跑路”级命令
- 🔍 **正则拦截**：配置中自定义的敏感模式

**执行流程示例**：
1. AI 调用 `exec("web", "rm -rf /var/www/html")`
2. 🛑 OctSSH 拦截：该操作将递归删除目录 -> 返回 `confirm_code: a1b2c3` + 受影响文件预览
3. 👤 用户检查后告诉 AI："确认执行"
4. ✅ AI 调用 `exec("web", "rm -rf /var/www/html", "a1b2c3")` -> 真正执行

## 快速开始

### 安装

```bash
npm install -g @aliyahzombie/octssh
octssh init
```

### 启动模式

#### 1. 默认 Client 模式 (stdio)
在本地运行，通过 SSH 控制远程机器（读取 `~/.ssh/config`）：
```bash
octssh
```

##### 远端命令 Shell

远端命令默认通过 `sh -lc` 运行。可以在 OctSSH 进程上设置
`OCTSSH_REMOTE_SHELL`，让同步、sudo 和异步命令使用其他远端 shell：

```bash
export OCTSSH_REMOTE_SHELL=bash
octssh
```

变量值可以是可执行文件名或路径，例如 `bash`、`/bin/bash` 或 `zsh`。
所选 shell 必须存在于每台目标机器上，并支持 `-lc` 参数。此配置只影响
SSH Client 模式；HTTP Serve 模式仍使用 `OCTSSH_SHELL`。

#### 2. Streamable HTTP Server 模式 (本机控制)
安装在**目标机器**上，通过 HTTP 接口控制该机器本身（无需 SSH 中转，适合反向代理或远程直连）。
在此模式下，OctSSH 仅控制**本机**。

```bash
octssh serve
```
- **默认监听**：`127.0.0.1:8787` (可通过 `OCTSSH_SERVE_HOST` / `OCTSSH_SERVE_PORT` 覆盖)
- **认证**：启动时会打印随机生成的 Key；客户端需带 Header `X-OctSSH-Key: <key>`
  - 固定 Key 配置：`export OCTSSH_SERVE_KEY="my-secret"`
- **工具变化**：此模式下工具直接操作本机，**不接受 `machine` 参数**，且不暴露 SSH 传输工具（`upload`/`download`）。

#### Windows 说明（serve 模式）

在 Windows 上，OctSSH serve 会自动选择本地 shell，优先级如下：

1) `sh`（如果存在，例如 Git-Bash/MSYS）
2) `pwsh`
3) `powershell`
4) `cmd`

可通过环境变量强制指定：

```bat
set OCTSSH_SHELL=powershell
```

### 工具前缀（可选）

如果你需要同时运行多个 OctSSH 实例（避免工具名冲突），可以给所有暴露的工具增加前缀：

```bash
export OCTSSH_TOOL_PREFIX="us1_"
```

示例：`list` 会变成 `us1_list`。

### write-stdin（异步任务交互输入）

`write-stdin` 用于向正在运行的 `exec-async` 会话写入 stdin（给长任务/交互式脚本喂输入）。

典型流程：
1) 用 `exec-async` 启动一个会读取 stdin 的长任务
2) 用 `write-stdin(session_id, data)` 发送输入
3) 用 `get-result(session_id)` 轮询输出

注意：
- `append_newline` 默认是 `true`。
- 单次写入最大 **64KiB**。
- 这里的 stdin 是持续的流：**不会发送 EOF**。如果你的程序需要 EOF 才会退出，请用 `cancel` 结束会话。
- 如果设置了 `OCTSSH_TOOL_PREFIX`，工具名也会带前缀（例如 `us1_write-stdin`）。

### 接入 MCP 客户端

#### 通用配置 (stdio)
向你的 MCP 客户端配置文件添加：
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
或者：
```bash
opencode mcp add octssh --command octssh
```

> [!CAUTION]
> 本项目会连接到您的真实服务器（或在本机执行命令），请您务必仔细审查 LLM 的操作。使用该项目则代表您同意开发者不对任何可能的误操作负责。
