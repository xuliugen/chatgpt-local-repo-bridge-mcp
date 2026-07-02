import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertPathAllowed, resolvePath, isDirExcluded } from '../utils/path-guard.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { glob } from 'glob';

const execAsync = promisify(exec);

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
  try {
    // 构建 rg 命令
    const args = [
      'rg',
      '--no-heading',
      '--line-number',
      '--max-count', String(limit),
      // 使用配置中的排除目录
      ...config.excludedDirs.flatMap((d) => ['--glob', `!${d}`]),
    ];

    if (filePattern) {
      args.push('--glob', filePattern);
    }

    // 用 shell 转义保护 pattern
    args.push('--', JSON.stringify(pattern));
    args.push(JSON.stringify(base));

    const command = args.join(' ');
    const { stdout } = await execAsync(command, {
      cwd: base,
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const matches = stdout.trim().split('\n').filter(Boolean);
    const lines = matches.map((line) => {
      // rg 输出格式: file:line:content
      const relativeLine = line.startsWith(base) ? path.relative(base, line) : line;
      return relativeLine;
    });

    const output = [
      `[搜索引擎: ripgrep]`,
      `搜索正则: ${pattern}`,
      `搜索目录: ${base}`,
      `文件过滤: ${filePattern || '(所有文件)'}`,
      `找到 ${matches.length} 处匹配:`,
      '',
      ...lines,
    ];

    return {
      content: [{ type: 'text', text: output.join('\n') }],
    };
  } catch (error) {
    const errMsg = (error as Error).message || '';
    // ENOENT 或 command not found 表示 rg 未安装
    if (errMsg.includes('ENOENT') || errMsg.includes('not found') || errMsg.includes('ENOENT')) {
      return null;
    }
    // rg 返回退出码 1 表示没有匹配结果 (不是错误)
    if (errMsg.includes('Command failed')) {
      return {
        content: [{
          type: 'text',
          text: `[搜索引擎: ripgrep]\n搜索正则: ${pattern}\n搜索目录: ${base}\n未找到匹配结果。`,
        }],
      };
    }
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
    ignore: config.excludedDirs.map((d) => `**/${d}/**`).concat(['**/*.lock']),
  });

  const results: string[] = [];
  let matchCount = 0;

  for (const file of files) {
    if (matchCount >= limit) break;
    try {
      const stats = await fs.stat(file);
      if (stats.size > 1024 * 1024) continue;

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
      // 跳过无法读取的文件
    }
  }

  const output = [
    `[搜索引擎: Node.js 内置 (建议安装 ripgrep 提升性能: brew install ripgrep)]`,
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
      inputSchema: {
        pattern: z.string().describe('文件名搜索模式 (glob 通配符)，例如: *.ts, **/*.tsx, src/**/*.go'),
        basePath: z.string().optional().describe('搜索的根目录路径，默认为工作区根目录'),
        maxResults: z.number().optional().describe('最大结果数量，默认为 100'),
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
        ignore: config.excludedDirs.map((d) => `**/${d}/**`),
      });

      const limit = maxResults ?? 100;
      const results = files.slice(0, limit);

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
      description: '在文件内容中搜索正则表达式匹配。优先使用 ripgrep (rg) 实现高性能搜索，若未安装则降级为 Node.js 内置搜索。返回匹配的文件和行号。',
      inputSchema: {
        regex: z.string().describe('搜索的正则表达式'),
        path: z.string().optional().describe('搜索的目录路径，默认为工作区根目录'),
        filePattern: z.string().optional().describe('限定搜索的文件类型 (glob)，如 *.ts, *.go'),
        maxResults: z.number().optional().describe('最大结果数量，默认为 50'),
      },
    },
    async ({ regex: pattern, path: searchPath, filePattern, maxResults }): Promise<CallToolResult> => {
      const base = resolvePath(searchPath || '.');
      assertPathAllowed(base);

      logger.info(`search_content: regex="${pattern}" base="${base}" filePattern="${filePattern}"`);

      const limit = maxResults ?? 50;

      // 优先尝试 ripgrep
      const rgResult = await tryRipgrep(pattern, base, filePattern, limit);
      if (rgResult !== null) {
        return rgResult;
      }

      // 降级为 Node.js 内置搜索
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
      inputSchema: {
        path: z.string().describe('目录路径'),
        maxDepth: z.number().optional().describe('最大递归深度，默认为 3'),
        showHidden: z.boolean().optional().describe('是否显示隐藏文件 (以.开头的)，默认为 false'),
      },
    },
    async ({ path: dirPath, maxDepth, showHidden }): Promise<CallToolResult> => {
      const resolved = resolvePath(dirPath);
      assertPathAllowed(resolved);

      logger.info(`get_file_tree: ${resolved} (maxDepth=${maxDepth ?? 3})`);

      const tree = await buildTree(resolved, maxDepth ?? 3, 0, showHidden ?? false);

      return {
        content: [{ type: 'text', text: `${resolved}\n${tree}` }],
      };
    }
  );
}

// 辅助函数：构建目录树
async function buildTree(
  dirPath: string,
  maxDepth: number,
  currentDepth: number,
  showHidden: boolean
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

  // 过滤隐藏文件
  if (!showHidden) {
    entries = entries.filter((e) => !e.name.startsWith('.'));
  }

  // 使用配置中的排除目录
  entries = entries.filter((e) => !isDirExcluded(e.name));

  // 排序
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  const indent = '│   '.repeat(currentDepth);

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const isLast = i === sorted.length - 1;
    const prefix = isLast ? '└── ' : '├── ';
    const name = entry.isDirectory() ? `${entry.name}/` : entry.name;

    lines.push(`${indent}${prefix}${name}`);

    if (entry.isDirectory()) {
      const subTree = await buildTree(
        path.join(dirPath, entry.name),
        maxDepth,
        currentDepth + 1,
        showHidden
      );
      if (subTree) {
        lines.push(subTree);
      }
    }
  }

  return lines.join('\n');
}
