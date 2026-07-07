import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFilesystemTools } from './tools/filesystem.js';
import { registerSearchTools } from './tools/search.js';
import { registerGitTools } from './tools/git.js';
import { registerTerminalTools } from './tools/terminal.js';
import { registerChangeTools } from './tools/changes.js';
import { registerWorkspaceTools } from './tools/workspace.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { installToolTiming } from './tool-timing.js';

function registerDefaultToolSet(server: McpServer): number {
  registerWorkspaceTools(server);
  logger.info('  - 工作区工具 (1 个 Tool)');

  registerFilesystemTools(server);
  logger.info('  - 文件系统工具 (8 个 Tools)');

  registerSearchTools(server);
  logger.info('  - 搜索工具 (3 个 Tools)');

  registerGitTools(server);
  logger.info('  - Git 工具 (9 个 Tools)');

  registerChangeTools(server);
  logger.info('  - 变更聚合工具 (1 个 Tool)');

  return 22;
}

function registerCompactToolSet(server: McpServer): number {
  registerWorkspaceTools(server);
  logger.info('  - 工作区工具 (1 个 Tool)');

  registerFilesystemTools(server);
  logger.info('  - 文件系统工具 (8 个 Tools)');

  registerSearchTools(server);
  logger.info('  - 搜索工具 (3 个 Tools)');

  registerChangeTools(server);
  logger.info('  - 变更聚合工具 (1 个 Tool)');

  logger.info('  - Git 工具已在 compact 模式隐藏；需要完整 Git 工具请设置 TOOL_MODE=full');
  return 13;
}

/**
 * 创建并配置 MCP Server
 * 注册所有 Tools
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'code-repo-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        logging: {},
      },
    }
  );
  installToolTiming(server);

  logger.info(`正在注册 MCP Tools... toolMode=${config.toolMode}`);

  const baseToolCount = config.toolMode === 'full'
    ? registerDefaultToolSet(server)
    : registerCompactToolSet(server);

  let terminalToolCount = 0;
  if (config.enableTerminal) {
    registerTerminalTools(server);
    terminalToolCount = 5;
    logger.warn('  - 终端工具 (5 个 Tools，已启用高风险命令执行能力)');
  } else {
    logger.info('  - 终端工具已禁用 (ENABLE_TERMINAL=false)');
  }

  logger.info(`共注册 ${baseToolCount + terminalToolCount} 个 MCP Tools`);

  return server;
}
