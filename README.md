# Code Repository MCP Server

通过 MCP (Model Context Protocol) 协议让 ChatGPT 网页端操作本地代码仓库。默认提供文件、搜索、Git 相关工具；高风险的终端命令执行工具默认关闭，需要显式启用。

> 公网暴露本地代码仓库能力风险很高。建议仅在可信网络、短时 ngrok 隧道、明确工作区白名单、必要时配置认证的前提下使用。

## 架构

```text
ChatGPT 网页端 (chatgpt.com)
      |
      | HTTPS / Streamable HTTP Transport
      v
+-------------------------------+
|  ngrok / 其他 HTTPS 隧道       |
|  https://xxx.ngrok-free.dev   |
+-------------------------------+
      |
      | 转发到 localhost:3100
      v
+----------------------------------------------+
|  MCP Server (localhost:3100)                 |
|                                              |
|  默认 Tools (20 个)                          |
|  ├── filesystem  (8)                         |
|  ├── search      (3)                         |
|  └── git         (9)                         |
|                                              |
|  可选高风险 Tools                            |
|  └── terminal    (1, ENABLE_TERMINAL=true)   |
|                                              |
|  安全层                                      |
|  ├── 工作区路径白名单                         |
|  ├── realpath / symlink 越权防护              |
|  ├── 排除目录黑名单                           |
|  ├── 文件读写大小限制                         |
|  ├── 可选 Bearer Token 认证                   |
|  ├── MCP session TTL / 最大会话数             |
|  └── 简易请求限流                             |
+----------------------------------------------+
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并按需修改：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

推荐的基础配置：

```env
# MCP Server 端口
PORT=3100

# 允许访问的工作区目录，逗号分隔，支持多个目录
WORKSPACES=D:\CodeX\chatgpt-local-repo-bridge-mcp,D:\CodeX\mindx-agent

# 排除的目录名，匹配任意层级
EXCLUDED_DIRS=node_modules,.git,dist,build,.next,__pycache__,.venv,.cache,coverage,DS_Store,.qoder

# 允许的跨域来源。CORS 不是鉴权。
ALLOWED_ORIGINS=https://chatgpt.com,https://chat.openai.com

# 可选 Bearer token。若 ChatGPT 连接器未配置对应认证，请先留空。
MCP_AUTH_TOKEN=

# 公网建议 false，避免 / 和 /health 暴露工具清单、会话数等信息。
EXPOSE_PUBLIC_INFO=false

# 终端命令执行默认关闭。公网建议保持 false。
ENABLE_TERMINAL=false

# 若启用 run_command，默认只允许这些命令前缀。
ALLOWED_COMMAND_PREFIXES=npm run build,npm test,git status
ALLOW_ANY_COMMAND=false

# 默认禁止 force push。
ALLOW_GIT_FORCE_PUSH=false

# 文件读写限制
MAX_READ_BYTES=1048576
MAX_WRITE_BYTES=2097152

