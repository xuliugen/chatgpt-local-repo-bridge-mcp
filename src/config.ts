import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

// 加载 .env 文件
dotenv.config();

export interface AppConfig {
  /** MCP 服务端口 */
  port: number;
  /** 是否启用 OAuth Bearer Token 校验 */
  oauthEnabled: boolean;
  /** 公网 MCP endpoint URL，例如 https://example.com/mcp */
  publicMcpUrl: string;
  /** OAuth / OIDC issuer，例如 Auth0 tenant URL */
  oauthIssuer: string;
  /** OAuth access token audience */
  oauthAudience: string;
  /** OAuth issuer JWKS URI */
  oauthJwksUri: string;
  /** MCP 工具所需 OAuth scopes */
  oauthScopes: string[];
  /** 允许访问的工作区目录列表 (已解析为绝对路径) */
  workspaces: string[];
  /** 排除的目录名列表 (匹配任意层级，如 node_modules, dist, .git 等) */
  excludedDirs: string[];
  /** 排除的敏感文件名 / glob 模式列表，仅匹配 basename */
  excludedFilePatterns: string[];
  /** 允许的 CORS 来源 */
  allowedOrigins: string[];
  /** 是否注册任意命令执行工具 */
  enableTerminal: boolean;
  /** 是否允许 run_command 执行任意命令；默认 false，建议只使用 allowedCommands */
  allowAnyCommand: boolean;
  /** run_command 允许执行的完整命令列表 */
  allowedCommands: string[];
  /** 是否允许 git push --force */
  allowGitForcePush: boolean;
  /** 是否在根路径公开详细工具清单 */
  exposePublicInfo: boolean;
  /** read_file / edit_file 单文件读取上限 */
  maxReadBytes: number;
  /** write_file / edit_file 写入内容上限 */
  maxWriteBytes: number;
  /** 最大 MCP 会话数 */
  maxSessions: number;
  /** 会话空闲 TTL */
  sessionTtlMs: number;
  /** 简易限流窗口 */
  rateLimitWindowMs: number;
  /** 每个窗口内每个来源允许的 /mcp 请求数 */
  rateLimitMax: number;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function validateWorkspace(workspace: string): string {
  const resolved = path.resolve(workspace);
  let stats: fs.Stats;

  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`工作区目录不存在或不可访问: ${resolved}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`工作区路径不是目录: ${resolved}`);
  }

  return resolved;
}

export function loadConfig(): AppConfig {
  const port = parseNumber(process.env.PORT, 3100, 1, 65535);

  const oauthEnabled = parseBoolean(process.env.OAUTH_ENABLED, false);
  const publicMcpUrl = process.env.PUBLIC_MCP_URL?.trim() || `http://localhost:${port}/mcp`;
  const oauthIssuer = process.env.OAUTH_ISSUER?.trim() || '';
  const oauthAudience = process.env.OAUTH_AUDIENCE?.trim() || publicMcpUrl;
  const oauthJwksUri = process.env.OAUTH_JWKS_URI?.trim() || '';
  const oauthScopes = parseList(process.env.OAUTH_SCOPES);
  if (oauthScopes.length === 0) {
    oauthScopes.push('repo:read', 'repo:write', 'repo:git');
  }

  if (oauthEnabled) {
    if (!publicMcpUrl.startsWith('https://') && !publicMcpUrl.startsWith('http://localhost:')) {
      throw new Error('启用 OAuth 时 PUBLIC_MCP_URL 必须是 HTTPS URL，或本地调试使用 http://localhost。');
    }
    if (!oauthIssuer || !oauthAudience || !oauthJwksUri) {
      throw new Error('启用 OAuth 时必须配置 OAUTH_ISSUER、OAUTH_AUDIENCE 和 OAUTH_JWKS_URI。');
    }
  }

  const configuredWorkspaces = parseList(process.env.WORKSPACES);
  const workspaces = (configuredWorkspaces.length > 0 ? configuredWorkspaces : [process.cwd()])
    .map(validateWorkspace);

  const excludedDirs = parseList(process.env.EXCLUDED_DIRS);
  // 默认排除常见不需要访问或高风险的目录/文件夹名
  if (excludedDirs.length === 0) {
    excludedDirs.push(
      'node_modules', '.git', 'dist', 'build',
      '.next', '.nuxt', '__pycache__', '.venv',
      '.tox', 'venv', '.cache', 'coverage', '.qoder'
    );
  }

  const excludedFilePatterns = parseList(process.env.EXCLUDED_FILES);
  if (excludedFilePatterns.length === 0) {
    excludedFilePatterns.push(
      '.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local', '.env.staging', '.env.staging.local', '.envrc', '.npmrc', '.pypirc',
      '*.pem', '*.key', '*.crt', '*.cer',
      '*.p12', '*.pfx',
      'id_rsa', 'id_rsa.*', 'id_ed25519', 'id_ed25519.*'
    );
  }

  const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS);
  // 如果没有配置 CORS 来源，仅允许 ChatGPT 常用域名；不要默认为 *。
  if (allowedOrigins.length === 0) {
    allowedOrigins.push('https://chatgpt.com', 'https://chat.openai.com');
  }

  const enableTerminal = parseBoolean(process.env.ENABLE_TERMINAL, false);
  const allowAnyCommand = parseBoolean(process.env.ALLOW_ANY_COMMAND, false);
  const allowedCommands = parseList(process.env.ALLOWED_COMMANDS);
  const allowGitForcePush = parseBoolean(process.env.ALLOW_GIT_FORCE_PUSH, false);
  const exposePublicInfo = parseBoolean(process.env.EXPOSE_PUBLIC_INFO, false);

  const maxReadBytes = parseNumber(process.env.MAX_READ_BYTES, 1024 * 1024, 1024, 20 * 1024 * 1024);
  const maxWriteBytes = parseNumber(process.env.MAX_WRITE_BYTES, 2 * 1024 * 1024, 1024, 20 * 1024 * 1024);
  const maxSessions = parseNumber(process.env.MAX_SESSIONS, 25, 1, 500);
  const sessionTtlMs = parseNumber(process.env.SESSION_TTL_MS, 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
  const rateLimitWindowMs = parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000, 1000, 60 * 60 * 1000);
  const rateLimitMax = parseNumber(process.env.RATE_LIMIT_MAX, 120, 1, 10_000);

  return {
    port,
    oauthEnabled,
    publicMcpUrl,
    oauthIssuer,
    oauthAudience,
    oauthJwksUri,
    oauthScopes,
    workspaces,
    excludedDirs,
    excludedFilePatterns,
    allowedOrigins,
    enableTerminal,
    allowAnyCommand,
    allowedCommands,
    allowGitForcePush,
    exposePublicInfo,
    maxReadBytes,
    maxWriteBytes,
    maxSessions,
    sessionTtlMs,
    rateLimitWindowMs,
    rateLimitMax,
  };
}

export const config = loadConfig();
