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
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const port = parseInt(process.env.PORT || '3100', 10);

  const workspaces = parseList(process.env.WORKSPACES).map((p) =>
    path.resolve(p)
  );

  const excludedDirs = parseList(process.env.EXCLUDED_DIRS);
  // 默认排除常见不需要访问的目录
  if (excludedDirs.length === 0) {
    excludedDirs.push(
      'node_modules', '.git', 'dist', 'build',
      '.next', '.nuxt', '__pycache__', '.venv',
      '.tox', 'venv', '.cache', 'coverage'
    );
  }

  const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS);

  // 如果没有配置工作区，默认使用当前目录
  if (workspaces.length === 0) {
    workspaces.push(process.cwd());
  }

  // 如果没有配置 CORS 来源，允许所有 (开发模式)
  if (allowedOrigins.length === 0) {
    allowedOrigins.push('*');
  }

  return { port, workspaces, excludedDirs, allowedOrigins };
}

export const config = loadConfig();