# MCP 会话与限流
MAX_SESSIONS=25
SESSION_TTL_MS=1800000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
```

### 3. 启动服务

开发模式：

```bash
npm run dev
```

生产模式：

```bash
npm run build
npm start
```

启动后本地健康检查：

```text
http://localhost:3100/health
```

默认返回：

```json
{"status":"ok"}
```

## 使用 ngrok 暴露 HTTPS 地址

ChatGPT 运行在云端，不能直接访问你本机的 `localhost:3100`。需要通过 ngrok、Cloudflare Tunnel 或其他方式把本地服务暴露为公网 HTTPS 地址。

### 1. 启动本地 MCP Server

```bash
npm run dev
```

### 2. 启动 ngrok

```bash
ngrok http 3100
```

ngrok 会输出类似内容：

```text
Forwarding  https://a1b2-203-0-113-1.ngrok-free.dev -> http://localhost:3100
```

复制 `Forwarding` 中的 HTTPS 地址。

### 3. 验证隧道

访问：

```text
https://<你的ngrok地址>/health
```

应返回：

```json
{"status":"ok"}
```

> ngrok 免费版每次重启隧道地址可能变化。地址变化后，需要同步更新 ChatGPT 中的 MCP Server URL。

## 在 ChatGPT 中配置 MCP 应用

1. 打开 ChatGPT 网页端。
2. 进入 Settings。
3. 开启 Developer mode。
4. 创建自定义 MCP App / Connector。
5. MCP Server URL 填写：

```text
https://<你的ngrok地址>/mcp
```

例如：

```text
https://consuela-trisyllabical-meetly.ngrok-free.dev/mcp
```

> 关键点：必须以 `/mcp` 结尾，不要只填写 ngrok 根路径。

### Authentication 设置

如果 `.env` 中保持：

```env
MCP_AUTH_TOKEN=
```

则 ChatGPT 创建连接器时选择 `None` / 无认证。

如果配置了：

```env
MCP_AUTH_TOKEN=your-secret-token
```

则 `/mcp` 会要求请求携带：

```http
Authorization: Bearer your-secret-token
```

只有在 ChatGPT 连接器表单中也配置了对应认证时才应启用该项。否则连接器会因为 401 无法连接。

## 工具列表

默认注册 20 个工具；当 `ENABLE_TERMINAL=true` 时额外注册 1 个高风险终端工具，总计 21 个。

### 文件系统工具 (8 个)

| Tool | 功能 | 关键参数 | 安全属性 |
|------|------|----------|----------|
| `list_directory` | 列出目录内容，递归最多展开 2 层 | `path`, `recursive?` | 只读 |
| `read_file` | 读取文本文件，带行号，默认 500 行 | `path`, `startLine?`, `endLine?` | 只读，受 `MAX_READ_BYTES` 限制 |
| `write_file` | 创建或覆盖文件 | `path`, `content` | 写入，destructive |
| `edit_file` | 局部编辑，支持文本匹配和行号模式 | `path`, `edits[]` | 写入，受 `MAX_WRITE_BYTES` 限制 |
| `delete_file` | 删除文件或目录 | `path`, `recursive?` | destructive，禁止删除工作区根目录 |
| `create_directory` | 创建目录 | `path` | 写入，禁止直接操作工作区根目录 |
| `move_file` | 移动或重命名文件/目录 | `source`, `destination` | destructive，禁止移动工作区根目录 |
| `get_file_info` | 获取文件元信息 | `path` | 只读 |

### 搜索工具 (3 个)

| Tool | 功能 | 关键参数 | 安全属性 |
|------|------|----------|----------|
| `search_files` | glob 文件名搜索 | `pattern`, `basePath?`, `maxResults?` | 只读 |
| `search_content` | 正则内容搜索，优先 ripgrep，失败时 fallback 到 Node.js 搜索 | `regex`, `path?`, `filePattern?`, `maxResults?` | 只读，跳过大文件和排除目录 |
| `get_file_tree` | 输出目录树 | `path`, `maxDepth?`, `showHidden?` | 只读 |

### Git 工具 (9 个)

| Tool | 功能 | 关键参数 | 安全属性 |
|------|------|----------|----------|
| `git_status` | 查看仓库状态 | `repoPath` | 只读 |
| `git_diff` | 查看 diff | `repoPath`, `staged?`, `filePath?` | 只读 |
| `git_log` | 查看提交历史 | `repoPath`, `count?`, `filePath?` | 只读 |
| `git_add` | 暂存文件 | `repoPath`, `files` | 写入 Git index |
| `git_commit` | 创建本地提交 | `repoPath`, `message` | 写入本地 Git 历史 |
| `git_branch` | 列出、创建、切换、删除分支 | `repoPath`, `action`, `branchName?` | 包含 destructive 动作 |
| `git_show` | 查看 commit / ref 详情 | `repoPath`, `commitHash` | 只读 |
| `git_push` | 推送到远程 | `repoPath`, `remote?`, `branch?`, `force?` | destructive，默认拒绝 force push |
| `git_pull` | 拉取远程变更 | `repoPath`, `remote?`, `branch?`, `rebase?` | destructive，会修改工作区 |

### 终端工具 (默认关闭)

| Tool | 功能 | 关键参数 | 安全属性 |
|------|------|----------|----------|
| `run_command` | 执行 shell 命令 | `command`, `cwd`, `timeout?`, `env?` | 高风险，open world + destructive |

启用方式：

```env
ENABLE_TERMINAL=true
ALLOWED_COMMAND_PREFIXES=npm run build,npm test,git status
ALLOW_ANY_COMMAND=false
```

默认只允许 `ALLOWED_COMMAND_PREFIXES` 中配置的命令前缀。只有设置 `ALLOW_ANY_COMMAND=true` 才允许任意命令。

> 不建议在公网 ngrok 环境中设置 `ALLOW_ANY_COMMAND=true`。

## 安全机制

### 工作区白名单

所有文件、搜索、Git、命令执行的工作目录都必须位于 `WORKSPACES` 配置的目录内。

```text
路径 "C:\Users\admin\.ssh" 不在允许的工作区目录内。
允许的工作区: D:\CodeX\chatgpt-local-repo-bridge-mcp, D:\CodeX\mindx-agent
```

### realpath / symlink 防护

路径校验使用 `realpath`，用于防止工作区内的符号链接指向工作区外部目录，从而绕过白名单。

### 排除目录

`EXCLUDED_DIRS` 中的目录名在任意层级都会被拦截或跳过：

- 直接访问：`read_file("/path/node_modules/xxx")` 会报错
- 目录遍历：`list_directory` / `get_file_tree` 会跳过
- 搜索：`search_content` / `search_files` 会忽略

建议始终排除：

```text
node_modules,.git,dist,build,.next,__pycache__,.venv,.cache,coverage,.qoder
```

### 禁止直接操作工作区根目录

以下工具会拒绝直接作用于 `WORKSPACES` 根目录：

- `write_file`
- `edit_file`
- `delete_file`
- `create_directory`
- `move_file`

主要用于避免误删或覆盖整个项目目录。

### 文件大小限制

```env
MAX_READ_BYTES=1048576
MAX_WRITE_BYTES=2097152
```

`read_file` / `edit_file` 会拒绝读取超出 `MAX_READ_BYTES` 的文件。`write_file` / `edit_file` 会拒绝写入超出 `MAX_WRITE_BYTES` 的内容。

### 可选认证

`MCP_AUTH_TOKEN` 为空时，`/mcp` 不做 Bearer Token 校验。

`MCP_AUTH_TOKEN` 非空时，`/mcp` 要求：

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

CORS 不是鉴权，不能阻止 curl、脚本或其他服务端请求直接访问公网 MCP 地址。公网暴露时建议配置认证或只短时间开启 ngrok。

### Session TTL 与限流

```env
MAX_SESSIONS=25
SESSION_TTL_MS=1800000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
```

这些配置用于限制 active MCP sessions 数量、清理空闲 session，并对 `/mcp` 做简单请求限流。

### 公共信息暴露

默认：

```env
EXPOSE_PUBLIC_INFO=false
```

此时：

- `/health` 只返回 `{"status":"ok"}`
- `/` 只返回最小服务信息

若设置为 `true`，会公开工具清单、认证是否启用、终端工具是否启用、active sessions 等调试信息。

## 项目结构

```text
src/
├── index.ts                    # 入口：启动 HTTP 服务
├── server.ts                   # MCP Server 创建与 Tool 注册
├── transport.ts                # Streamable HTTP 传输层、鉴权、限流、session 管理
├── config.ts                   # 配置管理 (.env 加载)
├── tools/
│   ├── filesystem.ts           # 文件系统工具 (8)
│   ├── search.ts               # 搜索工具 (3)，支持 ripgrep + Node fallback
│   ├── git.ts                  # Git 工具 (9)
│   └── terminal.ts             # 终端工具 (1，默认不注册)
└── utils/
    ├── logger.ts               # 日志工具
    ├── path-guard.ts           # 路径安全校验、realpath、目录排除
    └── tool-annotations.ts     # MCP tool annotations 统一定义
