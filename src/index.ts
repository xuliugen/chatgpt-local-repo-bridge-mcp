import { createApp } from './transport.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

interface ManagedTransportRecord {
  transport: {
    close: () => Promise<void>;
  };
  lastSeen: number;
}

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
  logger.info(`排除文件: ${config.excludedFilePatterns.join(', ')}`);
  logger.info(`CORS 来源: ${config.allowedOrigins.join(', ')}`);
  logger.info(`认证: ${config.authToken ? '已启用' : '未启用'}`);
  logger.info(`终端工具: ${config.enableTerminal ? '已启用' : '已禁用'}`);
  logger.info('');

  // 创建并启动 Express 应用
  const app = createApp();

  const server = app.listen(config.port, () => {
    logger.info('');
    logger.info('MCP Server 已启动');
    logger.info('');
    logger.info(`  MCP 端点:    http://localhost:${config.port}/mcp`);
    logger.info(`  健康检查:    http://localhost:${config.port}/health`);
    logger.info(`  服务信息:    http://localhost:${config.port}/`);
    logger.info('');
    logger.info('在 ChatGPT 网页端中:');
    logger.info('  1. 进入 Settings -> Apps & Connectors -> Create');
    logger.info('  2. 输入公网 HTTPS URL，路径必须以 /mcp 结尾');
    logger.info(`  3. 本地调试端点: http://localhost:${config.port}/mcp`);
    logger.info('');
  });

  // 优雅关闭
  const shutdown = async () => {
    logger.info('');
    logger.info('正在关闭服务...');

    const transports = (app as any).__transports as Record<string, ManagedTransportRecord> | undefined;

    if (transports) {
      for (const sessionId in transports) {
        try {
          logger.info(`关闭会话: ${sessionId}`);
          await transports[sessionId].transport.close();
          delete transports[sessionId];
        } catch (error) {
          logger.error(`关闭会话 ${sessionId} 时出错:`, error);
        }
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
    }, 5000).unref?.();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('启动失败:', error);
  process.exit(1);
});
