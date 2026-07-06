import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertPathAllowed, resolvePath, isDirExcluded, isFileExcluded } from '../utils/path-guard.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { glob } from 'glob';
import { readOnlyLocalTool } from '../utils/tool-annotations.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TREE_MAX_ENTRIES = 300;
const MAX_TREE_ENTRIES = 1000;

interface TreeBuildState {
  maxEntries: number;
  entriesShown: number;
  truncated: boolean;
  omittedEntries: number;
}

function normalizeLimit(maxResults: number | undefined, defaultValue: number, maxValue: number): number {
  const value = maxResults ?? defaultValue;
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(Math.floor(value), 1), maxValue);
}

function validateSearchPattern(pattern: string): string | null {
  if (!pattern.trim()) return '搜索正则不能为空';
  if (pattern.length > 500) return '搜索正则过长，已拒绝';
  return null;
}

/**
 * 尝试使用 ripgrep 搜索 (高性能)
 * @returns 成功返回 CallToolResult，ripgrep 不可用返回 null
 */
async function tryRipgrep(
  pattern: string,
  base: string,
  filePattern: string | undefined,
  limit: number
): Promise<CallToolResult | null> {
  const args = [
    '--no-heading',
    '--line-number',
    '--max-count', String(limit),
    ...config.traversalIgnoredDirs.flatMap((d) => ['--glob', `!**/${d}/**`]),
    ...config.excludedFilePatterns.flatMap((p) => ['--glob', `!${p}`]),
    ...config.excludedFilePatterns.flatMap((p) => ['--glob', `!**/${p}`]),
  ];

  if (filePattern) {
    args.push('--glob', filePattern);
  }

  args.push('--', pattern, base);

  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd: base,
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });

    const matches = stdout.trim().split('\n').filter(Boolean);
    const shownMatches = matches.slice(0, limit);
    const lines = shownMatches.map((line) => {
      const relativeLine = line.startsWith(base) ? path.relative(base, line) : line;
      return relativeLine;
    });
    const truncated = matches.length > shownMatches.length;

    const output = [
      '[搜索引擎: ripgrep]',
      `搜索正则: ${pattern}`,
      `搜索目录: ${base}`,
      `文件过滤: ${filePattern || '(所有文件)'}`,
      `找到 ${matches.length} 处匹配${truncated ? ` (显示前 ${shownMatches.length} 处)` : ''}:`,
      '',
      ...lines,
    ];

    return {
      content: [{ type: 'text', text: output.join('\n') }],
    };
  } catch (error) {
    const execError = error as Error & { code?: unknown; stdout?: string };

    // ripgrep 退出码 1 表示没有匹配结果。
    if (execError.code === 1) {
      return {
        content: [{
          type: 'text',
          text: `[搜索引擎: ripgrep]\n搜索正则: ${pattern}\n搜索目录: ${base}\n未找到匹配结果。`,
        }],
      };
    }

    // Windows / macOS / Linux 下命令不存在都交给 Node fallback。
    if (execError.code === 'ENOENT') {
      return null;
    }

    logger.warn(`ripgrep 执行失败，降级为 Node.js 搜索: ${execError.message}`);
    return null;
  }
}

/**
 * Node.js 内置降级搜索
 */
