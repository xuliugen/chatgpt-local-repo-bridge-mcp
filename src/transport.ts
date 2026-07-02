import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

/**
 * 创建 Express 应用并配置 Streamable HTTP 传输层
 */
export function createApp(): express.Express {
  const app = express();

  // JSON body 解析
  app.use(express.json({ limit: '10mb' }));

  // CORS 配置
  app.use(
    cors({
      origin: config.allowedOrigins.includes('*')
        ? true
        : config.allowedOrigins,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: [
        'Content-Type',
        'Accept',
        'Authorization',
        'mcp-session-id',
        'last-event-id',
      ],
      exposedHeaders: ['mcp-session-id'],
      credentials: true,
    })
  );

  // 会话管理
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // ===== MCP POST 端点 =====
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // 复用已有的 transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // 新的初始化请求 - 创建新 transport
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            logger.info(`MCP 会话已初始化: ${sid}`);
            transports[sid] = transport;
          },
        });

        // 清理关闭的 transport
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.info(`MCP 会话已关闭: ${sid}`);
            delete transports[sid];
          }
        };

        // 创建 MCP Server 并连接
        const server = createMcpServer();
        await server.connect(transport);

        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        // 无效请求
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: 无效的会话 ID 或非初始化请求',
          },
          id: null,
        });
        return;
      }

      // 使用已有的 transport 处理请求
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('处理 MCP 请求时出错:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // ===== MCP GET 端点 (SSE 流) =====
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    logger.info(`建立 SSE 连接: session=${sessionId}`);

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // ===== MCP DELETE 端点 (终止会话) =====
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    logger.info(`终止会话: ${sessionId}`);

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error('终止会话时出错:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error processing session termination' });
      }
    }
  });

  // ===== 健康检查端点 =====
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      name: 'code-repo-mcp-server',
      version: '1.0.0',
      activeSessions: Object.keys(transports).length,
    });
  });

  // ===== 根路径信息 =====
  app.get('/', (_req, res) => {
    res.json({
      name: 'Code Repository MCP Server',
      description: 'MCP Server for code repository operations via ChatGPT',
      version: '1.0.0',
      endpoints: {
        mcp: 'POST/GET/DELETE /mcp - MCP Streamable HTTP endpoint',
        health: 'GET /health - Health check',
      },
      tools: [
        'list_directory', 'read_file', 'write_file', 'edit_file',
        'delete_file', 'create_directory', 'move_file', 'get_file_info',
        'search_files', 'search_content', 'get_file_tree',
        'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit',
        'git_branch', 'git_show', 'git_push', 'git_pull',
        'run_command',
      ],
    });
  });

  // 返回 app 和 transports 用于清理
  (app as any).__transports = transports;

  return app;
}
