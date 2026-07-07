import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { simpleGit } from 'simple-git';
import { assertPathAllowed, resolvePath } from '../utils/path-guard.js';
import { readOnlyLocalTool } from '../utils/tool-annotations.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { previewText, structuredResult } from '../utils/tool-result.js';

const DEFAULT_PATCH_PREVIEW_CHARS = 24 * 1024;
const MAX_PATCH_PREVIEW_CHARS = 64 * 1024;

function normalizePreviewChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PATCH_PREVIEW_CHARS;
  return Math.min(Math.max(Math.floor(value), 1024), MAX_PATCH_PREVIEW_CHARS);
}

function parseNumstat(numstat: string): Array<{ file: string; additions: number | null; deletions: number | null; status?: 'tracked' | 'untracked' }> {
  return numstat
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, ...fileParts] = line.split('\t');
      return {
        file: fileParts.join('\t'),
        additions: additions === '-' ? null : Number(additions),
        deletions: deletions === '-' ? null : Number(deletions),
      };
    });
}

function summarizeFiles(files: Array<{ file: string; additions: number | null; deletions: number | null; status?: 'tracked' | 'untracked' }>): string {
  if (files.length === 0) return '(无文件变更)';
  return files
    .map((file) => {
      if (file.status === 'untracked') {
        return `${file.file} (untracked; patch not included)`;
      }
      const additions = file.additions === null ? 'binary' : `+${file.additions}`;
      const deletions = file.deletions === null ? 'binary' : `-${file.deletions}`;
      return `${file.file} (${additions} ${deletions})`;
    })
    .join('\n');
}

export function registerChangeTools(server: McpServer): void {
  server.registerTool(
    'show_changes',
    {
      title: 'Show Changes',
      description:
        '聚合展示当前 Git 工作区变更摘要和 diff 预览。用于一轮修改结束后的统一 review，避免每个文件修改都刷长 diff。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库路径'),
        staged: z.boolean().optional().describe('是否展示暂存区变更，默认为 false'),
        maxPatchChars: z.number().int().positive().max(MAX_PATCH_PREVIEW_CHARS).optional().describe('diff 预览最大字符数，默认 24576，最高 65536'),
      },
    },
    async ({ repoPath, staged, maxPatchChars }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);
      logger.info(`show_changes: ${resolved} staged=${staged}`);

      const git = simpleGit(resolved);
      const previewLimit = normalizePreviewChars(maxPatchChars);
      const diffArgs = staged ? ['--cached'] : [];
      const numstatArgs = staged ? ['--cached', '--numstat'] : ['--numstat'];

      const [status, diff, numstat] = await Promise.all([
        git.status(),
        git.diff(diffArgs),
        git.diff(numstatArgs),
      ]);
      const trackedFiles = parseNumstat(numstat);
      const untrackedFiles = status.not_added.map((file) => ({
        file,
        additions: null,
        deletions: null,
        status: 'untracked' as const,
      }));
      const files = [...trackedFiles, ...untrackedFiles];
      const patch = previewText(diff, previewLimit);
      const changedFileCount = files.length;
      const branch = status.current;

      const fullDiffHint = config.toolMode === 'full'
        ? '如需完整 diff，请使用 git_diff 指定 filePath 或提高 maxPatchChars。'
        : '如需完整 diff，请提高 maxPatchChars，或切换 TOOL_MODE=full 后使用 git_diff。';

      return structuredResult({
        summary: changedFileCount === 0 ? '未检测到变更' : '变更聚合完成',
        fields: {
          ok: true,
          type: 'show_changes',
          repoPath: resolved,
          branch,
          staged: staged ?? false,
          changedFileCount,
          trackedFileCount: trackedFiles.length,
          untrackedFileCount: untrackedFiles.length,
          patchScope: 'tracked changes only; untracked files are listed but their file contents are not included in patchPreview',
          patchChars: diff.length,
          patchPreviewChars: patch.preview.length,
          maxPatchChars: previewLimit,
          patchTruncated: patch.truncated,
          omittedPatchChars: patch.omittedChars,
          nextHint: untrackedFiles.length > 0
            ? `存在未跟踪文件；patchPreview 不包含其内容，请显式 read_file 读取未跟踪文件。${patch.truncated ? `同时 diff 预览已截断；${fullDiffHint}` : ''}`
            : patch.truncated
              ? `diff 预览已截断；${fullDiffHint}`
              : 'diff 预览未截断；可基于 files 和 patchPreview 做统一 review。',
        },
        sections: [
          { label: 'files', text: summarizeFiles(files) },
          { label: 'patchPreview', text: patch.preview || '(无 diff)' },
        ],
        meta: {
          tool: 'show_changes',
          card: {
            kind: 'changes_review',
            repoPath: resolved,
            branch,
            changedFileCount,
            patchTruncated: patch.truncated,
          },
        },
      });
    }
  );
}
