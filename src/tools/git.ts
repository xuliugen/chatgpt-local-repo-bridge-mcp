import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { simpleGit, SimpleGit } from 'simple-git';
import { assertPathAllowed, resolvePath } from '../utils/path-guard.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { destructiveLocalTool, destructiveRemoteTool, readOnlyLocalTool, writeLocalTool } from '../utils/tool-annotations.js';

/**
 * 获取 Git 实例
 */
function getGit(repoPath: string): SimpleGit {
  return simpleGit(repoPath);
}

function assertSafeRelativeGitPath(filePath: string): void {
  if (!filePath || filePath === '.') return;
  if (path.isAbsolute(filePath)) {
    throw new Error(`Git 文件路径必须是仓库内相对路径: ${filePath}`);
  }
  const normalized = path.normalize(filePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new Error(`Git 文件路径不能跳出仓库: ${filePath}`);
  }
  if (normalized.startsWith('-')) {
    throw new Error(`Git 文件路径不能以 '-' 开头: ${filePath}`);
  }
}

function assertSafeGitRef(ref: string, label: string): void {
  if (!ref || ref.length > 200) {
    throw new Error(`${label} 无效或过长`);
  }
  if (ref.startsWith('-') || /[\u0000-\u001f\s]/.test(ref)) {
    throw new Error(`${label} 包含不安全字符: ${ref}`);
  }
}

function assertSafeBranchName(branch: string, label: string): void {
  assertSafeGitRef(branch, label);

  // 避免把 branch 参数当作 Git refspec 使用，例如 ":remote-branch" 或 "main:other"。
  if (branch.includes(':')) {
    throw new Error(`${label} 不能包含 refspec 分隔符 ':': ${branch}`);
  }

  if (
    branch.includes('..') ||
    branch.includes('~') ||
    branch.includes('^') ||
    branch.includes('?') ||
    branch.includes('*') ||
    branch.includes('[') ||
    branch.includes('\\') ||
    branch.endsWith('.') ||
    branch.endsWith('/') ||
    branch.includes('@{') ||
    branch === '@'
  ) {
    throw new Error(`${label} 包含不安全的 Git ref 字符: ${branch}`);
  }
}

function assertSafeRemote(remote: string): void {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(remote)) {
    throw new Error(`远程仓库名包含不安全字符: ${remote}`);
  }
}

/**
 * 注册 Git 相关 Tools
 */
