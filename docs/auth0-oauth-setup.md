# Auth0 OAuth 配置指南

本文档说明如何为 `chatgpt-local-repo-bridge-mcp` 配置 Auth0 OAuth，使 ChatGPT 通过 OAuth 获取 access token 后访问本地仓库 MCP 服务。

## 目标架构

```text
ChatGPT Connector
  -> Auth0 Authorization Server
  -> 获取 JWT access token
  -> 携带 Authorization: Bearer <access_token> 访问 MCP Server /mcp
  -> MCP Server 校验 issuer / audience / exp / nbf / scope 或 permissions
```

当前项目使用 `express-oauth2-jwt-bearer` 校验 JWT。服务端不再需要手动配置 `OAUTH_JWKS_URI`，JWKS 发现和签名校验由该库根据 `OAUTH_ISSUER` 处理。

## 重要安全结论

公网暴露 `/mcp` 时必须设置：

```env
OAUTH_ENABLED=true
```

如果设置为：

```env
OAUTH_ENABLED=false
```

`/mcp` 请求仍然会经过 OAuth 中间件，但中间件会直接放行，不会校验：

```text
Authorization header
JWT 签名
issuer
audience
exp / nbf
scope / permissions
```

因此 `OAUTH_ENABLED=false` 只适合本机开发或受信任内网，不应用于公网 ngrok 地址。

## 1. 准备 MCP 公网地址

先启动 MCP 服务：

```bash
npm run dev
```

再启动 ngrok：

```bash
ngrok http 3100
```

ngrok 会输出类似：

```text
Forwarding  https://example.ngrok-free.dev -> http://localhost:3100
```

MCP Server URL 必须带 `/mcp`：

```text
https://example.ngrok-free.dev/mcp
```

后续文档统一用下面占位值：

```text
MCP_PUBLIC_URL = https://example.ngrok-free.dev/mcp
AUTH0_DOMAIN   = dev-xxxxxx.us.auth0.com
AUTH0_ISSUER   = https://dev-xxxxxx.us.auth0.com/
```

注意：ngrok 免费地址变化后，需要同步更新 Auth0 API Identifier、项目 `.env` 和 ChatGPT Connector 配置。

## 2. 创建 Auth0 API

在 Auth0 Dashboard 中进入：

```text
Applications -> APIs -> Create API
```

填写：

```text
Name: chatgpt-local-repo-bridge-mcp
Identifier: https://example.ngrok-free.dev/mcp
Signing Algorithm: RS256
```

关键要求：

```text
Identifier 必须等于项目 .env 中的 OAUTH_AUDIENCE。
```

推荐保持三者一致：

```text
PUBLIC_MCP_URL = https://example.ngrok-free.dev/mcp
OAUTH_AUDIENCE = https://example.ngrok-free.dev/mcp
Auth0 API Identifier = https://example.ngrok-free.dev/mcp
```

## 3. 配置 Auth0 API Permissions

在刚创建的 API 中进入 `Permissions`，添加以下 permissions：

```text
repo:read   读取文件、目录、搜索、Git 只读操作
repo:write  文件写入、编辑、删除、移动、创建目录
repo:git    git add / commit / push / pull；当前 run_command 也要求该 scope
```

项目的工具级授权逻辑如下：

```text
list_directory / read_file / get_file_info / search_files / search_content / get_file_tree -> repo:read

git_status / git_diff / git_log / git_show -> repo:read

write_file / edit_file / delete_file / create_directory / move_file -> repo:write

git_add / git_commit / git_push / git_pull -> repo:git

git_branch:
  action=list -> repo:read
  action=create/switch/delete -> repo:git

run_command -> repo:git

未知工具名 -> fail-closed，要求 OAUTH_SCOPES 中配置的全部 scope
```

服务端会合并 JWT 中的 `scope` 和 `permissions` 后判断是否满足当前工具需要的权限。

## 4. 创建 Auth0 Application

在 Auth0 Dashboard 中进入：

