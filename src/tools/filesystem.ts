import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  assertNotWorkspaceRoot,
  assertPathAllowed,
  resolvePath,
  isDirExcluded,
  isFileExcluded,
} from '../utils/path-guard.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { destructiveLocalTool, readOnlyLocalTool, writeLocalTool } from '../utils/tool-annotations.js';
import { structuredResult } from '../utils/tool-result.js';

const DEFAULT_READ_LINES = 500;
const MAX_READ_LINES = 1000;
const DEFAULT_LIST_MAX_ENTRIES = 300;
const MAX_LIST_ENTRIES = 1000;

interface DirectoryListState {
  maxEntries: number;
  lines: string[];
  truncated: boolean;
  omittedEntries: number;
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf-8');
}

function normalizePositiveInt(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(Math.floor(value), 1), maxValue);
}

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function structuredTextResult(
  summary: string,
  fields: Record<string, unknown>,
  bodyLabel?: string,
  body?: string,
  isError = false
): CallToolResult {
  return structuredResult({
    summary,
    fields,
    sections: bodyLabel && body !== undefined ? [{ label: bodyLabel, text: body }] : [],
    isError,
    meta: { tool: fields.type ?? 'filesystem' },
  });
}

async function assertReadableTextFile(resolved: string): Promise<void> {
  const stats = await fs.stat(resolved);
  if (!stats.isFile()) {
    throw new Error(`路径不是普通文件: ${resolved}`);
  }
  if (stats.size > config.maxReadBytes) {
    throw new Error(
      `文件过大，拒绝读取: ${resolved} (${stats.size} bytes > ${config.maxReadBytes} bytes)`
    );
  }
}

function assertWritableContent(content: string): void {
  const size = byteLength(content);
  if (size > config.maxWriteBytes) {
    throw new Error(`写入内容过大，已拒绝 (${size} bytes > ${config.maxWriteBytes} bytes)`);
  }
}

/**
 * 注册文件系统相关 Tools
 */
