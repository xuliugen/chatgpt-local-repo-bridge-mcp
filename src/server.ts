import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFilesystemTools } from './tools/filesystem.js';
import { registerSearchTools } from './tools/search.js';
import { registerGitTools } from './tools/git.js';
import { registerTerminalTools } from './tools/terminal.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

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

  logger.info('正在注册 MCP Tools...');

  registerFilesystemTools(server);
  logger.info('  - 文件系统工具 (8 个 Tools)');

  registerSearchTools(server);
  logger.info('  - 搜索工具 (3 个 Tools)');

  registerGitTools(server);
  logger.info('  - Git 工具 (9 个 Tools)');

  if (config.enableTerminal) {
    registerTerminalTools(server);
    logger.warn('  - 终端工具 (4 个 Tools，已启用高风险命令执行能力)');
  } else {
    logger.info('  - 终端工具已禁用 (ENABLE_TERMINAL=false)');
  }

  logger.info(`共注册 ${config.enableTerminal ? 24 : 20} 个 MCP Tools`);

  return server;
}
