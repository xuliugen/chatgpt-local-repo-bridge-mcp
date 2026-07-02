import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';

/**
 * 路径安全守卫
 * - 确保文件操作在允许的工作区目录内
 * - 使用 realpath 防止 workspace 内 symlink 指向外部目录
 * - 阻止访问被排除目录和敏感文件
 */

interface WorkspaceMatch {
  configuredRoot: string;
  realRoot: string;
}

/**
 * 将输入路径解析为绝对路径
 */
export function resolvePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('路径不能为空');
  }

  // 支持 ~ 展开为 home 目录
  if (inputPath === '~' || inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith('~/')) {
    inputPath = path.join(process.env.HOME || process.env.USERPROFILE || '', inputPath.slice(1));
  }

  return path.resolve(inputPath);
}

function realpathIfExists(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function nearestExistingAncestor(targetPath: string): string | null {
  let current = path.resolve(targetPath);

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }

  return current;
}

function canonicalizeTarget(targetPath: string): string {
  const resolved = resolvePath(targetPath);
  const realExisting = realpathIfExists(resolved);
  if (realExisting) return realExisting;

  const ancestor = nearestExistingAncestor(resolved);
  if (!ancestor) return resolved;

  const ancestorReal = realpathIfExists(ancestor);
  if (!ancestorReal) return resolved;

  const suffix = path.relative(ancestor, resolved);
  return path.resolve(ancestorReal, suffix);
}

function canonicalizeWorkspace(workspace: string): string {
  const resolved = resolvePath(workspace);
  const real = realpathIfExists(resolved);
  if (!real) {
    throw new Error(`工作区目录不存在或不可访问: ${resolved}`);
  }
  return real;
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getMatchedWorkspace(targetPath: string): WorkspaceMatch | null {
  const canonicalTarget = canonicalizeTarget(targetPath);

  for (const workspace of config.workspaces) {
    const realRoot = canonicalizeWorkspace(workspace);
    if (isPathInside(canonicalTarget, realRoot)) {
      return { configuredRoot: workspace, realRoot };
    }
  }

  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function matchesSimpleGlob(fileName: string, pattern: string): boolean {
  const normalizedName = fileName.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  const regex = new RegExp(`^${escapeRegex(normalizedPattern).replace(/\*/g, '.*')}$`);
  return regex.test(normalizedName);
}

function assertFileNotExcluded(targetPath: string): void {
  if (config.excludedFilePatterns.length === 0) return;

  const baseName = path.basename(targetPath);
  const matchedPattern = config.excludedFilePatterns.find((pattern) =>
    matchesSimpleGlob(baseName, pattern)
  );

  if (matchedPattern) {
    throw new Error(
      `路径 "${targetPath}" 匹配被排除的敏感文件模式 "${matchedPattern}"。\n` +
        `被排除的文件模式: ${config.excludedFilePatterns.join(', ')}`
    );
  }
}

/**
 * 检查路径是否在允许的工作区内
 * @throws Error 如果路径越权
 */
export function assertPathAllowed(targetPath: string): void {
  const resolved = resolvePath(targetPath);
  const canonicalTarget = canonicalizeTarget(resolved);
  const matchedWorkspace = getMatchedWorkspace(resolved);

  if (!matchedWorkspace) {
    throw new Error(
      `路径 "${resolved}" 不在允许的工作区目录内。\n` +
        `允许的工作区: ${config.workspaces.join(', ')}`
    );
  }

  assertPathNotExcluded(canonicalTarget, matchedWorkspace.realRoot);
}

/**
 * 阻止危险操作直接作用于工作区根目录。
 */
export function assertNotWorkspaceRoot(targetPath: string, operation: string): void {
  const canonicalTarget = canonicalizeTarget(targetPath);

  for (const workspace of config.workspaces) {
    const realRoot = canonicalizeWorkspace(workspace);
    if (canonicalTarget === realRoot) {
      throw new Error(`${operation} 被拒绝: 不允许直接操作工作区根目录 "${workspace}"`);
    }
  }
}

/**
 * 检查路径是否包含被排除的目录段或敏感文件名
 * @throws Error 如果路径包含被排除目录或敏感文件
 */
export function assertPathNotExcluded(targetPath: string, workspaceRoot: string): void {
  const canonicalTarget = canonicalizeTarget(targetPath);

  if (config.excludedDirs.length > 0) {
    const relativePath = path.relative(workspaceRoot, canonicalTarget);
    if (relativePath && relativePath !== '.') {
      const segments = relativePath.split(path.sep);
      const excludedSet = new Set(config.excludedDirs);

      for (const segment of segments) {
        if (excludedSet.has(segment)) {
          throw new Error(
            `路径 "${targetPath}" 包含被排除的目录 "${segment}"。\n` +
              `被排除的目录: ${config.excludedDirs.join(', ')}`
          );
        }
      }
    }
  }

  assertFileNotExcluded(canonicalTarget);
}

/**
 * 检查目录名是否被排除 (用于遍历时过滤)
 */
export function isDirExcluded(dirName: string): boolean {
  return config.excludedDirs.includes(dirName);
}

/**
 * 检查文件名是否被排除 (用于遍历和搜索时过滤)
 */
export function isFileExcluded(fileName: string): boolean {
  return config.excludedFilePatterns.some((pattern) => matchesSimpleGlob(fileName, pattern));
}

/**
 * 检查路径是否存在
 */
export function pathExists(targetPath: string): boolean {
  try {
    fs.accessSync(resolvePath(targetPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取路径的类型信息
 */
export function getPathType(targetPath: string): 'file' | 'directory' | 'symlink' | 'unknown' {
  try {
    const stats = fs.lstatSync(resolvePath(targetPath));
    if (stats.isSymbolicLink()) return 'symlink';
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
