# Code Repository MCP Server

通过 MCP (Model Context Protocol) 协议让 ChatGPT 网页端直接操作本地代码仓库，支持文件增删改查、代码搜索、Git 操作和终端命令执行。

## 架构

```
ChatGPT 网页端
      |
      | Streamable HTTP Transport
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

### 4. 连接 ChatGPT

1. 打开 [ChatGPT 网页端](https://chatgpt.com)
2. 进入 **设置 → 连接器 → 添加 MCP 服务器**
3. 选择 **Streamable HTTP** 类型
4. 输入 URL：`http://localhost:3100/mcp`

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
