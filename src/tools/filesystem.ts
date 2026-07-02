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

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf-8');
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
      description: '列出指定目录的内容，包括文件和子目录。可选择递归列出。递归模式最多展开 2 层。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        path: z.string().describe('要列出的目录路径'),
        recursive: z.boolean().optional().describe('是否递归列出子目录，默认为 false'),
      },
    },
    async ({ path: dirPath, recursive }): Promise<CallToolResult> => {
      const resolved = resolvePath(dirPath);
      assertPathAllowed(resolved);

      logger.info(`list_directory: ${resolved} (recursive=${recursive})`);

      const entries = await listDir(resolved, recursive ?? false, 0, 2);
      return {
        content: [{ type: 'text', text: entries }],
      };
    }
  );

  // 2. read_file - 读取文件内容
  server.registerTool(
    'read_file',
    {
      title: 'Read File',
      description:
        '读取指定文本文件内容。支持按行号范围读取部分内容。' +
        '默认只读取前 500 行，且受 MAX_READ_BYTES 大小上限保护。' +
        '返回内容带有行号前缀，方便后续用 edit_file 定位。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        path: z.string().describe('要读取的文件路径'),
        startLine: z.number().int().positive().optional().describe('起始行号 (1-based)，不指定则从头开始'),
        endLine: z.number().int().positive().optional().describe('结束行号 (1-based)，默认为 500'),
      },
    },
    async ({ path: filePath, startLine, endLine }): Promise<CallToolResult> => {
      const resolved = resolvePath(filePath);
      assertPathAllowed(resolved);
      await assertReadableTextFile(resolved);

      const allContent = await fs.readFile(resolved, 'utf-8');
      const allLines = allContent.split('\n');
      const totalLines = allLines.length;

      const start = (startLine ?? 1) - 1;
      const requestedEnd = endLine ?? 500;
      const end = Math.min(requestedEnd, totalLines);

      if (start >= totalLines) {
        return {
          content: [{ type: 'text', text: `读取失败: startLine=${startLine} 超出文件总行数 ${totalLines}` }],
          isError: true,
        };
      }

      if (start >= end) {
        return {
          content: [{ type: 'text', text: `读取失败: 行号范围无效 (startLine=${startLine ?? 1}, endLine=${requestedEnd})` }],
          isError: true,
        };
      }

      const selectedLines = allLines.slice(start, end);

      logger.info(`read_file: ${resolved} (lines ${start + 1}-${end}/${totalLines})`);

      const numberedLines = selectedLines.map(
        (line, i) => `${String(start + i + 1).padStart(5)}\t${line}`
      );

      const header = `文件: ${resolved} (共 ${totalLines} 行，当前显示 ${start + 1}-${end} 行)`;
      const footer = end < totalLines
        ? `\n... 还有 ${totalLines - end} 行未显示，请设置 endLine 参数查看更多 ...`
        : '';

      return {
        content: [{ type: 'text', text: `${header}\n${numberedLines.join('\n')}${footer}` }],
      };
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

      return {
        content: [{ type: 'text', text: `文件已成功写入: ${resolved} (${byteLength(content)} 字节)` }],
      };
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
          z.union([
            z.object({
              oldText: z.string().min(1).describe('要被替换的原始文本；必须唯一匹配'),
              newText: z.string().describe('替换后的新文本'),
            }),
            z.object({
              startLine: z.number().int().positive().describe('替换起始行号 (1-based)'),
              endLine: z.number().int().positive().describe('替换结束行号 (1-based，包含该行)'),
              newText: z.string().describe('替换后的新文本'),
            }),
          ])
        ).min(1).max(50).describe('替换操作列表'),
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
        if ('startLine' in edit && 'endLine' in edit) {
          const start = edit.startLine - 1;
          const end = edit.endLine;

          if (start < 0 || end > lines.length || start >= end) {
            return {
              content: [{ type: 'text', text: `编辑失败: 行号范围无效 (startLine=${edit.startLine}, endLine=${edit.endLine}, 文件共 ${lines.length} 行)` }],
              isError: true,
            };
          }

          lines.splice(start, end - start, ...edit.newText.split('\n'));
          appliedEdits.push(`行 ${edit.startLine}-${edit.endLine}: 替换了 ${end - start} 行`);
          content = lines.join('\n');
        } else {
          const joined = lines.join('\n');
          const count = joined.split(edit.oldText).length - 1;

          if (count === 0) {
            return {
              content: [{ type: 'text', text: `编辑失败: 未找到匹配的文本片段\n搜索内容:\n${edit.oldText}` }],
              isError: true,
            };
          }

          if (count > 1) {
            return {
              content: [{ type: 'text', text: `编辑失败: 文本片段匹配不唯一 (找到 ${count} 处)，请提供更多上下文或使用行号模式\n搜索内容:\n${edit.oldText}` }],
              isError: true,
            };
          }

          content = joined.replace(edit.oldText, edit.newText);
          lines = content.split('\n');
          appliedEdits.push('文本匹配: 替换了 1 处');
        }

        assertWritableContent(content);
      }

      await fs.writeFile(resolved, content, 'utf-8');

      return {
        content: [{ type: 'text', text: `文件已成功编辑: ${resolved}\n执行了 ${edits.length} 处替换:\n${appliedEdits.join('\n')}` }],
      };
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

      return {
        content: [{ type: 'text', text: `已成功删除: ${resolved}` }],
      };
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

      return {
        content: [{ type: 'text', text: `目录已创建: ${resolved}` }],
      };
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

      return {
        content: [{ type: 'text', text: `已移动: ${resolvedSrc} -> ${resolvedDst}` }],
      };
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

      const info = {
        path: resolved,
        type: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
        size: formatSize(stats.size),
        sizeBytes: stats.size,
        created: stats.birthtime.toISOString(),
        modified: stats.mtime.toISOString(),
        accessed: stats.atime.toISOString(),
        permissions: `0${(stats.mode & 0o777).toString(8)}`,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      };
    }
  );
}

// 辅助函数：递归列出目录
async function listDir(
  dirPath: string,
  recursive: boolean,
  depth: number,
  maxDepth: number
): Promise<string> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const indent = '  '.repeat(depth);
  const lines: string[] = [];

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

  for (const entry of sorted) {
    const prefix = entry.isDirectory() ? '📁 ' : '📄 ';
    lines.push(`${indent}${prefix}${entry.name}`);

    if (recursive && entry.isDirectory() && depth < maxDepth) {
      const subDir = path.join(dirPath, entry.name);
      try {
        assertPathAllowed(subDir);
        const subContent = await listDir(subDir, true, depth + 1, maxDepth);
        if (subContent) lines.push(subContent);
      } catch {
        lines.push(`${indent}  [权限不足，跳过]`);
      }
    }
  }

  return lines.join('\n');
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
