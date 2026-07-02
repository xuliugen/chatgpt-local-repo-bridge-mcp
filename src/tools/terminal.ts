import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertPathAllowed, resolvePath } from '../utils/path-guard.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

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
        '在指定目录下执行 shell 命令。适用于运行构建命令、测试、安装依赖等操作。' +
        '默认超时 30 秒，可自定义。' +
        '注意: 命令会在指定的工作目录下执行，请确保路径在允许的工作区内。',
      annotations: {
        title: 'Run Command',
        destructiveHint: true,
        readOnlyHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        command: z.string().describe('要执行的 shell 命令'),
        cwd: z.string().describe('命令执行的工作目录'),
        timeout: z.number().optional().describe('命令超时时间 (毫秒)，默认为 30000 (30秒)'),
        env: z.record(z.string(), z.string()).optional().describe('额外的环境变量'),
      },
    },
    async ({ command, cwd, timeout, env }): Promise<CallToolResult> => {
      const resolvedCwd = resolvePath(cwd);
      assertPathAllowed(resolvedCwd);

      logger.warn(`run_command: "${command}" in ${resolvedCwd}`);

      const timeoutMs = timeout ?? 30000;

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolvedCwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          env: { ...process.env, ...(env as Record<string, string | undefined>) },
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