export function registerGitTools(server: McpServer): void {
  // 1. git_status - 查看仓库状态
  server.registerTool(
    'git_status',
    {
      title: 'Git Status',
      description: '查看 Git 仓库的当前状态，包括暂存区、未暂存的变更和未跟踪的文件。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
      },
    },
    async ({ repoPath }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);

      logger.info(`git_status: ${resolved}`);

      const git = getGit(resolved);
      const status = await git.status();

      const output = [
        `分支: ${status.current}`,
        status.tracking ? `远程追踪: ${status.tracking} (领先 ${status.ahead} / 落后 ${status.behind})` : '',
        '',
        status.staged.length > 0 ? `暂存的变更 (${status.staged.length}):` : '',
        ...status.staged.map((f) => `  + ${f}`),
        '',
        status.modified.length > 0 ? `已修改 (${status.modified.length}):` : '',
        ...status.modified.map((f) => `  ~ ${f}`),
        '',
        status.created.length > 0 ? `新增 (${status.created.length}):` : '',
        ...status.created.map((f) => `  + ${f}`),
        '',
        status.deleted.length > 0 ? `已删除 (${status.deleted.length}):` : '',
        ...status.deleted.map((f) => `  - ${f}`),
        '',
        status.not_added.length > 0 ? `未跟踪 (${status.not_added.length}):` : '',
        ...status.not_added.map((f) => `  ? ${f}`),
        '',
        status.conflicted.length > 0 ? `冲突 (${status.conflicted.length}):` : '',
        ...status.conflicted.map((f) => `  ! ${f}`),
      ];

      return {
        content: [{ type: 'text', text: output.filter(Boolean).join('\n') }],
      };
    }
  );

  // 2. git_diff - 查看变更 diff
  server.registerTool(
    'git_diff',
    {
      title: 'Git Diff',
      description: '查看文件的变更内容 (diff)。可以查看暂存区或工作区的变更。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
        staged: z.boolean().optional().describe('是否查看暂存区的变更，默认为 false (工作区)'),
        filePath: z.string().optional().describe('限定查看某个文件的 diff，必须是仓库内相对路径'),
      },
    },
    async ({ repoPath, staged, filePath }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);
      if (filePath) assertSafeRelativeGitPath(filePath);

      logger.info(`git_diff: ${resolved} (staged=${staged}, file=${filePath})`);

      const git = getGit(resolved);

      const args: string[] = [];
      if (staged) {
        args.push('--cached');
      }
      if (filePath) {
        args.push('--', filePath);
      }

      const diff = await git.diff(args);

      if (!diff.trim()) {
        return {
          content: [{ type: 'text', text: '没有检测到变更。' }],
        };
      }

      return {
        content: [{ type: 'text', text: diff }],
      };
    }
  );

  // 3. git_log - 查看提交历史
  server.registerTool(
    'git_log',
    {
      title: 'Git Log',
      description: '查看 Git 提交历史。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
        count: z.number().int().positive().max(100).optional().describe('显示的提交数量，默认为 10，最高 100'),
        filePath: z.string().optional().describe('限定查看某个文件的提交历史，必须是仓库内相对路径'),
      },
    },
    async ({ repoPath, count, filePath }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);
      if (filePath) assertSafeRelativeGitPath(filePath);

      logger.info(`git_log: ${resolved} (count=${count}, file=${filePath})`);

      const git = getGit(resolved);

      const options: Record<string, string | number> = {
        '--max-count': count ?? 10,
      };

      if (filePath) {
        options.file = filePath;
      }

      const log = await git.log(options);

      const output = log.all.map((entry) => {
        return [
          `commit ${entry.hash}`,
          `Author: ${entry.author_name} <${entry.author_email}>`,
          `Date:   ${entry.date}`,
          '',
          `    ${entry.message}`,
          '',
        ].join('\n');
      });

      return {
        content: [{ type: 'text', text: output.join('\n') }],
      };
    }
  );

  // 4. git_add - 暂存文件
  server.registerTool(
    'git_add',
    {
      title: 'Git Add',
      description: '将文件添加到 Git 暂存区。文件路径必须是仓库内相对路径；允许使用 "." 暂存全部变更。',
      annotations: writeLocalTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
        files: z.union([z.string(), z.array(z.string()).min(1).max(100)]).describe('要暂存的文件路径，可以是文件路径字符串或字符串数组，也可以用 "." 暂存所有变更'),
      },
    },
    async ({ repoPath, files }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);

      const filesArray = Array.isArray(files) ? files : [files];
      filesArray.forEach(assertSafeRelativeGitPath);

      logger.info(`git_add: ${resolved} files=${filesArray.join(', ')}`);

      const git = getGit(resolved);
      await git.add(filesArray);

      return {
        content: [{ type: 'text', text: `已将 ${filesArray.length} 个文件添加到暂存区:\n${filesArray.map((f) => `  + ${f}`).join('\n')}` }],
      };
    }
  );

  // 5. git_commit - 提交变更
  server.registerTool(
    'git_commit',
    {
      title: 'Git Commit',
      description: '提交暂存区的变更到本地仓库。',
      annotations: writeLocalTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
        message: z.string().min(1).max(500).describe('提交信息'),
      },
    },
    async ({ repoPath, message }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);

      logger.warn(`git_commit: ${resolved} messageLength=${message.length}`);

      const git = getGit(resolved);
      const result = await git.commit(message);

      return {
        content: [
          {
            type: 'text',
            text: `提交成功!\n分支: ${result.branch}\n提交哈希: ${result.commit}\n变更文件数: ${result.summary.changes}\n新增: ${result.summary.insertions}\n删除: ${result.summary.deletions}`,
          },
        ],
      };
    }
  );

  // 6. git_branch - 分支管理
  server.registerTool(
    'git_branch',
    {
      title: 'Git Branch',
      description: '管理 Git 分支：列出分支、创建新分支、切换分支或删除分支。由于包含删除动作，此工具标记为 destructive。',
      annotations: destructiveLocalTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
        action: z.enum(['list', 'create', 'switch', 'delete']).describe('操作类型: list(列出), create(创建), switch(切换), delete(删除)'),
        branchName: z.string().optional().describe('分支名称 (create/switch/delete 操作时需要)'),
      },
    },
    async ({ repoPath, action, branchName }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);

      if (action !== 'list') {
        if (!branchName) {
          return {
            content: [{ type: 'text', text: `${action} 分支需要提供 branchName 参数` }],
            isError: true,
          };
        }
        assertSafeBranchName(branchName, '分支名称');
      }

      logger.info(`git_branch: ${resolved} action=${action} branch=${branchName}`);

      const git = getGit(resolved);

      switch (action) {
        case 'list': {
          const branches = await git.branchLocal();
          const output = branches.all.map((b) =>
            b === branches.current ? `* ${b} (当前)` : `  ${b}`
          );
          return {
            content: [{ type: 'text', text: `本地分支:\n${output.join('\n')}` }],
          };
        }

        case 'create': {
          await git.checkoutLocalBranch(branchName!);
          return {
            content: [{ type: 'text', text: `已创建并切换到新分支: ${branchName}` }],
          };
        }

        case 'switch': {
          await git.checkout(branchName!);
          return {
            content: [{ type: 'text', text: `已切换到分支: ${branchName}` }],
          };
        }

        case 'delete': {
          await git.deleteLocalBranch(branchName!);
          return {
            content: [{ type: 'text', text: `已删除分支: ${branchName}` }],
          };
        }
      }
    }
  );

  // 7. git_show - 查看 commit 详情
  server.registerTool(
    'git_show',
    {
      title: 'Git Show',
      description: '查看指定提交的详细信息，包括提交消息和变更内容。',
      annotations: readOnlyLocalTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
        commitHash: z.string().min(1).max(200).describe('提交的哈希值或安全 ref (可以是完整哈希、简写或 HEAD~1)'),
      },
    },
    async ({ repoPath, commitHash }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);
      assertSafeGitRef(commitHash, '提交引用');

      logger.info(`git_show: ${resolved} commit=${commitHash}`);

      const git = getGit(resolved);
      const output = await git.raw(['show', commitHash]);

      return {
        content: [{ type: 'text', text: output }],
      };
    }
  );

  // 8. git_push - 推送到远程
  server.registerTool(
    'git_push',
    {
      title: 'Git Push',
      description: '将本地提交推送到远程仓库。默认禁止 force push，可通过 ALLOW_GIT_FORCE_PUSH=true 显式启用。',
      annotations: destructiveRemoteTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
        remote: z.string().optional().describe('远程仓库名，默认为 origin'),
        branch: z.string().optional().describe('远程分支名，默认为当前分支；必须是分支名，不能是 refspec'),
        force: z.boolean().optional().describe('是否强制推送 (慎用)，默认为 false，且需要 ALLOW_GIT_FORCE_PUSH=true'),
      },
    },
    async ({ repoPath, remote, branch, force }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);

      const remoteName = remote ?? 'origin';
      assertSafeRemote(remoteName);
      if (branch) assertSafeBranchName(branch, '远程分支名');

      if (force && !config.allowGitForcePush) {
        return {
          content: [{ type: 'text', text: '已拒绝 force push。若确实需要，请设置 ALLOW_GIT_FORCE_PUSH=true 后重启服务。' }],
          isError: true,
        };
      }

      logger.warn(`git_push: ${resolved} remote=${remoteName} branch=${branch ?? '(current)'} force=${force}`);

      const git = getGit(resolved);

      try {
        if (branch) {
          await git.push(remoteName, branch, force ? ['--force'] : []);
        } else {
          await git.push(remoteName, undefined, force ? ['--force'] : []);
        }

        return {
          content: [{ type: 'text', text: `已成功推送到 ${remoteName}${branch ? '/' + branch : ''}${force ? ' (force)' : ''}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `推送失败: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // 9. git_pull - 拉取远程变更
  server.registerTool(
    'git_pull',
    {
      title: 'Git Pull',
      description: '从远程仓库拉取变更并合并到当前分支。会修改工作区，因此标记为 destructive。',
      annotations: destructiveRemoteTool,
      inputSchema: {
        repoPath: z.string().describe('Git 仓库的路径'),
        remote: z.string().optional().describe('远程仓库名，默认为 origin'),
        branch: z.string().optional().describe('远程分支名，默认为当前分支；必须是分支名，不能是 refspec'),
        rebase: z.boolean().optional().describe('是否使用 rebase 代替 merge，默认为 false'),
      },
    },
    async ({ repoPath, remote, branch, rebase }): Promise<CallToolResult> => {
      const resolved = resolvePath(repoPath);
      assertPathAllowed(resolved);

      const remoteName = remote ?? 'origin';
      assertSafeRemote(remoteName);
      if (branch) assertSafeBranchName(branch, '远程分支名');

      logger.info(`git_pull: ${resolved} remote=${remoteName} branch=${branch ?? '(current)'} rebase=${rebase}`);

      const git = getGit(resolved);

      try {
        const result = await git.pull(remoteName, branch, rebase ? ['--rebase'] : []);

        return {
          content: [{
            type: 'text',
            text: `拉取成功!\n远程: ${remoteName}\n文件变更: ${result.summary.changes}\n新增: ${result.summary.insertions}\n删除: ${result.summary.deletions}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `拉取失败: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