```

## API 端点

| 端点 | 方法 | 说明 | 是否受 `MCP_AUTH_TOKEN` 保护 |
|------|------|------|------------------------------|
| `/mcp` | POST | MCP 初始化和工具调用 | 是 |
| `/mcp` | GET | SSE 流 / 服务端通知 | 是 |
| `/mcp` | DELETE | 终止 MCP session | 是 |
| `/health` | GET | 健康检查 | 否 |
| `/` | GET | 服务信息 | 否 |

## 典型工作流

默认安全模式下，ChatGPT 可以完成读取、编辑、搜索和 Git 操作，但不会执行 shell 命令：

```text
用户: 帮我检查这个项目的 TypeScript 入口和路由结构

ChatGPT 可能调用:
1. get_file_tree(".")
2. search_content("createApp|express|router", path=".", filePattern="src/**/*.ts")
3. read_file("src/index.ts")
4. read_file("src/transport.ts")
5. git_diff(repoPath=".")
```

启用 `ENABLE_TERMINAL=true` 后，可允许有限命令：

```text
ALLOWED_COMMAND_PREFIXES=npm run build,npm test,git status
```

此时 ChatGPT 可调用：

```text
run_command("npm run build", cwd=".")
run_command("npm test", cwd=".")
```

## 常见问题排查

| 问题 | 常见原因 | 处理方式 |
|------|----------|----------|
| 创建连接器时报 `Something went wrong` | URL 不是 `/mcp`、ngrok 未运行、tool schema/annotations 不合法、认证不匹配 | 确认 URL 为 `https://<ngrok>/mcp`，重启服务，查看本地日志和 ngrok 请求日志 |
| `/health` 能访问，但 ChatGPT 连接失败 | `/mcp` 被认证拦截或 MCP 初始化失败 | 若 ChatGPT 未配置认证，先保持 `MCP_AUTH_TOKEN=` 为空 |
| 工具数量从 21 变成 20 | `ENABLE_TERMINAL=false` | 这是默认安全行为；需要终端工具时显式开启 |
| `run_command` 不存在 | 终端工具默认未注册 | 设置 `ENABLE_TERMINAL=true` 并重启服务 |
| `run_command` 被拒绝 | 命令前缀不在 `ALLOWED_COMMAND_PREFIXES` 中 | 添加允许前缀，或仅在可信环境设置 `ALLOW_ANY_COMMAND=true` |
| 路径不在工作区 | `WORKSPACES` 未包含目标目录，或 symlink 指向外部 | 修改 `WORKSPACES` 后重启服务，避免依赖外部 symlink |
| 读取文件被拒绝 | 文件超过 `MAX_READ_BYTES` 或不是普通文件 | 调整限制或改为读取更小文件 |
| `git_push --force` 被拒绝 | 默认禁止 force push | 需要时设置 `ALLOW_GIT_FORCE_PUSH=true`，谨慎使用 |
| 搜索速度慢 | 未安装 ripgrep，使用 Node fallback | 安装 ripgrep |

