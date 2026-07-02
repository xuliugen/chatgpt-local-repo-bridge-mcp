import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';

/**
 * 路径安全守卫
 * 确保所有文件操作都在允许的工作区目录内
 */

/**
 * 将输入路径解析为绝对路径
 */
export function resolvePath(inputPath: string): string {
  // 支持 ~ 展开为 home 目录
  if (inputPath.startsWith('~')) {
    inputPath = path.join(process.env.HOME || '', inputPath.slice(1));
  }
  return path.resolve(inputPath);
}

/**
 * 检查路径是否在允许的工作区内
 * @throws Error 如果路径越权
 */
export function assertPathAllowed(targetPath: string): void {
  const resolved = resolvePath(targetPath);

  // 第一步: 检查是否在工作区内
  const matchedWorkspace = config.workspaces.find((workspace) => {
    const normalizedTarget = resolved + path.sep;
    const normalizedWorkspace = workspace + path.sep;
    return (
      normalizedTarget.startsWith(normalizedWorkspace) ||
      resolved === workspace
    );
  });

  if (!matchedWorkspace) {
    throw new Error(
      `路径 "${resolved}" 不在允许的工作区目录内。\n` +
        `允许的工作区: ${config.workspaces.join(', ')}`
    );
  }

  // 第二步: 检查路径是否包含被排除的目录
  assertPathNotExcluded(resolved, matchedWorkspace);
}

/**
 * 检查路径是否包含被排除的目录段
 * @throws Error 如果路径包含被排除目录
 */
export function assertPathNotExcluded(targetPath: string, workspaceRoot: string): void {
  if (config.excludedDirs.length === 0) return;

  // 取工作区根之后的相对部分
  const relativePath = path.relative(workspaceRoot, targetPath);
  if (!relativePath || relativePath === '.') return;

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

/**
 * 检查目录名是否被排除 (用于遍历时过滤)
 */
export function isDirExcluded(dirName: string): boolean {
  return config.excludedDirs.includes(dirName);
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
