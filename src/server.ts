import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFilesystemTools } from './tools/filesystem.js';
import { registerSearchTools } from './tools/search.js';
import { registerGitTools } from './tools/git.js';
import { registerTerminalTools } from './tools/terminal.js';
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

  // 注册文件系统工具
  registerFilesystemTools(server);
  logger.info('  - 文件系统工具 (8 个 Tools)');

  // 注册搜索工具
  registerSearchTools(server);
  logger.info('  - 搜索工具 (3 个 Tools)');

  // 注册 Git 工具
  registerGitTools(server);
  logger.info('  - Git 工具 (9 个 Tools)');

  // 注册终端工具
  registerTerminalTools(server);
  logger.info('  - 终端工具 (1 个 Tool)');

  logger.info('共注册 21 个 MCP Tools');

  return server;
}
