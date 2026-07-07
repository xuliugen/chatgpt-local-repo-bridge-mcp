import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertPathAllowed, resolvePath } from '../utils/path-guard.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { openWorldDestructiveTool } from '../utils/tool-annotations.js';
import { structuredResult } from '../utils/tool-result.js';

const MAX_TIMEOUT_MS = 120_000;
const MAX_ACTIVE_JOBS = 5;
const MAX_JOB_OUTPUT_CHARS = 5 * 1024 * 1024;
const DEFAULT_READ_CHARS = 16 * 1024;
const MAX_READ_CHARS = 64 * 1024;
const FINISHED_JOB_TTL_MS = 10 * 60_000;
const COMMAND_PREVIEW_CHARS = 16 * 1024;
const COMMAND_LOG_DIR_NAME = '.mcp-command-logs';
const DEFAULT_EXEC_YIELD_MS = 200;
const MAX_EXEC_YIELD_MS = 30_000;

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
  totalOutputChars: number;
  timeoutHandle?: NodeJS.Timeout;
  cleanupHandle?: NodeJS.Timeout;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorMessage?: string;
  logFilePath: string | null;
  logWriteError?: string;
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

function defaultCommandEnv(): Record<string, string> {
  return {
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GH_PAGER: 'cat',
    CI: '1',
    CODEX_CI: '1',
  };
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

function terminalResult(
  summary: string,
  fields: Record<string, unknown>,
  sections: Array<{ label: string; text: string }> = [],
  isError = false
): CallToolResult {
  return structuredResult({
    summary,
    fields,
    sections,
    isError,
    meta: { tool: fields.type ?? 'terminal' },
  });
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



function createJobLogFile(cwd: string, command: string, startedAt: number): string | null {
  if (config.commandLogMode === 'off') return null;

  try {
    const logDir = path.join(cwd, COMMAND_LOG_DIR_NAME);
    fsSync.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.log`);
    fsSync.writeFileSync(
      logPath,
      [
        `command: ${redactCommand(command)}`,
        `cwd: ${cwd}`,
        `startedAt: ${new Date(startedAt).toISOString()}`,
        `logMode: ${config.commandLogMode}`,
        '',
        config.commandLogMode === 'full'
          ? '[output]'
          : '[summary]\nstdout/stderr are kept in memory for tool polling; set COMMAND_LOG_MODE=full to persist full command output.',
        '',
      ].join('\n'),
      'utf8'
    );
    return logPath;
  } catch (error) {
    logger.warn(`job log init failed: ${(error as Error).message}`);
    return null;
  }
}

function appendJobLog(job: TerminalJob, source: 'stdout' | 'stderr' | 'system', text: string): void {
  if (!job.logFilePath || job.logWriteError) return;
  if (config.commandLogMode !== 'full' && source !== 'system') return;

  try {
    fsSync.appendFileSync(job.logFilePath, `[${source}]\n${text}${text.endsWith('\n') ? '' : '\n'}`, 'utf8');
  } catch (error) {
    job.logWriteError = (error as Error).message;
    logger.warn(`job log write failed: ${job.logWriteError}`);
  }
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

function fullOutputLogAvailable(job: TerminalJob): boolean {
  return config.commandLogMode === 'full' && job.logFilePath !== null;
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
  job.totalOutputChars += chunk.length;
  appendJobLog(job, source, text);

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
  appendJobLog(job, 'system', `status=${status} exitCode=${String(details.exitCode ?? '')} signal=${String(details.signal ?? '')} endedAt=${new Date().toISOString()}`);

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
      running: job.status === 'running',
      done: false,
      wallTimeMs: Date.now() - job.startedAt,
      outputTruncated: job.truncatedChars > 0,
      logFilePath: job.logFilePath,
      logMode: config.commandLogMode,
      fullLogSeparated: fullOutputLogAvailable(job),
      logFilePathContainsFullOutput: fullOutputLogAvailable(job),
      logWriteError: job.logWriteError ?? null,
      nextAction: '使用 run_command_read 或 write_stdin 继续读取；需要取消时使用 run_command_cancel。',
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
      outputTruncated: job.truncatedChars > 0,
      totalOutputChars: job.totalOutputChars,
      logFilePath: job.logFilePath,
      logMode: config.commandLogMode,
      fullLogSeparated: fullOutputLogAvailable(job),
      logFilePathContainsFullOutput: fullOutputLogAvailable(job),
      wallTimeMs: (job.endedAt ?? Date.now()) - job.startedAt,
      running: job.status === 'running',
      nextAction: done ? '命令已结束且当前输出已读完。' : '继续使用 run_command_read 或 write_stdin 传入 nextOffset 读取后续输出。',
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
      [{ label: 'reason', text: '终端工具当前只允许 ALLOWED_COMMANDS 中配置的完整命令。如确需开放任意命令，请设置 ALLOW_ANY_COMMAND=true，但不建议在公网环境使用。' }]
    ),
    true
  );
}

/**
 * 注册终端相关 Tools
 */
export function registerTerminalTools(server: McpServer): void {

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
        env: { ...process.env, ...defaultCommandEnv(), ...extraEnv },
        windowsHide: true,
      });

      const jobStartedAt = Date.now();
      const job: TerminalJob = {
        id: jobId,
        command,
        cwd: resolvedCwd,
        status: 'running',
        startedAt: jobStartedAt,
        child,
        output: '',
        baseOffset: 0,
        truncatedChars: 0,
        totalOutputChars: 0,
        logFilePath: createJobLogFile(resolvedCwd, command, jobStartedAt),
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

  // exec_command - DevSpace-style command: short yield, then return jobId if still running.
  server.registerTool(
    'exec_command',
    {
      title: 'Exec Command',
      description: 'Run a command with a short yield window. If it is still running, return a jobId for polling.',
      annotations: openWorldDestructiveTool,
      inputSchema: {
        command: z.string().min(1).max(500).describe('Command to execute; must match ALLOWED_COMMANDS unless ALLOW_ANY_COMMAND=true'),
        cwd: z.string().describe('Working directory'),
        timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe('Total timeout in ms, default 30000, max 120000'),
        yieldMs: z.number().int().positive().max(MAX_EXEC_YIELD_MS).optional().describe('Initial yield window in ms, default 200, max 30000'),
        env: z.record(z.string(), z.string()).optional().describe('Extra environment variables; NO_COLOR/TERM/PAGER/CI are injected by default'),
      },
    },
    async ({ command, cwd, timeout, yieldMs, env }): Promise<CallToolResult> => {
      cleanupExpiredJobs();
      const resolvedCwd = resolvePath(cwd);
      assertPathAllowed(resolvedCwd);

      if (!isCommandAllowed(command)) return commandRejectedResult();
      if (activeJobCount() >= MAX_ACTIVE_JOBS) {
        return terminalResult('Active command job limit reached', {
          ok: false,
          type: 'exec_command',
          activeJobs: activeJobCount(),
          maxActiveJobs: MAX_ACTIVE_JOBS,
        }, [], true);
      }

      const timeoutMs = Math.min(timeout ?? 30000, MAX_TIMEOUT_MS);
      const firstYieldMs = Math.min(yieldMs ?? DEFAULT_EXEC_YIELD_MS, MAX_EXEC_YIELD_MS, timeoutMs);
      const extraEnv = sanitizeEnv(env as Record<string, string> | undefined);
      const jobId = `cmd_${randomUUID()}`;
      logger.warn(`exec_command: job=${jobId} command="${redactCommand(command)}" in ${resolvedCwd}`);

      const child = spawn(command, {
        cwd: resolvedCwd,
        shell: true,
        env: { ...process.env, ...defaultCommandEnv(), ...extraEnv },
        windowsHide: true,
      });

      const jobStartedAt = Date.now();
      const job: TerminalJob = {
        id: jobId,
        command,
        cwd: resolvedCwd,
        status: 'running',
        startedAt: jobStartedAt,
        child,
        output: '',
        baseOffset: 0,
        truncatedChars: 0,
        totalOutputChars: 0,
        logFilePath: createJobLogFile(resolvedCwd, command, jobStartedAt),
      };
      terminalJobs.set(jobId, job);

      child.stdout.on('data', (chunk: Buffer) => appendJobOutput(job, 'stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => appendJobOutput(job, 'stderr', chunk));
      child.once('error', (error) => {
        appendJobOutput(job, 'system', `Command failed to start or run: ${error.message}\n`);
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
        appendJobOutput(job, 'system', `Command timed out after ${timeoutMs}ms; terminating.\n`);
        finishJob(job, 'timeout', { errorMessage: `Command timed out after ${timeoutMs}ms` });
        child.kill();
      }, timeoutMs);
      job.timeoutHandle.unref?.();

      await new Promise<void>((resolve) => {
        if (job.status !== 'running') {
          resolve();
          return;
        }

        let resolved = false;
        let yieldHandle: NodeJS.Timeout;
        const finishWait = (): void => {
          if (resolved) return;
          resolved = true;
          clearTimeout(yieldHandle);
          child.off('close', finishWait);
          child.off('error', finishWait);
          resolve();
        };

        yieldHandle = setTimeout(finishWait, firstYieldMs);
        child.once('close', finishWait);
        child.once('error', finishWait);
      });
      const snapshot = formatJobRead(job, job.baseOffset, DEFAULT_READ_CHARS);
      const running = job.status === 'running';

      return terminalResult(running ? 'Command still running; jobId returned' : 'Command completed within yield window', {
        ok: running || job.status === 'exited',
        type: 'exec_command',
        jobId: job.id,
        running,
        status: job.status,
        exitCode: job.exitCode ?? null,
        signal: job.signal ?? null,
        wallTimeMs: (job.endedAt ?? Date.now()) - job.startedAt,
        outputTruncated: job.truncatedChars > 0,
        logFilePath: job.logFilePath,
        logMode: config.commandLogMode,
        fullLogSeparated: fullOutputLogAvailable(job),
        logFilePathContainsFullOutput: fullOutputLogAvailable(job),
        logWriteError: job.logWriteError ?? null,
        nextAction: running
          ? 'Use write_stdin with jobId to poll output; use run_command_cancel to cancel.'
          : 'Command finished. Output remains readable during retention via write_stdin or run_command_read.',
      }, [{
        label: 'snapshot', text: snapshot }], !running && job.status !== 'exited');
    }
  );

  // write_stdin - DevSpace-style poll/input tool.
  server.registerTool(
    'write_stdin',
    {
      title: 'Write Stdin / Poll Command',
      description: 'Write optional input to a background command and read incremental output. Without stdin, this is a polling tool.',
      annotations: openWorldDestructiveTool,
      inputSchema: {
        jobId: z.string().min(1).describe('jobId returned by exec_command or run_command_start'),
        stdin: z.string().optional().describe('Text to write to process input;; omit to only read output'),
        offset: z.number().int().nonnegative().optional().describe('Output offset to read from'),
        maxBytes: z.number().int().positive().max(MAX_READ_CHARS).optional().describe('Max chars to read, default 16384, max 65536'),
      },
    },
    async ({ jobId, stdin, offset, maxBytes }): Promise<CallToolResult> => {
      cleanupExpiredJobs();

      const job = terminalJobs.get(jobId);
      if (!job) {
        return terminalResult('Command job not found', {
          ok: false,
          type: 'write_stdin',
          jobId,
          retentionMs: FINISHED_JOB_TTL_MS,
        }, [], true);
      }

      let stdinWritten = false;
      if (stdin !== undefined) {
        if (job.status !== 'running') {
          return terminalResult('Input failed: command already finished', {
            ok: false,
            type: 'write_stdin',
            jobId,
            status: job.status,
            running: false,
          }, [], true);
        }
        job.child.stdin.write(stdin);
        stdinWritten = true;
      }

      const readLimit = Math.min(maxBytes ?? DEFAULT_READ_CHARS, MAX_READ_CHARS);
      return terminalResult('Command output read complete', {
        ok: true,
        type: 'write_stdin',
        jobId,
        stdinWritten,
        status: job.status,
        running: job.status === 'running',
        readLimit,
        logFilePath: job.logFilePath,
        logMode: config.commandLogMode,
        fullLogSeparated: fullOutputLogAvailable(job),
        logFilePathContainsFullOutput: fullOutputLogAvailable(job),
        logWriteError: job.logWriteError ?? null,
      }, [{ label: 'snapshot', text: formatJobRead(job, offset, readLimit) }]);
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
