import { createApp } from './transport.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

/**
 * MCP Code Repository Server 入口
 */
async function main(): Promise<void> {
  logger.info('========================================');
  logger.info('  Code Repository MCP Server');
  logger.info('========================================');

  // 打印配置信息
  logger.info(`端口: ${config.port}`);
  logger.info(`工作区: ${config.workspaces.join(', ')}`);
  logger.info(`排除目录: ${config.excludedDirs.join(', ')}`);
  logger.info(`CORS 来源: ${config.allowedOrigins.join(', ')}`);
  logger.info('');

  // 创建并启动 Express 应用
  const app = createApp();

  const server = app.listen(config.port, () => {
    logger.info('');
    logger.info(`MCP Server 已启动!`);
    logger.info('');
    logger.info(`  MCP 端点:    http://localhost:${config.port}/mcp`);
    logger.info(`  健康检查:    http://localhost:${config.port}/health`);
    logger.info(`  服务信息:    http://localhost:${config.port}/`);
    logger.info('');
    logger.info('在 ChatGPT 网页端中:');
    logger.info(`  1. 进入设置 -> 连接器 -> 添加 MCP 服务器`);
    logger.info(`  2. 选择 "Streamable HTTP" 类型`);
    logger.info(`  3. 输入 URL: http://localhost:${config.port}/mcp`);
    logger.info('');
  });

  // 优雅关闭
  const shutdown = async () => {
    logger.info('');
    logger.info('正在关闭服务...');

    // 关闭所有活跃的 transport
    const transports = (app as any).__transports as Record<
      string,
      { close: () => Promise<void> }
    >;

    for (const sessionId in transports) {
      try {
        logger.info(`关闭会话: ${sessionId}`);
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        logger.error(`关闭会话 ${sessionId} 时出错:`, error);
      }
    }

    server.close(() => {
      logger.info('服务已关闭');
      process.exit(0);
    });

    // 强制退出 (如果 5 秒内没有正常关闭)
    setTimeout(() => {
      logger.warn('强制退出...');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('启动失败:', error);
  process.exit(1);
});
