# Code Repository MCP Server

通过 MCP (Model Context Protocol) 协议让 ChatGPT 网页端直接操作本地代码仓库，支持文件增删改查、代码搜索、Git 操作和终端命令执行。

## 架构

```
ChatGPT 网页端 (chatgpt.com)
      |
      | HTTPS (Streamable HTTP Transport)
      v
+-------------------------------+
|  ngrok 隧道 (公网 HTTPS 地址)  |
|  https://xxx.ngrok-free.app   |
+-------------------------------+
      |
      | 本地转发 → localhost:3100
      v
+-------------------------------+
|  MCP Server (localhost:3100)  |
|                               |
|  Tools (21个)                 |
|  ├── filesystem  (8)          |
|  ├── search      (3)          |
|  ├── git         (9)          |
|  └── terminal    (1)          |
|                               |
|  安全层                       |
|  ├── 工作区路径白名单          |
|  ├── 排除目录黑名单            |
|  └── CORS 来源限制            |
+-------------------------------+
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并按需修改：

```env
# MCP Server 端口
PORT=3100

# 允许访问的工作区目录 (逗号分隔，支持多个目录)
WORKSPACES=/Users/you/Dev/Code,/Users/you/Projects

# 排除的目录名 (逗号分隔，匹配任意层级)
# 不配置则使用默认值: node_modules,.git,dist,build,.next,.nuxt,__pycache__,.venv,.tox,venv,.cache,coverage
EXCLUDED_DIRS=node_modules,.git,dist,build,.next,__pycache__,.venv,.cache,coverage

# 允许的跨域来源 (逗号分隔)
ALLOWED_ORIGINS=https://chatgpt.com,https://chat.openai.com
```

**配置说明：**

| 变量 | 作用 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3100` |
| `WORKSPACES` | 允许访问的目录，逗号分隔多个路径 | 当前目录 |
| `EXCLUDED_DIRS` | 排除的目录名 (匹配任意层级) | `node_modules,.git,dist,...` |
| `ALLOWED_ORIGINS` | CORS 允许的域名 | `*` (开发模式) |

### 3. 启动服务

```bash
# 开发模式 (热重载)
npm run dev

# 生产模式
npm run build && npm start
```

### 4. 使用 ngrok 内网穿透