## ripgrep 可选优化

安装 ripgrep 可以显著提升大仓库搜索性能。未安装时，`search_content` 会自动降级到 Node.js 内置搜索。

macOS：

```bash
brew install ripgrep
```

Ubuntu / Debian：

```bash
sudo apt install ripgrep
```

Windows：

```powershell
winget install BurntSushi.ripgrep.MSVC
```

## 安全建议

- 不要长期公开 ngrok 地址。
- 不要把 `WORKSPACES` 指到用户主目录、磁盘根目录或包含密钥的目录。
- 不要在公网环境启用 `ALLOW_ANY_COMMAND=true`。
- 不要在公网环境启用 `EXPOSE_PUBLIC_INFO=true`。
- 如果启用 `MCP_AUTH_TOKEN`，不要把 token 提交到 Git。
- `.env` 已被 `.gitignore` 忽略，请继续保持。
- Git push / pull / branch delete 属于高风险操作，使用前先查看 `git_status` 和 `git_diff`。

## 技术栈

| 维度 | 选择 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js >= 18 |
| MCP SDK | `@modelcontextprotocol/sdk` |
| 传输协议 | Streamable HTTP |
| Web 框架 | Express |
| Git 操作 | simple-git |
| 搜索加速 | ripgrep 可选 |
| Schema | Zod v4 |

## License

ISC