```text
Applications -> Applications -> Create Application
```

推荐选择：

```text
Application Type: Regular Web Application
```

创建后记录：

```text
Domain
Client ID
Client Secret
```

这些值后续会填入 ChatGPT Connector 的 OAuth 配置中。

## 5. 配置 Auth0 Application 回调地址

在 Auth0 Application 的 `Settings` 中配置回调地址。

ChatGPT Connector 会使用自己的 OAuth redirect URI。你必须把 ChatGPT 显示或请求中的 redirect URI 原样加入 Auth0 的 Allowed Callback URLs。

常见形式类似：

```text
https://chatgpt.com/connector/oauth/<connector-id>
```

如果 Auth0 报错：

```text
Callback URL mismatch.
The provided redirect_uri is not in the list of allowed callback URLs.
```

处理方式是：

1. 从 Auth0 错误页或浏览器地址中找到实际的 `redirect_uri`。
2. 将该 URL 原样复制到 Auth0 Application 的 `Allowed Callback URLs`。
3. 保存 Auth0 Application。
4. 回到 ChatGPT 重新发起 OAuth 连接。

不要手写猜测 callback URL；必须以 ChatGPT 实际发送的 `redirect_uri` 为准。

建议同时配置：

```text
Allowed Callback URLs: ChatGPT 实际 redirect_uri
Allowed Logout URLs: https://chatgpt.com
Allowed Web Origins: https://chatgpt.com
```

## 6. 配置项目 .env

在项目根目录复制示例配置：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

OAuth 相关配置示例：

```env
OAUTH_ENABLED=true
PUBLIC_MCP_URL=https://example.ngrok-free.dev/mcp
OAUTH_ISSUER=https://dev-xxxxxx.us.auth0.com/
OAUTH_AUDIENCE=https://example.ngrok-free.dev/mcp
OAUTH_SCOPES=repo:read,repo:write,repo:git
```

字段说明：

| 配置 | 含义 | 要求 |
| --- | --- | --- |
| `OAUTH_ENABLED` | 是否启用 OAuth 校验 | 公网必须为 `true` |
| `PUBLIC_MCP_URL` | MCP 公网地址 | 必须以 `/mcp` 结尾 |
| `OAUTH_ISSUER` | Auth0 issuer | 通常为 `https://<AUTH0_DOMAIN>/`，末尾 `/` 要保留 |
| `OAUTH_AUDIENCE` | access token audience | 必须等于 Auth0 API Identifier |
| `OAUTH_SCOPES` | MCP 支持的 scopes | 默认 `repo:read,repo:write,repo:git` |

不需要配置：

```env
OAUTH_JWKS_URI=...
```

该项目已经不再读取 `OAUTH_JWKS_URI`。

## 7. 重启 MCP 服务

修改 `.env` 后必须重启服务。

开发模式：

```bash
npm run dev
```

生产模式：

```bash
npm run build
npm start
```

启动后确认日志中 OAuth 是启用状态。如果日志显示 OAuth 未启用，请检查 `.env` 是否被当前启动目录正确加载。

## 8. 验证 OAuth protected resource metadata

访问：

```bash
curl -i https://example.ngrok-free.dev/.well-known/oauth-protected-resource
```

预期返回 `200`，body 类似：

```json
{
  "resource": "https://example.ngrok-free.dev/mcp",
  "authorization_servers": ["https://dev-xxxxxx.us.auth0.com/"],
  "scopes_supported": ["repo:read", "repo:write", "repo:git"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://example.ngrok-free.dev/"
}
```

也支持：

```bash
curl -i https://example.ngrok-free.dev/.well-known/oauth-protected-resource/mcp
```

## 9. 验证未带 token 访问 /mcp

访问：

```bash
curl -i https://example.ngrok-free.dev/mcp
```

