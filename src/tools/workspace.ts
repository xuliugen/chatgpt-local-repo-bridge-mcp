import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertPathAllowed, resolvePath } from '../utils/path-guard.js';
import { config } from '../config.js';
import { readOnlyLocalTool } from '../utils/tool-annotations.js';
import { structuredResult } from '../utils/tool-result.js';

function workspaceIdFor(resolvedPath: string): string {
  return `ws_${createHash('sha256').update(resolvedPath).digest('hex').slice(0, 16)}`;
}

function relativeWorkspacePath(resolvedPath: string): string {
  const workspace = config.workspaces.find((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`));
  return workspace ? path.relative(workspace, resolvedPath) || '.' : resolvedPath;
}

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool(
    'open_workspace',
    {
      title: 'Open Workspace',
      description:
        '打开并确认一个允许访问的工作区，返回 workspaceId、根路径和相对路径提示。用于减少后续工具重复传绝对路径。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        path: z.string().describe('要打开的工作区或其子路径'),
      },
    },
    async ({ path: workspacePath }): Promise<CallToolResult> => {
      const resolved = resolvePath(workspacePath);
      assertPathAllowed(resolved);
      const root = config.workspaces.find((candidate) => resolved === candidate || resolved.startsWith(`${candidate}${path.sep}`)) ?? resolved;
      const workspaceId = workspaceIdFor(root);

      return structuredResult({
        summary: '工作区已打开',
        fields: {
          ok: true,
          type: 'open_workspace',
          workspaceId,
          root,
          requestedPath: resolved,
          relativePath: relativeWorkspacePath(resolved),
          allowedWorkspaceRoots: config.workspaces,
          nextHint: '后续文件、搜索、Git 和命令工具仍可使用绝对路径；UI 卡片可用 workspaceId 聚合展示。',
        },
        meta: {
          tool: 'open_workspace',
          card: {
            kind: 'workspace',
            workspaceId,
            root,
          },
        },
      });
    }
  );
}
