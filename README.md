# Code Repository MCP Server

通过 MCP (Model Context Protocol) 协议让 ChatGPT 网页端操作本地代码仓库。默认提供文件、搜索、Git 相关工具；高风险的终端命令执行工具默认关闭，需要显式启用。

> 公网暴露本地代码仓库能力风险很高。建议仅在可信网络、短时 ngrok 隧道、明确工作区白名单的前提下使用。

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
|  ├── 排除目录和敏感文件                       |
|  ├── 文件读写大小限制                         |
|  ├── Auth0 OAuth Bearer Token 校验             |
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
PORT=3100
WORKSPACES=D:\CodeX\chatgpt-local-repo-bridge-mcp,D:\CodeX\mindx-agent

EXCLUDED_DIRS=node_modules,.git,dist,build,.next,__pycache__,.venv,.cache,coverage,DS_Store,.qoder
EXCLUDED_FILES=.env,.env.local,.env.development,.env.development.local,.env.production,.env.production.local,.env.test,.env.test.local,.env.staging,.env.staging.local,.envrc,.npmrc,.pypirc,*.pem,*.key,*.crt,*.cer,*.p12,*.pfx,id_rsa,id_rsa.*,id_ed25519,id_ed25519.*
ALLOWED_ORIGINS=https://chatgpt.com,https://chat.openai.com

OAUTH_ENABLED=true
PUBLIC_MCP_URL=https://consuela-trisyllabical-meetly.ngrok-free.dev/mcp
OAUTH_ISSUER=https://dev-j62oyjzrqhlzk5b5.us.auth0.com/
OAUTH_AUDIENCE=https://consuela-trisyllabical-meetly.ngrok-free.dev/mcp
OAUTH_SCOPES=repo:read,repo:write,repo:git

EXPOSE_PUBLIC_INFO=false

ENABLE_TERMINAL=false
ALLOWED_COMMANDS=npm run build,npm test,git status
ALLOW_ANY_COMMAND=false
ALLOW_GIT_FORCE_PUSH=false

MAX_READ_BYTES=1048576
MAX_WRITE_BYTES=2097152

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

```bash
npm run dev
ngrok http 3100
```

ngrok 会输出类似内容：

```text
Forwarding  https://a1b2-203-0-113-1.ngrok-free.dev -> http://localhost:3100
```

ChatGPT 中的 MCP Server URL 必须填写：

```text
https://<你的ngrok地址>/mcp
```

例如：

```text
https://consuela-trisyllabical-meetly.ngrok-free.dev/mcp
```

> 关键点：必须以 `/mcp` 结尾，不要只填写 ngrok 根路径。

## Auth0 OAuth 配置

公网暴露本地仓库 MCP 时建议启用 OAuth。当前实现把本服务作为 OAuth Resource Server，Auth0 负责用户登录和 access token 签发，本服务负责验证 JWT 签名、issuer、audience、过期时间和 scope。

### 1. Auth0 创建 API

在 Auth0 Dashboard 中进入 `Applications -> APIs -> Create API`：

```text
Name: chatgpt-local-repo-bridge-mcp
Identifier: https://consuela-trisyllabical-meetly.ngrok-free.dev/mcp
Signing Algorithm: RS256
```

`Identifier` 必须和 `.env` 中的 `OAUTH_AUDIENCE` 一致。

### 2. Auth0 添加 Permissions

在该 API 的 Permissions 中添加：

```text
repo:read
repo:write
repo:git
```

当前服务按工具类型要求 scope：

```text
repo:read   读取文件、目录、搜索、Git 只读操作
repo:write  文件写入、编辑、删除、移动、创建目录
repo:git    git add / commit / push / pull
```

### 3. MCP 服务配置

`.env` 中配置：

```env
OAUTH_ENABLED=true
PUBLIC_MCP_URL=https://consuela-trisyllabical-meetly.ngrok-free.dev/mcp
OAUTH_ISSUER=https://dev-j62oyjzrqhlzk5b5.us.auth0.com/
OAUTH_AUDIENCE=https://consuela-trisyllabical-meetly.ngrok-free.dev/mcp
OAUTH_SCOPES=repo:read,repo:write,repo:git
```

