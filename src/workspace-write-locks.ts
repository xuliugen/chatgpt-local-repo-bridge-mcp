import { getWorkspaceRootForPath } from './utils/path-guard.js';
import { withWorkspaceWriteLocks } from './utils/workspace-lock.js';

type ToolHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type ToolInput = Record<string, unknown>;
type ToolLike = Record<PropertyKey, unknown>;

const WRAPPED_MARKER = Symbol.for('chatgpt-local-repo-bridge-mcp.workspaceWriteLocksWrapped');

export function installWorkspaceWriteLocks(server: unknown): void {
  const target = server as {
    registerTool?: (...args: unknown[]) => unknown;
    tool?: (...args: unknown[]) => unknown;
  };

  if (typeof target.registerTool === 'function' && !isWrapped(target.registerTool)) {
    const originalRegisterTool = target.registerTool.bind(target);
    const wrappedRegisterTool = ((...args: unknown[]) => {
      const toolName = typeof args[0] === 'string' ? args[0] : 'unknown_tool';
      const handlerIndex = findLastFunctionIndex(args);

      if (handlerIndex >= 0) {
        args[handlerIndex] = wrapToolHandler(toolName, args[handlerIndex] as ToolHandler);
      }

      return originalRegisterTool(...args);
    }) as typeof target.registerTool;

    markWrapped(wrappedRegisterTool);
    target.registerTool = wrappedRegisterTool;
  }

  if (typeof target.tool === 'function' && !isWrapped(target.tool)) {
    const originalTool = target.tool.bind(target);
    const wrappedTool = ((...args: unknown[]) => {
      const toolName = typeof args[0] === 'string' ? args[0] : 'unknown_tool';
      const handlerIndex = findLastFunctionIndex(args);

      if (handlerIndex >= 0) {
        args[handlerIndex] = wrapToolHandler(toolName, args[handlerIndex] as ToolHandler);
      }

      return originalTool(...args);
    }) as typeof target.tool;

    markWrapped(wrappedTool);
    target.tool = wrappedTool;
  }
}

function wrapToolHandler(toolName: string, handler: ToolHandler): ToolHandler {
  return async (...args: unknown[]) => {
    const roots = getWriteLockRoots(toolName, args[0]);

    if (roots.length === 0) {
      return await handler(...args);
    }

    return await withWorkspaceWriteLocks(roots, toolName, async () => await handler(...args));
  };
}

function getWriteLockRoots(toolName: string, rawInput: unknown): string[] {
  if (!isPlainObject(rawInput)) return [];

  const input = rawInput as ToolInput;

  switch (toolName) {
    case 'create_directory':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return rootsFromValues([input.path]);

    case 'move_file':
      return rootsFromValues([input.source, input.destination]);

    case 'git_add':
    case 'git_commit':
    case 'git_pull':
    case 'git_push':
      return rootsFromValues([input.repoPath]);

    case 'git_branch':
      return input.action === 'list' ? [] : rootsFromValues([input.repoPath]);

    default:
      return [];
  }
}

function rootsFromValues(values: unknown[]): string[] {
  const roots: string[] = [];

  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      roots.push(getWorkspaceRootForPath(value));
    }
  }

  return roots;
}

function findLastFunctionIndex(args: unknown[]): number {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (typeof args[index] === 'function') {
      return index;
    }
  }

  return -1;
}

function isPlainObject(value: unknown): value is ToolInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectLike(value: unknown): value is ToolLike {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isWrapped(fn: unknown): boolean {
  return Boolean(isObjectLike(fn) && fn[WRAPPED_MARKER]);
}

function markWrapped(fn: unknown): void {
  if (isObjectLike(fn)) {
    fn[WRAPPED_MARKER] = true;
  }
}
