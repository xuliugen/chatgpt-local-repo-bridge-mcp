import dotenv from 'dotenv';
import path from 'node:path';

// 加载 .env 文件
dotenv.config();

export interface AppConfig {
  /** MCP 服务端口 */
  port: number;
  /** 允许访问的工作区目录列表 (已解析为绝对路径) */
  workspaces: string[];
  /** 排除的目录名列表 (匹配任意层级，如 node_modules, dist, .git 等) */
  excludedDirs: string[];
  /** 允许的 CORS 来源 */
  allowedOrigins: string[];
  /** 可选 Bearer token；配置后所有 /mcp 请求必须携带 Authorization: Bearer <token> */
  authToken?: string;
  /** 是否注册任意命令执行工具 */
  enableTerminal: boolean;
  /** 是否允许 run_command 执行任意命令；默认 false，建议只使用 allowedCommandPrefixes */
  allowAnyCommand: boolean;
  /** run_command 允许的命令前缀列表 */
  allowedCommandPrefixes: string[];
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

export function loadConfig(): AppConfig {
  const port = parseNumber(process.env.PORT, 3100, 1, 65535);

  const workspaces = parseList(process.env.WORKSPACES).map((p) =>
    path.resolve(p)
  );

  const excludedDirs = parseList(process.env.EXCLUDED_DIRS);
  // 默认排除常见不需要访问或高风险的目录/文件夹名
  if (excludedDirs.length === 0) {
    excludedDirs.push(
      'node_modules', '.git', 'dist', 'build',
      '.next', '.nuxt', '__pycache__', '.venv',
      '.tox', 'venv', '.cache', 'coverage', '.qoder'
    );
  }

  const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS);
  // 如果没有配置 CORS 来源，仅允许 ChatGPT 常用域名；不要默认为 *。
  if (allowedOrigins.length === 0) {
    allowedOrigins.push('https://chatgpt.com', 'https://chat.openai.com');
  }

  // 如果没有配置工作区，默认使用当前目录
  if (workspaces.length === 0) {
    workspaces.push(process.cwd());
  }

  const authToken = process.env.MCP_AUTH_TOKEN?.trim() || undefined;
  const enableTerminal = parseBoolean(process.env.ENABLE_TERMINAL, false);
  const allowAnyCommand = parseBoolean(process.env.ALLOW_ANY_COMMAND, false);
  const allowedCommandPrefixes = parseList(process.env.ALLOWED_COMMAND_PREFIXES);
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
    workspaces,
    excludedDirs,
    allowedOrigins,
    authToken,
    enableTerminal,
    allowAnyCommand,
    allowedCommandPrefixes,
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
