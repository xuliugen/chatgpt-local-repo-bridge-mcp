import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertPathAllowed, resolvePath } from '../utils/path-guard.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { openWorldDestructiveTool } from '../utils/tool-annotations.js';

const execAsync = promisify(exec);
const MAX_TIMEOUT_MS = 120_000;

function redactCommand(command: string): string {
  return command.replace(/(token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*[^\s]+/gi, '$1=<redacted>');
}

function isCommandAllowed(command: string): boolean {
  if (config.allowAnyCommand) return true;
  return config.allowedCommandPrefixes.some((prefix) => command.trim().startsWith(prefix));
}

function sanitizeEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`环境变量名不安全: ${key}`);
    }
    if (/^(NODE_OPTIONS|npm_config_script_shell)$/i.test(key)) {
      throw new Error(`环境变量不允许覆盖: ${key}`);
    }
    sanitized[key] = value;
  }

  return sanitized;
}

/**
 * 注册终端相关 Tools
 */
export function registerTerminalTools(server: McpServer): void {
  // run_command - 执行 shell 命令
  server.registerTool(
    'run_command',
    {
      title: 'Run Command',
      description:
        '在指定目录下执行 shell 命令。此工具高风险，默认不注册；启用后仍默认只允许 ALLOWED_COMMAND_PREFIXES 中配置的命令前缀。',
      annotations: openWorldDestructiveTool,
      inputSchema: {
        command: z.string().min(1).max(500).describe('要执行的 shell 命令'),
        cwd: z.string().describe('命令执行的工作目录'),
        timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe('命令超时时间 (毫秒)，默认 30000，最高 120000'),
        env: z.record(z.string(), z.string()).optional().describe('额外的环境变量；禁止覆盖 NODE_OPTIONS 和 npm_config_script_shell'),
      },
    },
    async ({ command, cwd, timeout, env }): Promise<CallToolResult> => {
      const resolvedCwd = resolvePath(cwd);
      assertPathAllowed(resolvedCwd);

      if (!isCommandAllowed(command)) {
        return {
          content: [{
            type: 'text',
            text:
              '命令已被拒绝: run_command 当前只允许 ALLOWED_COMMAND_PREFIXES 中配置的命令前缀。' +
              '\n如确需开放任意命令，请设置 ALLOW_ANY_COMMAND=true，但不建议在公网环境使用。',
          }],
          isError: true,
        };
      }

      const timeoutMs = Math.min(timeout ?? 30000, MAX_TIMEOUT_MS);
      const extraEnv = sanitizeEnv(env as Record<string, string> | undefined);

      logger.warn(`run_command: "${redactCommand(command)}" in ${resolvedCwd}`);

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolvedCwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, ...extraEnv },
          windowsHide: true,
        });

        const parts: string[] = [];

        if (stdout) {
          parts.push(`[stdout]\n${stdout}`);
        }

        if (stderr) {
          parts.push(`[stderr]\n${stderr}`);
        }

        if (parts.length === 0) {
          parts.push('(命令执行成功，无输出)');
        }

        return {
          content: [{ type: 'text', text: parts.join('\n\n') }],
        };
      } catch (error) {
        const execError = error as {
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          message?: string;
        };

        const parts: string[] = [];

        if (execError.killed) {
          parts.push(`[超时] 命令在 ${timeoutMs}ms 后被终止`);
        }

        if (execError.stdout) {
          parts.push(`[stdout]\n${execError.stdout}`);
        }

        if (execError.stderr) {
          parts.push(`[stderr]\n${execError.stderr}`);
        }

        parts.push(`[错误]\n${execError.message || '命令执行失败'}`);

        return {
          content: [{ type: 'text', text: parts.join('\n\n') }],
          isError: true,
        };
      }
    }
  );
}