注意：`PUBLIC_MCP_URL`、Auth0 API Identifier、`OAUTH_AUDIENCE` 建议保持完全一致。Auth0 issuer 末尾 `/` 要和 Auth0 discovery 文档中的 `issuer` 保持一致。

### 4. 验证 OAuth 元数据

启动服务后访问：

```bash
curl -i https://consuela-trisyllabical-meetly.ngrok-free.dev/.well-known/oauth-protected-resource
```

未带 token 访问 MCP 应返回 `401`，并包含 `WWW-Authenticate`：

```bash
curl -i https://consuela-trisyllabical-meetly.ngrok-free.dev/mcp
```

## 在 ChatGPT 中配置 MCP 应用

1. 打开 ChatGPT 网页端。
2. 进入 Settings。
3. 开启 Developer mode。
4. 创建自定义 MCP App / Connector。
5. MCP Server URL 填写 `https://<你的ngrok地址>/mcp`。
6. 身份验证选择 OAuth。

## 工具列表

默认注册 20 个工具；当 `ENABLE_TERMINAL=true` 时额外注册 1 个高风险终端工具，总计 21 个。

### 文件系统工具 (8 个)

| Tool | 功能 | 关键参数 | 安全属性 |
|------|------|----------|----------|
| `list_directory` | 列出目录内容，递归最多展开 2 层 | `path`, `recursive?` | 只读，隐藏排除文件 |
| `read_file` | 读取文本文件，带行号，默认 500 行 | `path`, `startLine?`, `endLine?` | 只读，受 `MAX_READ_BYTES` 和 `EXCLUDED_FILES` 限制 |
| `write_file` | 创建或覆盖文件 | `path`, `content` | destructive，受 `MAX_WRITE_BYTES` 和 `EXCLUDED_FILES` 限制 |
| `edit_file` | 局部编辑，支持文本匹配和行号模式 | `path`, `edits[]` | 写入，受大小和敏感文件限制 |
| `delete_file` | 删除文件或目录 | `path`, `recursive?` | destructive，禁止删除工作区根目录 |
| `create_directory` | 创建目录 | `path` | 写入，禁止直接操作工作区根目录 |
| `move_file` | 移动或重命名文件/目录 | `source`, `destination` | destructive，禁止移动工作区根目录 |
| `get_file_info` | 获取文件元信息 | `path` | 只读，受敏感文件限制 |

### 搜索工具 (3 个)

| Tool | 功能 | 关键参数 | 安全属性 |
|------|------|----------|----------|
| `search_files` | glob 文件名搜索 | `pattern`, `basePath?`, `maxResults?` | 只读，忽略排除目录和敏感文件 |
| `search_content` | 正则内容搜索，优先 ripgrep，失败时 fallback 到 Node.js 搜索 | `regex`, `path?`, `filePattern?`, `maxResults?` | 只读，跳过大文件、排除目录和敏感文件 |
| `get_file_tree` | 输出目录树 | `path`, `maxDepth?`, `showHidden?` | 只读，隐藏排除目录和敏感文件 |

### Git 工具 (9 个)

| Tool | 功能 | 关键参数 | 安全属性 |
|------|------|----------|----------|
| `git_status` | 查看仓库状态 | `repoPath` | 只读 |
| `git_diff` | 查看 diff | `repoPath`, `staged?`, `filePath?` | 只读 |
| `git_log` | 查看提交历史 | `repoPath`, `count?`, `filePath?` | 只读 |
| `git_add` | 暂存文件 | `repoPath`, `files` | 写入 Git index |
| `git_commit` | 创建本地提交 | `repoPath`, `message` | 写入本地 Git 历史 |
| `git_branch` | 列出、创建、切换、删除分支 | `repoPath`, `action`, `branchName?` | 包含 destructive 动作，拒绝异常 ref 字符 |
| `git_show` | 查看 commit / ref 详情 | `repoPath`, `commitHash` | 只读 |
| `git_push` | 推送到远程 | `repoPath`, `remote?`, `branch?`, `force?` | destructive + open world，默认拒绝 force push，拒绝 refspec |
| `git_pull` | 拉取远程变更 | `repoPath`, `remote?`, `branch?`, `rebase?` | destructive + open world，会修改工作区，拒绝 refspec |