如果 OAuth 生效，预期返回：

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://example.ngrok-free.dev/.well-known/oauth-protected-resource", scope="repo:read repo:write repo:git"
```

如果返回 `200` 或进入 MCP 工具调用流程，说明 OAuth 没有生效。优先检查：

```text
OAUTH_ENABLED 是否为 true
.env 是否被当前进程加载
服务是否已重启
ngrok 是否转发到正确端口
ChatGPT / 浏览器是否自动带了 Authorization header
```

## 10. 在 ChatGPT Connector 中配置 OAuth

创建或编辑 ChatGPT 自定义 MCP Connector 时：

```text
MCP Server URL: https://example.ngrok-free.dev/mcp
Authentication: OAuth
```

OAuth 配置通常填写：

```text
Authorization URL: https://dev-xxxxxx.us.auth0.com/authorize
Token URL: https://dev-xxxxxx.us.auth0.com/oauth/token
Client ID: Auth0 Application Client ID
Client Secret: Auth0 Application Client Secret
Scope: repo:read repo:write repo:git
Audience: https://example.ngrok-free.dev/mcp
```

如果 ChatGPT 配置界面没有单独的 `Audience` 字段，需要在 Auth0 侧确保该 Application 请求 access token 时使用的 API audience 与 `OAUTH_AUDIENCE` 一致。否则服务端会报 audience 校验失败。

## 11. 常见错误与排查

### Callback URL mismatch

原因：Auth0 Application 的 Allowed Callback URLs 没有包含 ChatGPT 实际发送的 `redirect_uri`。

处理：复制实际 `redirect_uri` 到 Allowed Callback URLs 后保存。

### Service not found

常见原因：

```text
MCP 服务未启动
ngrok 地址已变化
ChatGPT Connector 中的 MCP Server URL 写错
URL 没有以 /mcp 结尾
ngrok 没有转发到 3100
```

### Client is not authorized to access resource server

常见原因：

```text
Auth0 Application 没有关联对应 API
请求的 audience 与 Auth0 API Identifier 不一致
OAUTH_AUDIENCE 与 Auth0 API Identifier 不一致
```

处理：确保以下三者一致：

```text
Auth0 API Identifier
.env OAUTH_AUDIENCE
ChatGPT OAuth audience
```

### Missing required Auth scopes

常见原因：

```text
Auth0 API 没有添加 permissions
ChatGPT OAuth scope 没有请求 repo:read repo:write repo:git
Auth0 access token 中没有 scope 或 permissions
```

处理：

1. 在 Auth0 API Permissions 中添加 `repo:read`、`repo:write`、`repo:git`。
2. 在 ChatGPT Connector OAuth scope 中请求这些 scope。
3. 重新连接，让 ChatGPT 获取新的 token。

### Invalid JWT audience

原因：access token 的 `aud` 与项目 `.env` 中的 `OAUTH_AUDIENCE` 不一致。

处理：统一：

```text
Auth0 API Identifier
OAUTH_AUDIENCE
ChatGPT OAuth audience
```

### Invalid JWT issuer

原因：token 的 `iss` 与 `OAUTH_ISSUER` 不一致。

处理：检查 `OAUTH_ISSUER`，通常应为：

```text
https://<AUTH0_DOMAIN>/
```

末尾 `/` 不要随意删除。

## 12. 上线前检查清单

```text
[ ] OAUTH_ENABLED=true
[ ] PUBLIC_MCP_URL 是公网 HTTPS，且以 /mcp 结尾
[ ] OAUTH_ISSUER 是 Auth0 issuer，末尾 / 与 discovery 文档一致
[ ] OAUTH_AUDIENCE 等于 Auth0 API Identifier
[ ] Auth0 API 已添加 repo:read / repo:write / repo:git permissions
[ ] Auth0 Application Allowed Callback URLs 包含 ChatGPT 实际 redirect_uri
[ ] ChatGPT Connector 的 MCP Server URL 等于 PUBLIC_MCP_URL
[ ] ChatGPT Connector 请求 repo:read repo:write repo:git scopes
[ ] 未带 token 访问 /mcp 返回 401
[ ] .env 没有提交到 Git
```