export function registerFilesystemTools(server: McpServer): void {
  // 1. list_directory - 列出目录内容
  server.registerTool(
    'list_directory',
    {
      title: 'List Directory',
      description: '列出指定目录的内容，包括文件和子目录。可选择递归列出。递归模式最多展开 2 层，默认最多返回 300 个条目。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        path: z.string().describe('要列出的目录路径'),
        recursive: z.boolean().optional().describe('是否递归列出子目录，默认为 false'),
        maxEntries: z.number().int().positive().max(MAX_LIST_ENTRIES).optional().describe('最大返回条目数，默认为 300，最高 1000'),
      },
    },
    async ({ path: dirPath, recursive, maxEntries }): Promise<CallToolResult> => {
      const resolved = resolvePath(dirPath);
      assertPathAllowed(resolved);

      const limit = normalizePositiveInt(maxEntries, DEFAULT_LIST_MAX_ENTRIES, MAX_LIST_ENTRIES);
      logger.info(`list_directory: ${resolved} (recursive=${recursive}, maxEntries=${limit})`);

      const state: DirectoryListState = {
        maxEntries: limit,
        lines: [],
        truncated: false,
        omittedEntries: 0,
      };
      await listDir(resolved, recursive ?? false, 0, 2, state);

      return structuredTextResult(
        '目录列举完成',
        {
          ok: true,
          type: 'directory_list',
          path: resolved,
          recursive: recursive ?? false,
          maxDepth: recursive ? 2 : 0,
          entriesShown: state.lines.length,
          maxEntries: limit,
          truncated: state.truncated,
          omittedEntries: state.omittedEntries,
        },
        'entries',
        state.lines.join('\n')
      );
    }
  );

  // 2. read_file - 读取文件内容
  server.registerTool(
    'read_file',
    {
      title: 'Read File',
      description:
        '读取指定文本文件内容。支持按行号范围读取部分内容。' +
        '默认只读取前 500 行，单次最多 1000 行，且受 MAX_READ_BYTES 大小上限保护。' +
        '返回内容带有行号前缀，方便后续用 edit_file 定位。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        path: z.string().describe('要读取的文件路径'),
        startLine: z.number().int().positive().optional().describe('起始行号 (1-based)，不指定则从头开始'),
        endLine: z.number().int().positive().optional().describe('结束行号 (1-based)，不指定则按 maxLines 限制读取'),
        maxLines: z.number().int().positive().max(MAX_READ_LINES).optional().describe('本次最多读取的行数，默认为 500，最高 1000'),
      },
    },
    async ({ path: filePath, startLine, endLine, maxLines }): Promise<CallToolResult> => {
      const resolved = resolvePath(filePath);
      assertPathAllowed(resolved);
      await assertReadableTextFile(resolved);

      const allContent = await fs.readFile(resolved, 'utf-8');
      const allLines = allContent.split('\n');
      const totalLines = allLines.length;

      const start = startLine ?? 1;
      const lineLimit = normalizePositiveInt(maxLines, DEFAULT_READ_LINES, MAX_READ_LINES);
      const requestedEnd = endLine ?? start + lineLimit - 1;
      const cappedEnd = Math.min(requestedEnd, start + lineLimit - 1, totalLines);
      const truncated = cappedEnd < Math.min(requestedEnd, totalLines);

      if (start > totalLines) {
        return structuredTextResult(
          '读取失败: 起始行超出文件总行数',
          {
            ok: false,
            type: 'file_range',
            path: resolved,
            startLine: start,
            totalLines,
          },
          undefined,
          undefined,
          true
        );
      }

      if (start > requestedEnd) {
        return structuredTextResult(
          '读取失败: 行号范围无效',
          {
            ok: false,
            type: 'file_range',
            path: resolved,
            startLine: start,
            endLine: requestedEnd,
            totalLines,
          },
          undefined,
          undefined,
          true
        );
      }

      const selectedLines = allLines.slice(start - 1, cappedEnd);
      const numberedLines = selectedLines.map(
        (line, i) => `${String(start + i).padStart(5)}\t${line}`
      );
      const nextStartLine = cappedEnd < totalLines ? cappedEnd + 1 : null;

      logger.info(`read_file: ${resolved} (lines ${start}-${cappedEnd}/${totalLines}, maxLines=${lineLimit})`);

      return structuredTextResult(
        '文件范围读取完成',
        {
          ok: true,
          type: 'file_range',
          path: resolved,
          totalLines,
          startLine: start,
          endLine: cappedEnd,
          requestedEndLine: requestedEnd,
          maxLines: lineLimit,
          truncated,
          hasMore: nextStartLine !== null,
          nextStartLine,
        },
        'content',
        numberedLines.join('\n')
      );
    }
  );

  // 3. write_file - 创建/覆写文件
  server.registerTool(
    'write_file',
    {
      title: 'Write File',
      description: '创建新文件或完全覆盖已有文件的内容。会自动创建所需的父目录，并受 MAX_WRITE_BYTES 限制。',
      annotations: destructiveLocalTool,
      inputSchema: {
        path: z.string().describe('要写入的文件路径'),
        content: z.string().describe('要写入的文件内容'),
      },
    },
    async ({ path: filePath, content }): Promise<CallToolResult> => {
      assertWritableContent(content);

      const resolved = resolvePath(filePath);
      assertPathAllowed(resolved);
      assertNotWorkspaceRoot(resolved, 'write_file');

      logger.warn(`write_file: ${resolved} (${byteLength(content)} bytes)`);

      const dir = path.dirname(resolved);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(resolved, content, 'utf-8');

      return structuredTextResult('文件已成功写入', {
        ok: true,
        type: 'write_file',
        path: resolved,
        sizeBytes: byteLength(content),
      });
    }
  );

  // 4. edit_file - 局部编辑文件 (搜索替换 + 行号定位)
  server.registerTool(
    'edit_file',
    {
      title: 'Edit File',
      description:
        '局部编辑文件，支持两种定位模式:\n' +
        '1. 文本匹配模式: 通过 oldText/newText 搜索替换 (oldText 必须唯一匹配)\n' +
        '2. 行号模式: 通过 startLine/endLine/newText 指定要替换的行号范围',
      annotations: writeLocalTool,
      inputSchema: {
        path: z.string().describe('要编辑的文件路径'),
        edits: z.array(
          z.object({
            oldText: z.string().min(1).optional().describe('文本匹配模式：要被替换的原始文本；必须唯一匹配'),
            startLine: z.number().int().positive().optional().describe('行号模式：替换起始行号 (1-based)'),
            endLine: z.number().int().positive().optional().describe('行号模式：替换结束行号 (1-based，包含该行)'),
            newText: z.string().describe('替换后的新文本'),
          })
        ).min(1).max(50).describe('替换操作列表；每个 edit 使用 oldText 或 startLine/endLine 二选一'),
      },
    },
    async ({ path: filePath, edits }): Promise<CallToolResult> => {
      const resolved = resolvePath(filePath);
      assertPathAllowed(resolved);
      assertNotWorkspaceRoot(resolved, 'edit_file');
      await assertReadableTextFile(resolved);

      logger.info(`edit_file: ${resolved} (${edits.length} edits)`);

      let content = await fs.readFile(resolved, 'utf-8');
      let lines = content.split('\n');
      const appliedEdits: string[] = [];

      for (const edit of edits) {
        const usesLineRange = edit.startLine !== undefined || edit.endLine !== undefined;
        const usesTextMatch = edit.oldText !== undefined;

        if (usesLineRange && usesTextMatch) {
          return structuredTextResult(
            '编辑失败: 单个 edit 不能同时使用 oldText 和 startLine/endLine',
            { ok: false, type: 'edit_file', path: resolved },
            undefined,
            undefined,
            true
          );
        }

        if (usesLineRange) {
          if (edit.startLine === undefined || edit.endLine === undefined) {
            return structuredTextResult(
              '编辑失败: 行号模式必须同时提供 startLine 和 endLine',
              { ok: false, type: 'edit_file', path: resolved },
              undefined,
              undefined,
              true
            );
          }

          const start = edit.startLine - 1;
          const end = edit.endLine;

          if (start < 0 || end > lines.length || start >= end) {
            return structuredTextResult(
              '编辑失败: 行号范围无效',
              {
                ok: false,
                type: 'edit_file',
                path: resolved,
                startLine: edit.startLine,
                endLine: edit.endLine,
                totalLines: lines.length,
              },
              undefined,
              undefined,
              true
            );
          }

          lines.splice(start, end - start, ...edit.newText.split('\n'));
          appliedEdits.push(`行 ${edit.startLine}-${edit.endLine}: 替换了 ${end - start} 行`);
          content = lines.join('\n');
        } else {
          if (!edit.oldText) {
            return structuredTextResult(
              '编辑失败: 文本匹配模式必须提供 oldText，或使用 startLine/endLine 行号模式',
              { ok: false, type: 'edit_file', path: resolved },
              undefined,
              undefined,
              true
            );
          }

          const joined = lines.join('\n');
          const count = joined.split(edit.oldText).length - 1;

          if (count === 0) {
            return structuredTextResult(
              '编辑失败: 未找到匹配的文本片段',
              {
                ok: false,
                type: 'edit_file',
                path: resolved,
              },
              'searchText',
              edit.oldText,
              true
            );
          }

          if (count > 1) {
            return structuredTextResult(
              '编辑失败: 文本片段匹配不唯一',
              {
                ok: false,
                type: 'edit_file',
                path: resolved,
                matchCount: count,
              },
              'searchText',
              edit.oldText,
              true
            );
          }

          content = joined.replace(edit.oldText, edit.newText);
          lines = content.split('\n');
          appliedEdits.push('文本匹配: 替换了 1 处');
        }

        assertWritableContent(content);
      }

      await fs.writeFile(resolved, content, 'utf-8');

      return structuredTextResult(
        '文件已成功编辑',
        {
          ok: true,
          type: 'edit_file',
          path: resolved,
          editCount: edits.length,
        },
        'appliedEdits',
        appliedEdits.join('\n')
      );
    }
  );

  // 5. delete_file - 删除文件
  server.registerTool(
    'delete_file',
    {
      title: 'Delete File',
      description: '删除指定的文件或空目录。禁止直接删除工作区根目录。',
      annotations: destructiveLocalTool,
      inputSchema: {
        path: z.string().describe('要删除的文件或目录路径'),
        recursive: z.boolean().optional().describe('是否递归删除目录及其内容，默认为 false'),
      },
    },
    async ({ path: filePath, recursive }): Promise<CallToolResult> => {
      const resolved = resolvePath(filePath);
      assertPathAllowed(resolved);
      assertNotWorkspaceRoot(resolved, 'delete_file');

      logger.warn(`delete_file: ${resolved} (recursive=${recursive})`);

      const stats = await fs.lstat(resolved);

      if (stats.isDirectory()) {
        await fs.rm(resolved, { recursive: recursive ?? false });
      } else {
        await fs.unlink(resolved);
      }

      return structuredTextResult('已成功删除', {
        ok: true,
        type: 'delete_file',
        path: resolved,
        recursive: recursive ?? false,
      });
    }
  );

  // 6. create_directory - 创建目录
  server.registerTool(
    'create_directory',
    {
      title: 'Create Directory',
      description: '创建新的目录，自动创建所需的父目录。',
      annotations: writeLocalTool,
      inputSchema: {
        path: z.string().describe('要创建的目录路径'),
      },
    },
    async ({ path: dirPath }): Promise<CallToolResult> => {
      const resolved = resolvePath(dirPath);
      assertPathAllowed(resolved);
      assertNotWorkspaceRoot(resolved, 'create_directory');

      logger.info(`create_directory: ${resolved}`);

      await fs.mkdir(resolved, { recursive: true });

      return structuredTextResult('目录已创建', {
        ok: true,
        type: 'create_directory',
        path: resolved,
      });
    }
  );

  // 7. move_file - 移动/重命名文件
  server.registerTool(
    'move_file',
    {
      title: 'Move File',
      description: '移动或重命名文件/目录。禁止直接移动工作区根目录。',
      annotations: destructiveLocalTool,
      inputSchema: {
        source: z.string().describe('源文件/目录路径'),
        destination: z.string().describe('目标路径'),
      },
    },
    async ({ source, destination }): Promise<CallToolResult> => {
      const resolvedSrc = resolvePath(source);
      const resolvedDst = resolvePath(destination);
      assertPathAllowed(resolvedSrc);
      assertPathAllowed(resolvedDst);
      assertNotWorkspaceRoot(resolvedSrc, 'move_file');

      logger.info(`move_file: ${resolvedSrc} -> ${resolvedDst}`);

      const dstDir = path.dirname(resolvedDst);
      await fs.mkdir(dstDir, { recursive: true });

      await fs.rename(resolvedSrc, resolvedDst);

      return structuredTextResult('已移动', {
        ok: true,
        type: 'move_file',
        source: resolvedSrc,
        destination: resolvedDst,
      });
    }
  );

  // 8. get_file_info - 获取文件元信息
  server.registerTool(
    'get_file_info',
    {
      title: 'Get File Info',
      description: '获取文件或目录的元信息，包括大小、修改时间、类型等。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        path: z.string().describe('文件路径'),
      },
    },
    async ({ path: filePath }): Promise<CallToolResult> => {
      const resolved = resolvePath(filePath);
      assertPathAllowed(resolved);

      logger.info(`get_file_info: ${resolved}`);

      const stats = await fs.lstat(resolved);

      return structuredTextResult('文件信息读取完成', {
        ok: true,
        type: 'file_info',
        path: resolved,
        fileType: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
        size: formatSize(stats.size),
        sizeBytes: stats.size,
        created: stats.birthtime.toISOString(),
        modified: stats.mtime.toISOString(),
        accessed: stats.atime.toISOString(),
        permissions: `0${(stats.mode & 0o777).toString(8)}`,
      });
    }
  );
}

// 辅助函数：递归列出目录
async function listDir(
  dirPath: string,
  recursive: boolean,
  depth: number,
  maxDepth: number,
  state: DirectoryListState
): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const indent = '  '.repeat(depth);

  const filtered = entries.filter((e) => {
    if (e.isDirectory() && isDirExcluded(e.name)) return false;
    if (e.isFile() && isFileExcluded(e.name)) return false;
    return true;
  });

  const sorted = filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < sorted.length; i++) {
    if (state.lines.length >= state.maxEntries) {
      state.truncated = true;
      state.omittedEntries += sorted.length - i;
      break;
    }

    const entry = sorted[i];
    const prefix = entry.isDirectory() ? '[D] ' : '[F] ';
    state.lines.push(`${indent}${prefix}${entry.name}`);

    if (recursive && entry.isDirectory() && depth < maxDepth) {
      const subDir = path.join(dirPath, entry.name);
      try {
        assertPathAllowed(subDir);
        await listDir(subDir, true, depth + 1, maxDepth, state);
      } catch {
        if (state.lines.length < state.maxEntries) {
          state.lines.push(`${indent}  [权限不足，跳过]`);
        }
      }
    }
  }
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}
