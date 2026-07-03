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

interface FilePatternMatcher {
  pattern: string;
  regex: RegExp;
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

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function simpleGlobToRegex(pattern: string): RegExp {
  const normalizedPattern = pattern.toLowerCase();
  return new RegExp(`^${escapeRegex(normalizedPattern).replace(/\*/g, '.*')}$`);
}

const workspaceMatches: WorkspaceMatch[] = config.workspaces.map((workspace) => ({
  configuredRoot: workspace,
  realRoot: canonicalizeWorkspace(workspace),
}));

const excludedDirSet = new Set(config.excludedDirs);
const excludedFileMatchers: FilePatternMatcher[] = config.excludedFilePatterns.map((pattern) => ({
  pattern,
  regex: simpleGlobToRegex(pattern),
}));

function getMatchedWorkspace(canonicalTarget: string): WorkspaceMatch | null {
  for (const workspace of workspaceMatches) {
    if (isPathInside(canonicalTarget, workspace.realRoot)) {
      return workspace;
    }
  }

  return null;
}

function matchesFilePattern(fileName: string, matcher: FilePatternMatcher): boolean {
  return matcher.regex.test(fileName.toLowerCase());
}

function assertFileNotExcluded(targetPath: string): void {
  if (excludedFileMatchers.length === 0) return;

  const baseName = path.basename(targetPath);
  const matched = excludedFileMatchers.find((matcher) => matchesFilePattern(baseName, matcher));

  if (matched) {
    throw new Error(
      `路径 "${targetPath}" 匹配被排除的敏感文件模式 "${matched.pattern}"。\n` +
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
  const matchedWorkspace = getMatchedWorkspace(canonicalTarget);

  if (!matchedWorkspace) {
    throw new Error(
      `路径 "${resolved}" 不在允许的工作区目录内。\n` +
        `允许的工作区: ${config.workspaces.join(', ')}`
    );
  }

  assertPathNotExcluded(canonicalTarget, matchedWorkspace.realRoot, true);
}

/**
 * 阻止危险操作直接作用于工作区根目录。
 */
export function assertNotWorkspaceRoot(targetPath: string, operation: string): void {
  const canonicalTarget = canonicalizeTarget(targetPath);

  for (const workspace of workspaceMatches) {
    if (canonicalTarget === workspace.realRoot) {
      throw new Error(`${operation} 被拒绝: 不允许直接操作工作区根目录 "${workspace.configuredRoot}"`);
    }
  }
}

/**
 * 检查路径是否包含被排除的目录段或敏感文件名
 * @throws Error 如果路径包含被排除目录或敏感文件
 */
export function assertPathNotExcluded(
  targetPath: string,
  workspaceRoot: string,
  alreadyCanonical = false
): void {
  const canonicalTarget = alreadyCanonical ? targetPath : canonicalizeTarget(targetPath);

  if (excludedDirSet.size > 0) {
    const relativePath = path.relative(workspaceRoot, canonicalTarget);
    if (relativePath && relativePath !== '.') {
      const segments = relativePath.split(path.sep);

      for (const segment of segments) {
        if (excludedDirSet.has(segment)) {
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
  return excludedDirSet.has(dirName);
}

/**
 * 检查文件名是否被排除 (用于遍历和搜索时过滤)
 */
export function isFileExcluded(fileName: string): boolean {
  return excludedFileMatchers.some((matcher) => matchesFilePattern(fileName, matcher));
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