### 终端工具 (默认关闭)

| Tool | 功能 | 关键参数 | 安全属性 |
|------|------|----------|----------|
| `run_command` | 执行 shell 命令 | `command`, `cwd`, `timeout?`, `env?` | 高风险，open world + destructive |

启用方式：

```env
ENABLE_TERMINAL=true
ALLOWED_COMMANDS=npm run build,npm test,git status
ALLOW_ANY_COMMAND=false
```

默认只允许 `ALLOWED_COMMANDS` 中配置的完整命令。命令必须完整匹配，不能通过 `&&`、`&`、`;` 追加额外命令。只有设置 `ALLOW_ANY_COMMAND=true` 才允许任意命令。

> 不建议在公网 ngrok 环境中设置 `ALLOW_ANY_COMMAND=true`。

## 安全机制

### 工作区白名单

所有文件、搜索、Git、命令执行的工作目录都必须位于 `WORKSPACES` 配置的目录内。服务启动时会验证所有 workspace 必须存在且必须是目录；配置错误会启动失败。

### realpath / symlink 防护

路径校验使用 `realpath`，用于防止工作区内的符号链接指向工作区外部目录，从而绕过白名单。

### 排除目录和敏感文件

`EXCLUDED_DIRS` 中的目录名在任意层级都会被拦截或跳过。

建议始终排除目录：

```text
node_modules,.git,dist,build,.next,__pycache__,.venv,.cache,coverage,.qoder
```

`EXCLUDED_FILES` 用于拦截敏感文件 basename，默认包括：

```text
.env,.env.local,.env.development,.env.development.local,.env.production,.env.production.local,.env.test,.env.test.local,.env.staging,.env.staging.local,.envrc,.npmrc,.pypirc,*.pem,*.key,*.crt,*.cer,*.p12,*.pfx,id_rsa,id_rsa.*,id_ed25519,id_ed25519.*
```

这些文件不会被读取、搜索或显示在目录树中。

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

### OAuth / Auth0 认证

启用 `OAUTH_ENABLED=true` 后，服务会暴露 OAuth protected resource metadata：

```text
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-protected-resource/mcp
```

所有 `/mcp` 请求都必须携带：

```http
Authorization: Bearer <access_token>
```

服务端使用 `express-oauth2-jwt-bearer` 根据 `OAUTH_ISSUER` 和 `OAUTH_AUDIENCE` 校验 JWT，并校验：

```text
iss === OAUTH_ISSUER
aud === OAUTH_AUDIENCE
exp / nbf 有效
scope 或 permissions 覆盖当前工具需要的权限
```

### CORS 说明

CORS 不是鉴权，不能阻止 curl、脚本或其他服务端请求直接访问公网 MCP 地址。公网暴露时建议启用 OAuth，并只短时间开启 ngrok。

### Session TTL 与限流

```env
MAX_SESSIONS=25
SESSION_TTL_MS=1800000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
```

这些配置用于限制 active MCP sessions 数量、清理空闲 session，并对 `/mcp` 做简单请求限流。过期 rate-limit 记录会自动清理，避免长期运行时无界增长。

### 公共信息暴露

默认：

```env
EXPOSE_PUBLIC_INFO=false
```

此时：

- `/health` 只返回 `{"status":"ok"}`
- `/` 只返回最小服务信息

若设置为 `true`，会公开工具清单、终端工具是否启用、active sessions 等调试信息。

## 项目结构

