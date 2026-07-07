import { z } from 'zod';
import { exec, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertPathAllowed, resolvePath } from '../utils/path-guard.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { openWorldDestructiveTool } from '../utils/tool-annotations.js';

const execAsync = promisify(exec);
const MAX_TIMEOUT_MS = 120_000;
const MAX_ACTIVE_JOBS = 5;
const MAX_JOB_OUTPUT_CHARS = 5 * 1024 * 1024;
const DEFAULT_READ_CHARS = 16 * 1024;
const MAX_READ_CHARS = 64 * 1024;
const FINISHED_JOB_TTL_MS = 10 * 60_000;
const COMMAND_PREVIEW_CHARS = 16 * 1024;
const COMMAND_LOG_DIR_NAME = '.mcp-command-logs';

type TerminalJobStatus = 'running' | 'exited' | 'failed' | 'timeout' | 'cancelled';

interface TerminalJob {
  id: string;
  command: string;
  cwd: string;
  status: TerminalJobStatus;
  startedAt: number;
  endedAt?: number;
  child: ChildProcessWithoutNullStreams;
  output: string;
  baseOffset: number;
  truncatedChars: number;
  timeoutHandle?: NodeJS.Timeout;
  cleanupHandle?: NodeJS.Timeout;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorMessage?: string;
}

const terminalJobs = new Map<string, TerminalJob>();