ChatGPT 网页端运行在云端，**无法直接访问你电脑上的 `localhost:3100`**。必须通过内网穿透工具将本地服务暴露为公网 HTTPS 地址，ChatGPT 才能连接。这里使用 [ngrok](https://ngrok.com/) 实现。

#### 4.1 注册 ngrok 账号

1. 访问 [ngrok 官网](https://ngrok.com/)，点击 **Sign Up** 注册账号（免费版即可）
2. 注册后在 [Dashboard](https://dashboard.ngrok.com/) 页面找到你的 **Authtoken**

#### 4.2 安装 ngrok

**Windows（推荐用 npm 安装）：**

```bash
npm install -g ngrok
```

**Windows（独立安装包）：**

1. 从 [ngrok 下载页](https://ngrok.com/download) 下载 `ngrok-v3-stable-windows-amd64.zip`
2. 解压得到 `ngrok.exe`，将其所在目录加入系统 `PATH` 环境变量

**macOS：**

```bash
brew install ngrok
```

**Linux：**

```bash
snap install ngrok
```

#### 4.3 配置 Authtoken

将 Dashboard 中的 Authtoken 配置到本地（只需执行一次）：

```bash
ngrok config add-authtoken <你的Authtoken>
```

配置完成后会生成 `~/.config/ngrok/ngrok.yml`（Windows 为 `%USERPROFILE%\AppData\Local\ngrok\ngrok.yml`）。

#### 4.4 启动 MCP 服务

确保本地 MCP Server 已启动（端口默认 3100）：

```bash
npm run dev
```

启动后确认 `http://localhost:3100/health` 可正常访问。

#### 4.5 启动 ngrok 隧道

另开一个终端窗口，将本地 3100 端口暴露为公网 HTTPS 地址：

```bash
ngrok http 3100
```

启动后终端会显示类似输出：

```
Session Status                online
Account                       your-email@example.com (Plan: Free)
Version                       3.x.x
Region                        United States (Us)
Latency                       -
Web Interface                 http://127.0.0.1:4040
Forwarding                    https://a1b2-203-0-113-1.ngrok-free.app -> http://localhost:3100

Connections                   ttl     opn     rt1     rt5     p50     p90
```

> **关键信息：** 复制 `Forwarding` 行中的 HTTPS 地址，例如 `https://a1b2-203-0-113-1.ngrok-free.app`。这就是 ChatGPT 将要连接的公网地址。

#### 4.6 验证隧道

在浏览器中访问以下地址确认隧道正常工作：

- **健康检查：** `https://<你的ngrok地址>/health` — 应返回 `{"status":"ok",...}`
- **服务信息：** `https://<你的ngrok地址>/` — 应返回服务名称和工具列表

如果看到 ngrok 的警告页面（"Visit Site"），点击即可继续，这是免费版的正常行为。

#### 4.7 保持 ngrok 运行

> **注意：** ngrok 免费版每次重启隧道地址会变化。如果需要固定域名，可升级到付费版使用 `ngrok http 3100 --domain=your-domain.ngrok.app`。免费版下，每次重启 ngrok 后需要到 ChatGPT 更新连接器 URL。

---

### 5. 在 ChatGPT 中配置 MCP 应用

ngrok 隧道启动后，将公网 HTTPS 地址配置到 ChatGPT 网页端。当前 ChatGPT 通过 **开发者模式 + 自定义应用（Custom App）** 来连接 MCP 服务器。

> **前提条件：** MCP 应用功能需要 ChatGPT 付费订阅（Plus / Team / Pro 等），免费版不可用。详见 [OpenAI 开发者模式文档](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)。

#### 5.1 确认 CORS 配置

确保 `.env` 中的 `ALLOWED_ORIGINS` 包含 ChatGPT 的域名（**无需添加 ngrok 地址**，因为请求的 `Origin` 头来自浏览器中的 chatgpt.com）：

```env
ALLOWED_ORIGINS=https://chatgpt.com,https://chat.openai.com
```

修改后重启 MCP Server 使配置生效。

#### 5.2 开启开发者模式

1. 打开 [ChatGPT 网页端](https://chatgpt.com) 并登录
2. 点击左下角用户头像，打开 **Settings（设置）** 弹窗（也可直接访问 [chatgpt.com/#settings](https://chatgpt.com/#settings)）
3. 滚动到设置页面**底部**，点击 **Advanced Settings（高级设置）**
4. 将 **Developer mode（开发者模式）** 开关切换为**开启**

#### 5.3 创建 MCP 应用

1. 开启开发者模式后，在同一个设置弹窗中切换到 **Apps & Connectors（应用与连接器）** 选项卡
2. 点击页面右上角的 **Create** 按钮
3. 在弹出的表单中填写应用信息：

| 字段 | 填写内容 |
|------|----------|
| **Name（名称）** | 自定义，如 `Code Repo MCP` |
| **Description（描述）** | 可选，如 `Local code repository operations` |
| **MCP Server URL** | `https://<你的ngrok地址>/mcp` |
| **Authentication（认证）** | 选择 `None` |

> **重要：** MCP Server URL 必须以 `/mcp` 结尾。例如 ngrok 转发地址为 `https://a1b2-203-0-113-1.ngrok-free.app`，则完整 URL 为 `https://a1b2-203-0-113-1.ngrok-free.app/mcp`。

4. 勾选 **"I understand and want to continue"（我已了解并希望继续）** 复选框
5. 点击 **Create** 创建应用

#### 5.4 验证应用状态

1. 返回 ChatGPT 主界面，顶部应显示 **Developer mode** 标识，表示 MCP 应用已启用
2. 如果没有看到标识，刷新页面；若仍未出现，回到 **Advanced Settings** 确认开发者模式开关已打开
3. 在 **Apps & Connectors** 选项卡中确认刚创建的应用状态为已启用

#### 5.5 在对话中使用 MCP 工具

1. 在 ChatGPT 聊天输入框中点击 **`+`** 按钮
2. 选择 **More**
3. 选择你创建的 **Code Repo MCP** 应用将其附加到当前对话
4. 输入测试指令，例如：

```
列出我的项目根目录下的文件
```

ChatGPT 会调用 `list_directory` 工具并返回结果。首次工具调用时可能出现确认提示，点击允许即可（可勾选 "Remember for this conversation" 避免重复确认）。

> **提示：** 每个新对话都需要重新通过 **`+` → More → 选择应用** 来附加 MCP 连接器。

你也可以在 **ngrok Web Interface**（`http://127.0.0.1:4040`）中查看实时请求日志，确认请求是否正常转发到本地服务。

#### 5.6 常见问题排查

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 设置中没有 Advanced Settings | 未使用付费版 ChatGPT | 升级至 Plus / Team / Pro 等付费订阅 |
| 设置中没有 Apps & Connectors | 开发者模式未开启 | 在 Advanced Settings 中开启 Developer mode |
| 应用创建后连接失败 | ngrok 隧道未启动或地址已变 | 重启 ngrok，更新应用中的 MCP Server URL |
| CORS 错误 | `ALLOWED_ORIGINS` 未包含 chatgpt 域名 | 添加 `https://chatgpt.com,https://chat.openai.com` 并重启服务 |
| 工具调用报路径不在工作区 | `WORKSPACES` 未配置目标目录 | 在 `.env` 中添加目标目录路径 |
| 对话中看不到 MCP 工具 | 未在当前对话附加应用 | 点击 **`+`** → **More** → 选择已创建的应用 |
| 请求超时 | 本地服务未运行 / 端口不匹配 | 确认 MCP Server 在 3100 端口运行 |
| ngrok 免费版拦截页面 | 免费版首次访问有警告页 | 在浏览器中先访问一次 ngrok 地址并点击 "Visit Site"，ChatGPT 端通常不受影响 |

## 工具列表 (21 个 Tools)

### 文件系统 (8 个)

| Tool | 功能 | 关键参数 |
|------|------|----------|
| `list_directory` | 列出目录内容 | `path`, `recursive?` |
| `read_file` | 读取文件 (带行号，默认500行) | `path`, `startLine?`, `endLine?` |
| `write_file` | 创建/覆写文件 (自动建目录) | `path`, `content` |
| `edit_file` | 局部编辑 (文本匹配 + 行号模式) | `path`, `edits[]` |
| `delete_file` | 删除文件/目录 | `path`, `recursive?` |
| `create_directory` | 创建目录 | `path` |
| `move_file` | 移动/重命名 | `source`, `destination` |
| `get_file_info` | 文件元信息 (大小/时间/权限) | `path` |

### 搜索 (3 个)

| Tool | 功能 | 关键参数 |
|------|------|----------|
| `search_files` | glob 文件名搜索 | `pattern`, `basePath?`, `maxResults?` |
| `search_content` | 正则内容搜索 (优先 ripgrep) | `regex`, `path?`, `filePattern?`, `maxResults?` |
| `get_file_tree` | 目录树结构 | `path`, `maxDepth?`, `showHidden?` |

### Git (9 个)

| Tool | 功能 | 关键参数 |
|------|------|----------|
| `git_status` | 仓库状态 | `repoPath` |
| `git_diff` | 变更 diff | `repoPath`, `staged?`, `filePath?` |
| `git_log` | 提交历史 | `repoPath`, `count?`, `filePath?` |
| `git_add` | 暂存文件 | `repoPath`, `files` |
| `git_commit` | 提交变更 | `repoPath`, `message` |
| `git_branch` | 分支管理 (列出/创建/切换/删除) | `repoPath`, `action`, `branchName?` |
| `git_show` | commit 详情 | `repoPath`, `commitHash` |
| `git_push` | 推送到远程 | `repoPath`, `remote?`, `branch?`, `force?` |
| `git_pull` | 拉取远程变更 | `repoPath`, `remote?`, `branch?`, `rebase?` |

### 终端 (1 个)

| Tool | 功能 | 关键参数 |
|------|------|----------|
| `run_command` | 执行 shell 命令 | `command`, `cwd`, `timeout?`, `env?` |

## 安全机制

### 路径白名单

所有文件操作必须在 `WORKSPACES` 配置的目录内，越权访问会被拒绝：

```
路径 "/etc/passwd" 不在允许的工作区目录内。
允许的工作区: /Users/xuliugen/Dev/Code
```

### 目录排除

`EXCLUDED_DIRS` 中的目录名在**任意层级**都会被拦截：

- **直接访问**：`read_file("/path/node_modules/xxx")` → 报错
- **目录遍历**：`list_directory` / `get_file_tree` 自动跳过
- **搜索过滤**：`search_content` / `search_files` 自动忽略

### CORS 限制

仅允许 `ALLOWED_ORIGINS` 中配置的域名发起跨域请求。

## 项目结构

```
src/
├── index.ts              # 入口：启动 HTTP 服务
├── server.ts             # MCP Server 创建与 Tool 注册
├── transport.ts          # Streamable HTTP 传输层 (Express)
├── config.ts             # 配置管理 (.env 加载)
├── tools/
│   ├── filesystem.ts     # 文件系统工具 (8)
│   ├── search.ts         # 搜索工具 (3)，支持 ripgrep
│   ├── git.ts            # Git 工具 (9)
│   └── terminal.ts       # 终端工具 (1)
└── utils/
    ├── path-guard.ts     # 路径安全校验 + 目录排除
    └── logger.ts         # 日志工具
```

## 技术栈

| 维度 | 选择 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js >= 18 |
| MCP SDK | @modelcontextprotocol/sdk |
| 传输协议 | Streamable HTTP |
| Web 框架 | Express |
| Git 操作 | simple-git |
| 搜索加速 | ripgrep (可选，自动降级) |
| Schema | Zod v4 |

## 典型 AI Coding 工作流

```
用户: "帮我在 my-app 项目里加一个用户注册功能"

ChatGPT 自动执行:
 1. get_file_tree("/path/to/my-app")           → 了解项目结构
 2. search_content("router|app\\.use", ...)    → 找到路由入口
 3. read_file("src/routes/index.ts")           → 读路由文件
 4. write_file("src/routes/auth.ts", ...)      → 创建注册路由
 5. edit_file("src/routes/index.ts", [...])    → 注册新路由
 6. run_command("npm run build", ...)          → 编译检查
 7. run_command("npm test", ...)               → 跑测试
 8. git_diff(repoPath=...)                     → 查看变更
 9. git_add + git_commit                       → 提交代码
10. git_push                                   → 推送到远程
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/mcp` | POST | MCP 协议主端点 (初始化 + 调用) |
| `/mcp` | GET | SSE 流 (服务端通知) |
| `/mcp` | DELETE | 终止会话 |
| `/health` | GET | 健康检查 |
| `/` | GET | 服务信息 + 工具列表 |

## 优化建议

安装 [ripgrep](https://github.com/BurntSushi/ripgrep) 可显著提升大仓库的代码搜索性能：

```bash
brew install ripgrep    # macOS
apt install ripgrep     # Ubuntu/Debian
```

`search_content` 工具会自动检测 ripgrep 是否可用，不可用时降级为 Node.js 内置搜索。

## License

ISC