```text
src/
├── index.ts                    # 入口：启动 HTTP 服务和优雅关闭
├── server.ts                   # MCP Server 创建与 Tool 注册
├── transport.ts                # Streamable HTTP 传输层、限流、session 管理
├── config.ts                   # 配置管理和 workspace 校验
├── tools/
│   ├── filesystem.ts           # 文件系统工具 (8)
│   ├── search.ts               # 搜索工具 (3)，支持 ripgrep + Node fallback
│   ├── git.ts                  # Git 工具 (9)
│   └── terminal.ts             # 终端工具 (1，默认不注册)
└── utils/
    ├── logger.ts               # 日志工具
    ├── path-guard.ts           # 路径安全校验、realpath、目录和文件排除
    └── tool-annotations.ts     # MCP tool annotations 统一定义
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/mcp` | POST | MCP 初始化和工具调用 |
| `/mcp` | GET | SSE 流 / 服务端通知 |
| `/mcp` | DELETE | 终止 MCP session |
| `/.well-known/oauth-protected-resource` | GET | OAuth protected resource metadata |
| `/.well-known/oauth-protected-resource/mcp` | GET | OAuth protected resource metadata 兼容路径 |
| `/health` | GET | 健康检查 |
| `/` | GET | 服务信息 |

## 常见问题排查

| 问题 | 常见原因 | 处理方式 |
|------|----------|----------|
| 创建连接器时报 `Something went wrong` | URL 不是 `/mcp`、ngrok 未运行、tool schema/annotations 不合法 | 确认 URL 为 `https://<ngrok>/mcp`，重启服务，查看本地日志和 ngrok 请求日志 |
| `/health` 能访问，但 ChatGPT 连接失败 | MCP 初始化失败，或 OAuth metadata / Auth0 配置不正确 | 查看本地日志确认 MCP 初始化是否成功，检查 `/.well-known/oauth-protected-resource` 和 Auth0 issuer discovery |
| 服务启动失败 | `WORKSPACES` 配置了不存在或非目录路径 | 修正 `WORKSPACES` 后重启 |
| 工具数量从 21 变成 20 | `ENABLE_TERMINAL=false` | 这是默认安全行为；需要终端工具时显式开启 |
| `run_command` 不存在 | 终端工具默认未注册 | 设置 `ENABLE_TERMINAL=true` 并重启服务 |
| `run_command` 被拒绝 | 命令不在 `ALLOWED_COMMANDS` 完整命令列表中 | 添加完整允许命令，或仅在可信环境设置 `ALLOW_ANY_COMMAND=true` |
| 读取 `.env` 被拒绝 | 命中 `EXCLUDED_FILES` | 这是默认安全行为；不建议关闭 |
| 路径不在工作区 | `WORKSPACES` 未包含目标目录，或 symlink 指向外部 | 修改 `WORKSPACES` 后重启服务，避免依赖外部 symlink |
| 读取文件被拒绝 | 文件超过 `MAX_READ_BYTES`、不是普通文件或命中 `EXCLUDED_FILES` | 调整限制或改为读取更小文件 |
| `git_push --force` 被拒绝 | 默认禁止 force push | 需要时设置 `ALLOW_GIT_FORCE_PUSH=true`，谨慎使用 |
| `git_push` / `git_pull` 分支名被拒绝 | 分支参数包含 refspec 或异常 ref 字符 | 传入普通分支名，例如 `main` 或 `feature/foo` |
| 搜索速度慢 | 未安装 ripgrep，使用 Node fallback | 安装 ripgrep |
| OAuth 登录后仍 401 | Auth0 API Identifier 与 `OAUTH_AUDIENCE` 不一致、issuer 末尾 `/` 不一致、token 缺少 scope | 检查 Auth0 API Identifier、`.env` 配置和 token claims |

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
- 公网暴露时建议启用 `OAUTH_ENABLED=true`。
- 不要把 `WORKSPACES` 指到用户主目录、磁盘根目录或包含密钥的目录。
- 不要在公网环境启用 `ALLOW_ANY_COMMAND=true`。
- 不要在公网环境启用 `EXPOSE_PUBLIC_INFO=true`。
- 不要从 `EXCLUDED_FILES` 中移除 `.env`、私钥和证书模式。
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