async function nodeFallbackSearch(
  pattern: string,
  base: string,
  filePattern: string | undefined,
  limit: number
): Promise<CallToolResult> {
  let searchRegex: RegExp;
  try {
    searchRegex = new RegExp(pattern, 'g');
  } catch (e) {
    return {
      content: [{ type: 'text', text: `无效的正则表达式: ${pattern}\n错误: ${(e as Error).message}` }],
      isError: true,
    };
  }

  const fileGlob = filePattern || '**/*';
  const files = await glob(fileGlob, {
    cwd: base,
    absolute: true,
    nodir: true,
    ignore: config.traversalIgnoredDirs
      .map((d) => `**/${d}/**`)
      .concat(config.excludedFilePatterns)
      .concat(config.excludedFilePatterns.map((p) => `**/${p}`))
      .concat(['**/*.lock']),
  });

  const results: string[] = [];
  let matchCount = 0;

  for (const file of files) {
    if (matchCount >= limit) break;
    try {
      assertPathAllowed(file);
      const stats = await fs.stat(file);
      if (!stats.isFile() || isFileExcluded(path.basename(file)) || stats.size > Math.min(config.maxReadBytes, 1024 * 1024)) continue;

      const content = await fs.readFile(file, 'utf-8');
      const fileLines = content.split('\n');

      for (let i = 0; i < fileLines.length; i++) {
        if (matchCount >= limit) break;
        searchRegex.lastIndex = 0;
        if (searchRegex.test(fileLines[i])) {
          const relativePath = path.relative(base, file);
          results.push(`${relativePath}:${i + 1}: ${fileLines[i].trim()}`);
          matchCount++;
        }
      }
    } catch {
      // 跳过无法读取或越权的文件
    }
  }

  const output = [
    '[搜索引擎: Node.js 内置]',
    '提示: 安装 ripgrep 可提升大仓库搜索性能。',
    `搜索正则: ${pattern}`,
    `搜索目录: ${base}`,
    `文件过滤: ${filePattern || '(所有文件)'}`,
    `找到 ${matchCount} 处匹配:`,
    '',
    ...results,
  ];

  return {
    content: [{ type: 'text', text: output.join('\n') }],
  };
}

/**
 * 注册搜索相关 Tools
 */
export function registerSearchTools(server: McpServer): void {
  // 1. search_files - 按文件名模式搜索 (glob)
  server.registerTool(
    'search_files',
    {
      title: 'Search Files',
      description: '按文件名模式搜索文件，支持 glob 通配符 (如 *.ts, **/*.js)。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        pattern: z.string().min(1).max(300).describe('文件名搜索模式 (glob 通配符)，例如: *.ts, **/*.tsx, src/**/*.go'),
        basePath: z.string().optional().describe('搜索的根目录路径，默认为工作区根目录'),
        maxResults: z.number().int().positive().optional().describe('最大结果数量，默认为 100，最高 500'),
      },
    },
    async ({ pattern, basePath, maxResults }): Promise<CallToolResult> => {
      const base = resolvePath(basePath || '.');
      assertPathAllowed(base);

      logger.info(`search_files: pattern="${pattern}" base="${base}"`);

      const files = await glob(pattern, {
        cwd: base,
        absolute: true,
        nodir: true,
        ignore: config.traversalIgnoredDirs
          .map((d) => `**/${d}/**`)
          .concat(config.excludedFilePatterns)
          .concat(config.excludedFilePatterns.map((p) => `**/${p}`)),
      });

      const limit = normalizeLimit(maxResults, 100, 500);
      const results = files.slice(0, limit).filter((file) => {
        try {
          assertPathAllowed(file);
          return !isFileExcluded(path.basename(file));
        } catch {
          return false;
        }
      });

      const output = [
        `搜索模式: ${pattern}`,
        `搜索目录: ${base}`,
        `找到 ${files.length} 个匹配文件${files.length > limit ? ` (显示前 ${limit} 个)` : ''}:`,
        '',
        ...results,
      ];

      return {
        content: [{ type: 'text', text: output.join('\n') }],
      };
    }
  );

  // 2. search_content - 按内容正则搜索 (优先使用 ripgrep)
  server.registerTool(
    'search_content',
    {
      title: 'Search Content',
      description: '在文件内容中搜索正则表达式匹配。优先使用 ripgrep，若未安装则降级为 Node.js 内置搜索。返回匹配的文件和行号。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        regex: z.string().min(1).max(500).describe('搜索的正则表达式'),
        path: z.string().optional().describe('搜索的目录路径，默认为工作区根目录'),
        filePattern: z.string().max(300).optional().describe('限定搜索的文件类型 (glob)，如 *.ts, *.go'),
        maxResults: z.number().int().positive().optional().describe('最大结果数量，默认为 50，最高 500'),
      },
    },
    async ({ regex: pattern, path: searchPath, filePattern, maxResults }): Promise<CallToolResult> => {
      const validationError = validateSearchPattern(pattern);
      if (validationError) {
        return {
          content: [{ type: 'text', text: validationError }],
          isError: true,
        };
      }

      const base = resolvePath(searchPath || '.');
      assertPathAllowed(base);

      logger.info(`search_content: regex="${pattern}" base="${base}" filePattern="${filePattern}"`);

      const limit = normalizeLimit(maxResults, 50, 500);

      const rgResult = await tryRipgrep(pattern, base, filePattern, limit);
      if (rgResult !== null) {
        return rgResult;
      }

      logger.info('ripgrep 不可用，降级为 Node.js 内置搜索');
      return await nodeFallbackSearch(pattern, base, filePattern, limit);
    }
  );

  // 3. get_file_tree - 获取目录树结构
  server.registerTool(
    'get_file_tree',
    {
      title: 'Get File Tree',
      description: '获取目录的树形结构，类似 tree 命令。用于了解项目结构。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        path: z.string().describe('目录路径'),
        maxDepth: z.number().int().positive().max(10).optional().describe('最大递归深度，默认为 3，最高 10'),
        showHidden: z.boolean().optional().describe('是否显示隐藏文件 (以.开头的)，默认为 false'),
        maxEntries: z.number().int().positive().max(MAX_TREE_ENTRIES).optional().describe('最大返回条目数，默认为 300，最高 1000'),
      },
    },
    async ({ path: dirPath, maxDepth, showHidden, maxEntries }): Promise<CallToolResult> => {
      const resolved = resolvePath(dirPath);
      assertPathAllowed(resolved);

      const depthLimit = maxDepth ?? 3;
      const entryLimit = normalizeLimit(maxEntries, DEFAULT_TREE_MAX_ENTRIES, MAX_TREE_ENTRIES);
      logger.info(`get_file_tree: ${resolved} (maxDepth=${depthLimit}, maxEntries=${entryLimit})`);

      const state: TreeBuildState = {
        maxEntries: entryLimit,
        entriesShown: 0,
        truncated: false,
        omittedEntries: 0,
      };
      const tree = await buildTree(resolved, depthLimit, 0, showHidden ?? false, state);

      return {
        content: [{
          type: 'text',
          text: [
            'summary: 文件树构建完成',
            'ok: true',
            'type: file_tree',
            `path: ${resolved}`,
            `maxDepth: ${depthLimit}`,
            `showHidden: ${showHidden ?? false}`,
            `entriesShown: ${state.entriesShown}`,
            `maxEntries: ${entryLimit}`,
            `truncated: ${state.truncated}`,
            `omittedEntries: ${state.omittedEntries}`,
            '',
            '[tree]',
            tree || '(空目录)',
          ].join('\n'),
        }],
      };
    }
  );
}