function redactCommand(command: string): string {
  return command.replace(/(token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*[^\s]+/gi, '$1=<redacted>');
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isCommandAllowed(command: string): boolean {
  if (config.allowAnyCommand) return true;

  const normalizedCommand = normalizeCommand(command);
  return config.allowedCommands.some((allowed) => normalizeCommand(allowed) === normalizedCommand);
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

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function stripAnsi(text: string): string {
  return text.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ''
  );
}

function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function structuredText(
  summary: string,
  fields: Record<string, unknown>,
  sections: Array<{ label: string; text: string }> = []
): string {
  const lines = [
    `summary: ${summary}`,
    ...Object.entries(fields).map(([key, value]) => `${key}: ${formatFieldValue(value)}`),
  ];

  for (const section of sections) {
    lines.push('', `[${section.label}]`, section.text || '(空)');
  }

  return lines.join('\n');
}

function previewText(text: string | undefined, maxChars = COMMAND_PREVIEW_CHARS): {
  preview: string;
  truncated: boolean;
  chars: number;
  bytes: number;
} {
  const rawValue = text ?? '';
  const value = stripAnsi(rawValue);
  if (value.length <= maxChars) {
    return {
      preview: value,
      truncated: false,
      chars: value.length,
      bytes: Buffer.byteLength(rawValue, 'utf-8'),
    };
  }

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.3);
  const omittedChars = value.length - headChars - tailChars;

  return {
    preview: `${value.slice(0, headChars)}\n\n...[truncated ${omittedChars} chars]...\n\n${value.slice(-tailChars)}`,
    truncated: true,
    chars: value.length,
    bytes: Buffer.byteLength(rawValue, 'utf-8'),
  };
}

async function writeCommandLogFile(args: {
  cwd: string;
  command: string;
  startedAt: number;
  endedAt: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: unknown;
  killed?: boolean;
}): Promise<string | null> {
  const stdout = args.stdout ?? '';
  const stderr = args.stderr ?? '';
  const error = args.error ?? '';
  if (!stdout && !stderr && !error) return null;

  const logDir = path.join(args.cwd, COMMAND_LOG_DIR_NAME);
  await fs.mkdir(logDir, { recursive: true });

  const logPath = path.join(logDir, `${new Date(args.endedAt).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.log`);
  const logContent = [
    `command: ${redactCommand(args.command)}`,
    `cwd: ${args.cwd}`,
    `startedAt: ${new Date(args.startedAt).toISOString()}`,
    `endedAt: ${new Date(args.endedAt).toISOString()}`,
    `durationMs: ${args.endedAt - args.startedAt}`,
    `exitCode: ${String(args.exitCode ?? '')}`,
    `killed: ${args.killed ?? false}`,
    '',
    '[stdout]',
    stdout || '(空)',
    '',
    '[stderr]',
    stderr || '(空)',
    '',
    '[error]',
    error || '(空)',
  ].join('\n');

  try {
    await fs.writeFile(logPath, logContent, 'utf-8');
    return logPath;
  } catch (error) {
    logger.warn(`命令完整日志写入失败: ${(error as Error).message}`);
    return null;
  }
}

function formatCommandResult(args: {
  ok: boolean;
  command: string;
  cwd: string;
  timeoutMs: number;
  startedAt: number;
  endedAt: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: unknown;
  killed?: boolean;
  logFilePath: string | null;
}): string {
  const stdout = previewText(args.stdout);
  const stderr = previewText(args.stderr);
  const error = previewText(args.error, 4096);
  const fullLogRequired = stdout.truncated || stderr.truncated || error.truncated;

  return structuredText(
    args.ok ? '命令执行成功' : '命令执行失败',
    {
      ok: args.ok,
      type: 'command_result',
      command: redactCommand(args.command),
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      durationMs: args.endedAt - args.startedAt,
      exitCode: args.exitCode ?? null,
      killed: args.killed ?? false,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      errorTruncated: error.truncated,
      logFilePath: args.logFilePath,
      fullLogSeparated: args.logFilePath !== null,
      fullLogRequired,
      nextHint: fullLogRequired && args.logFilePath
        ? '输出预览已截断；请读取 logFilePath 获取完整日志后再下结论。'
        : '输出预览未截断；如需审计完整 stdout/stderr，可读取 logFilePath。',
    },
    [
      { label: 'stdoutPreview', text: stdout.preview },
      { label: 'stderrPreview', text: stderr.preview },
      ...(args.error ? [{ label: 'error', text: error.preview }] : []),
    ]
  );
}

function formatIsoTime(timeMs: number | undefined): string {
  return timeMs ? new Date(timeMs).toISOString() : '';
}

function activeJobCount(): number {
  let count = 0;
  for (const job of terminalJobs.values()) {
    if (job.status === 'running') count += 1;
  }
  return count;
}

function scheduleJobCleanup(job: TerminalJob): void {
  if (job.cleanupHandle) return;

  job.cleanupHandle = setTimeout(() => {
    terminalJobs.delete(job.id);
  }, FINISHED_JOB_TTL_MS);
  job.cleanupHandle.unref?.();
}

function cleanupExpiredJobs(): void {
  const now = Date.now();
  for (const [jobId, job] of terminalJobs.entries()) {
    if (job.status !== 'running' && job.endedAt && now - job.endedAt > FINISHED_JOB_TTL_MS) {
      if (job.cleanupHandle) clearTimeout(job.cleanupHandle);
      terminalJobs.delete(jobId);
    }
  }
}

function appendJobOutput(job: TerminalJob, source: 'stdout' | 'stderr' | 'system', data: string | Buffer): void {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
  if (!text) return;

  const chunk = `[${source}]\n${text}${text.endsWith('\n') ? '' : '\n'}`;
  job.output += chunk;

  const overflow = job.output.length - MAX_JOB_OUTPUT_CHARS;
  if (overflow > 0) {
    job.output = job.output.slice(overflow);
    job.baseOffset += overflow;
    job.truncatedChars += overflow;
  }
}

function finishJob(
  job: TerminalJob,
  status: Exclude<TerminalJobStatus, 'running'>,
  details: { exitCode?: number | null; signal?: NodeJS.Signals | null; errorMessage?: string } = {}
): void {
  if (job.status !== 'running') {
    if (job.exitCode === undefined && 'exitCode' in details) job.exitCode = details.exitCode;
    if (job.signal === undefined && 'signal' in details) job.signal = details.signal;
    return;
  }

  job.status = status;
  job.endedAt = Date.now();
  job.exitCode = details.exitCode;
  job.signal = details.signal;
  job.errorMessage = details.errorMessage;

  if (job.timeoutHandle) {
    clearTimeout(job.timeoutHandle);
    job.timeoutHandle = undefined;
  }

  scheduleJobCleanup(job);
}

function formatJobStart(job: TerminalJob): string {
  return structuredText(
    '后台命令已启动',
    {
      ok: true,
      type: 'command_job_start',
      jobId: job.id,
      status: job.status,
      startedAt: formatIsoTime(job.startedAt),
      offset: job.baseOffset,
      nextOffset: job.baseOffset,
      done: false,
    },
    [{ label: 'nextStep', text: '使用 run_command_read 传入 jobId 和 offset 读取增量输出。' }]
  );
}

function formatJobRead(job: TerminalJob, requestedOffset: number | undefined, maxChars: number): string {
  const outputStart = job.baseOffset;
  const outputEnd = job.baseOffset + job.output.length;
  const warnings: string[] = [];
  let readOffset = requestedOffset ?? outputStart;

  if (readOffset < outputStart) {
    warnings.push(`warning: 请求 offset ${readOffset} 已被截断，最早可读 offset 是 ${outputStart}`);
    readOffset = outputStart;
  }

  if (readOffset > outputEnd) {
    warnings.push(`warning: 请求 offset ${readOffset} 超过当前输出末尾 ${outputEnd}`);
    readOffset = outputEnd;
  }

  const startIndex = readOffset - outputStart;
  const rawOutput = job.output.slice(startIndex, startIndex + maxChars);
  const output = stripAnsi(rawOutput);
  const nextOffset = readOffset + rawOutput.length;
  const done = job.status !== 'running' && nextOffset >= outputEnd;

  return structuredText(
    '后台命令输出读取完成',
    {
      ok: true,
      type: 'command_job_read',
      jobId: job.id,
      status: job.status,
      offset: readOffset,
      nextOffset,
      done,
      startedAt: formatIsoTime(job.startedAt),
      endedAt: job.endedAt ? formatIsoTime(job.endedAt) : null,
      exitCode: job.exitCode ?? null,
      signal: job.signal ?? null,
      error: job.errorMessage ?? null,
      truncatedChars: job.truncatedChars,
      warnings,
      ansiStripped: rawOutput !== output,
      maxChars,
    },
    [{ label: 'output', text: output || '(暂无新增输出)' }]
  );
}

function formatJobCancel(job: TerminalJob): string {
  return structuredText(
    job.status === 'cancelled' ? '后台命令已取消' : '后台命令已经结束，无需取消',
    {
      ok: true,
      type: 'command_job_cancel',
      jobId: job.id,
      status: job.status,
      startedAt: formatIsoTime(job.startedAt),
      endedAt: job.endedAt ? formatIsoTime(job.endedAt) : null,
    }
  );
}

function commandRejectedResult(): CallToolResult {
  return textResult(
    structuredText(
      '命令已被拒绝',
      {
        ok: false,
        type: 'command_rejected',
        allowAnyCommand: config.allowAnyCommand,
        allowedCommandCount: config.allowedCommands.length,
      },
      [{ label: 'reason', text: 'run_command 当前只允许 ALLOWED_COMMANDS 中配置的完整命令。如确需开放任意命令，请设置 ALLOW_ANY_COMMAND=true，但不建议在公网环境使用。' }]
    ),
    true
  );
}

/**
 * 注册终端相关 Tools
 */
export function registerTerminalTools(server: McpServer): void {
  // run_command - 执行 shell 命令并在命令结束后一次性返回输出
  server.registerTool(
    'run_command',
    {
      title: 'Run Command',
      description:
        '在指定目录下执行 shell 命令。此工具高风险，默认不注册；启用后仍默认只允许 ALLOWED_COMMANDS 中配置的完整命令。',
      annotations: openWorldDestructiveTool,
      inputSchema: {
        command: z.string().min(1).max(500).describe('要执行的 shell 命令；默认必须完整匹配 ALLOWED_COMMANDS 中的一项'),
        cwd: z.string().describe('命令执行的工作目录'),
        timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe('命令超时时间 (毫秒)，默认 30000，最高 120000'),
        env: z.record(z.string(), z.string()).optional().describe('额外的环境变量；禁止覆盖 NODE_OPTIONS 和 npm_config_script_shell'),
      },
    },
    async ({ command, cwd, timeout, env }): Promise<CallToolResult> => {
      const resolvedCwd = resolvePath(cwd);
      assertPathAllowed(resolvedCwd);

      if (!isCommandAllowed(command)) {
        return commandRejectedResult();
      }

      const timeoutMs = Math.min(timeout ?? 30000, MAX_TIMEOUT_MS);
      const extraEnv = sanitizeEnv(env as Record<string, string> | undefined);

      logger.warn(`run_command: "${redactCommand(command)}" in ${resolvedCwd}`);

      const startedAt = Date.now();

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolvedCwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, ...extraEnv },
          windowsHide: true,
        });
        const endedAt = Date.now();
        const logFilePath = await writeCommandLogFile({
          cwd: resolvedCwd,
          command,
          startedAt,
          endedAt,
          stdout,
          stderr,
          exitCode: 0,
        });

        return textResult(formatCommandResult({
          ok: true,
          command,
          cwd: resolvedCwd,
          timeoutMs,
          startedAt,
          endedAt,
          stdout,
          stderr,
          exitCode: 0,
          logFilePath,
        }));
      } catch (error) {
        const endedAt = Date.now();
        const execError = error as {
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          message?: string;
          code?: unknown;
        };
        const errorMessage = execError.message || '命令执行失败';
        const logFilePath = await writeCommandLogFile({
          cwd: resolvedCwd,
          command,
          startedAt,
          endedAt,
          stdout: execError.stdout,
          stderr: execError.stderr,
          error: errorMessage,
          exitCode: execError.code,
          killed: execError.killed,
        });

        return textResult(formatCommandResult({
          ok: false,
          command,
          cwd: resolvedCwd,
          timeoutMs,
          startedAt,
          endedAt,
          stdout: execError.stdout,
          stderr: execError.stderr,
          error: execError.killed ? `命令在 ${timeoutMs}ms 后被终止\n${errorMessage}` : errorMessage,
          exitCode: execError.code ?? null,
          killed: execError.killed,
          logFilePath,
        }), true);
      }
    }
  );

  // run_command_start - 启动后台命令，返回 jobId，供后续增量读取
  server.registerTool(
    'run_command_start',
    {
      title: 'Start Command Job',
      description:
        '启动一个后台 shell 命令并立即返回 jobId。适合长命令；后续使用 run_command_read 增量读取输出，使用 run_command_cancel 取消。',
      annotations: openWorldDestructiveTool,
      inputSchema: {
        command: z.string().min(1).max(500).describe('要执行的 shell 命令；默认必须完整匹配 ALLOWED_COMMANDS 中的一项'),
        cwd: z.string().describe('命令执行的工作目录'),
        timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe('命令超时时间 (毫秒)，默认 30000，最高 120000'),
        env: z.record(z.string(), z.string()).optional().describe('额外的环境变量；禁止覆盖 NODE_OPTIONS 和 npm_config_script_shell'),
      },
    },
    async ({ command, cwd, timeout, env }): Promise<CallToolResult> => {
      cleanupExpiredJobs();

      const resolvedCwd = resolvePath(cwd);
      assertPathAllowed(resolvedCwd);

      if (!isCommandAllowed(command)) {
        return commandRejectedResult();
      }

      if (activeJobCount() >= MAX_ACTIVE_JOBS) {
        return textResult(`后台命令数量达到上限: activeJobs=${activeJobCount()} maxActiveJobs=${MAX_ACTIVE_JOBS}`, true);
      }

      const timeoutMs = Math.min(timeout ?? 30000, MAX_TIMEOUT_MS);
      const extraEnv = sanitizeEnv(env as Record<string, string> | undefined);
      const jobId = `cmd_${randomUUID()}`;

      logger.warn(`run_command_start: job=${jobId} command="${redactCommand(command)}" in ${resolvedCwd}`);

      const child = spawn(command, {
        cwd: resolvedCwd,
        shell: true,
        env: { ...process.env, ...extraEnv },
        windowsHide: true,
      });

      const job: TerminalJob = {
        id: jobId,
        command,
        cwd: resolvedCwd,
        status: 'running',
        startedAt: Date.now(),
        child,
        output: '',
        baseOffset: 0,
        truncatedChars: 0,
      };

      terminalJobs.set(jobId, job);

      child.stdout.on('data', (chunk: Buffer) => {
        appendJobOutput(job, 'stdout', chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        appendJobOutput(job, 'stderr', chunk);
      });

      child.once('error', (error) => {
        appendJobOutput(job, 'system', `命令启动或执行失败: ${error.message}\n`);
        finishJob(job, 'failed', { errorMessage: error.message });
      });

      child.once('close', (code, signal) => {
        if (job.status !== 'running') {
          if (job.exitCode === undefined) job.exitCode = code;
          if (job.signal === undefined) job.signal = signal;
          return;
        }

        finishJob(job, code === 0 ? 'exited' : 'failed', { exitCode: code, signal });
      });

      job.timeoutHandle = setTimeout(() => {
        if (job.status !== 'running') return;
        appendJobOutput(job, 'system', `命令在 ${timeoutMs}ms 后超时，正在终止。\n`);
        finishJob(job, 'timeout', { errorMessage: `命令在 ${timeoutMs}ms 后超时` });
        child.kill();
      }, timeoutMs);
      job.timeoutHandle.unref?.();

      return textResult(formatJobStart(job));
    }
  );

  // run_command_read - 读取后台命令的增量输出
  server.registerTool(
    'run_command_read',
    {
      title: 'Read Command Job Output',
      description:
        '按 offset 读取 run_command_start 创建的后台命令增量输出。返回 nextOffset；done=true 表示命令已结束且当前输出已读完。',
      inputSchema: {
        jobId: z.string().min(1).describe('run_command_start 返回的 jobId'),
        offset: z.number().int().nonnegative().optional().describe('从哪个输出偏移开始读取；首次读取可传 0 或不传'),
        maxBytes: z.number().int().positive().max(MAX_READ_CHARS).optional().describe('本次最多读取的字符数，默认 16384，最高 65536'),
      },
    },
    async ({ jobId, offset, maxBytes }): Promise<CallToolResult> => {
      cleanupExpiredJobs();

      const job = terminalJobs.get(jobId);
      if (!job) {
        return textResult(`未找到后台命令 job: ${jobId}。可能 jobId 错误，或已超过 ${FINISHED_JOB_TTL_MS}ms 保留期被清理。`, true);
      }

      const readLimit = Math.min(maxBytes ?? DEFAULT_READ_CHARS, MAX_READ_CHARS);
      return textResult(formatJobRead(job, offset, readLimit));
    }
  );

  // run_command_cancel - 取消后台命令
  server.registerTool(
    'run_command_cancel',
    {
      title: 'Cancel Command Job',
      description: '取消 run_command_start 创建的仍在运行的后台命令。',
      annotations: openWorldDestructiveTool,
      inputSchema: {
        jobId: z.string().min(1).describe('run_command_start 返回的 jobId'),
      },
    },
    async ({ jobId }): Promise<CallToolResult> => {
      cleanupExpiredJobs();

      const job = terminalJobs.get(jobId);
      if (!job) {
        return textResult(`未找到后台命令 job: ${jobId}。可能 jobId 错误，或已超过 ${FINISHED_JOB_TTL_MS}ms 保留期被清理。`, true);
      }

      if (job.status === 'running') {
        appendJobOutput(job, 'system', '命令已请求取消，正在终止。\n');
        finishJob(job, 'cancelled');
        job.child.kill();
      }

      return textResult(formatJobCancel(job));
    }
  );
}
