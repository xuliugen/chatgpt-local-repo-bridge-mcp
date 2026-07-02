/**
 * 简单的日志工具
 * 用于记录 MCP Server 的操作日志
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '\x1b[36m',  // cyan
  [LogLevel.INFO]: '\x1b[32m',   // green
  [LogLevel.WARN]: '\x1b[33m',   // yellow
  [LogLevel.ERROR]: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (level < currentLevel) return;

  const color = LOG_LEVEL_COLORS[level];
  const label = LOG_LEVEL_LABELS[level];
  const timestamp = formatTimestamp();

  const prefix = `${color}[${timestamp}] [${label}]${RESET}`;

  if (args.length > 0) {
    console.log(prefix, message, ...args);
  } else {
    console.log(prefix, message);
  }
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => log(LogLevel.DEBUG, message, ...args),
  info: (message: string, ...args: unknown[]) => log(LogLevel.INFO, message, ...args),
  warn: (message: string, ...args: unknown[]) => log(LogLevel.WARN, message, ...args),
  error: (message: string, ...args: unknown[]) => log(LogLevel.ERROR, message, ...args),
};