// 辅助函数：构建目录树
async function buildTree(
  dirPath: string,
  maxDepth: number,
  currentDepth: number,
  showHidden: boolean,
  state: TreeBuildState
): Promise<string> {
  if (currentDepth >= maxDepth) {
    return '';
  }

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return '';
  }

  if (!showHidden) {
    entries = entries.filter((e) => !e.name.startsWith('.'));
  }

  entries = entries.filter((e) => {
    if (e.isDirectory() && isDirExcluded(e.name)) return false;
    if (e.isFile() && isFileExcluded(e.name)) return false;
    return true;
  });

  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  const indent = '│   '.repeat(currentDepth);

  for (let i = 0; i < sorted.length; i++) {
    if (state.entriesShown >= state.maxEntries) {
      state.truncated = true;
      state.omittedEntries += sorted.length - i;
      break;
    }

    const entry = sorted[i];
    const isLast = i === sorted.length - 1;
    const prefix = isLast ? '└── ' : '├── ';
    const name = entry.isDirectory() ? `${entry.name}/` : entry.name;

    lines.push(`${indent}${prefix}${name}`);
    state.entriesShown += 1;

    if (entry.isDirectory()) {
      const subDir = path.join(dirPath, entry.name);
      try {
        assertPathAllowed(subDir);
        const subTree = await buildTree(subDir, maxDepth, currentDepth + 1, showHidden, state);
        if (subTree) {
          lines.push(subTree);
        }
      } catch {
        lines.push(`${indent}│   [权限不足，跳过]`);
      }
    }
  }

  return lines.join('\n');
}
