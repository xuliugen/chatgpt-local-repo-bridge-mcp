import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { protectedResourceMetadata, requireOAuth } from './auth/oauth.js';

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

interface RateLimitRecord {
  windowStartedAt: number;
  count: number;
}

function clientKey(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function mcpSessionId(req: express.Request): string | undefined {
  const value = req.headers['mcp-session-id'];
  if (Array.isArray(value)) return value[0];
  return value;
}

function shortSessionId(sessionId: string | undefined): string {
  if (!sessionId) return 'none';
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

function toolNamesFromBody(body: unknown): string[] {
  const items = Array.isArray(body) ? body : [body];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const jsonRpc = item as {
        method?: unknown;
        params?: {
          name?: unknown;
        };
      };
      if (jsonRpc.method === 'tools/call' && typeof jsonRpc.params?.name === 'string') {
        return jsonRpc.params.name;
      }
      if (typeof jsonRpc.method === 'string') {
        return jsonRpc.method;
      }
      return undefined;
    })
    .filter((name): name is string => Boolean(name));
}

/**
 * 创建 Express 应用并配置 Streamable HTTP 传输层
 */
export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // JSON body 解析
  app.use(express.json({ limit: '2mb' }));

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

  const transports: Record<string, SessionRecord> = {};
  const rateLimits: Record<string, RateLimitRecord> = {};

  function cleanupSessions(): void {
    const now = Date.now();
    for (const [sessionId, record] of Object.entries(transports)) {
      if (now - record.lastSeen > config.sessionTtlMs) {
        logger.warn(`MCP 会话已超时，正在关闭: ${sessionId}`);
        void record.transport.close().catch((error) => {
          logger.error(`关闭超时会话 ${sessionId} 时出错:`, error);
        });
        delete transports[sessionId];
      }
    }
  }

  const cleanupTimer = setInterval(cleanupSessions, Math.min(config.sessionTtlMs, 60_000));
  cleanupTimer.unref?.();

  function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const key = clientKey(req);
    const now = Date.now();
    const record = rateLimits[key];

    if (!record || now - record.windowStartedAt > config.rateLimitWindowMs) {
      rateLimits[key] = { windowStartedAt: now, count: 1 };

      // 顺手清理过期来源，避免长期公网暴露时 rateLimits 无界增长。
      for (const [storedKey, storedRecord] of Object.entries(rateLimits)) {
        if (now - storedRecord.windowStartedAt > config.rateLimitWindowMs) {
          delete rateLimits[storedKey];
        }
      }

      next();
      return;
    }

    record.count += 1;
    if (record.count > config.rateLimitMax) {
      res.status(429).json({ error: 'Too many MCP requests' });
      return;
    }

    next();
  }

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    if (!config.oauthEnabled) {
      res.status(404).json({ error: 'OAuth is not enabled' });
      return;
    }

    res.json(protectedResourceMetadata());
  });

  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    if (!config.oauthEnabled) {
      res.status(404).json({ error: 'OAuth is not enabled' });
      return;
    }

    res.json(protectedResourceMetadata());
  });

  app.use('/mcp', (req, res, next) => {
    const startedAt = Date.now();
    const sessionId = mcpSessionId(req);
    const requestId = randomUUID().slice(0, 8);
    const tools = req.method === 'POST' ? toolNamesFromBody(req.body) : [];
    const toolSummary = tools.length > 0 ? ` tools=${tools.join(',')}` : '';

    logger.info(
      `MCP 请求开始: id=${requestId} method=${req.method} path=${req.originalUrl} session=${shortSessionId(sessionId)} ip=${clientKey(req)}${toolSummary}`
    );

    let logged = false;
    const logEnd = (event: 'finish' | 'close') => {
      if (logged) return;
      logged = true;
      logger.info(
        `MCP 请求结束: id=${requestId} event=${event} status=${res.statusCode} durationMs=${Date.now() - startedAt} session=${shortSessionId(sessionId)}`
      );
    };

    res.once('finish', () => logEnd('finish'));
    res.once('close', () => logEnd('close'));

    next();
  });

  app.use('/mcp', rateLimit);
  app.use('/mcp', requireOAuth);

  // ===== MCP POST 端点 =====
  app.post('/mcp', async (req, res) => {
    const sessionId = mcpSessionId(req);

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transports[sessionId].lastSeen = Date.now();
        transport = transports[sessionId].transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        cleanupSessions();

        if (Object.keys(transports).length >= config.maxSessions) {
          res.status(503).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Too many active MCP sessions',
            },
            id: null,
          });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            logger.info(`MCP 会话已初始化: ${sid}`);
            transports[sid] = { transport, lastSeen: Date.now() };
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.info(`MCP 会话已关闭: ${sid}`);
            delete transports[sid];
          }
        };

        const server = createMcpServer();
        await server.connect(transport);

        await transport.handleRequest(req as any, res, req.body);
        return;
      } else {
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

      await transport.handleRequest(req as any, res, req.body);
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
    const sessionId = mcpSessionId(req);

    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    logger.info(`建立 SSE 连接: session=${sessionId}`);

    try {
      transports[sessionId].lastSeen = Date.now();
      const transport = transports[sessionId].transport;
      await transport.handleRequest(req as any, res);
    } catch (error) {
      logger.error('处理 MCP SSE 请求时出错:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error processing SSE connection' });
      }
    }
  });

  // ===== MCP DELETE 端点 (终止会话) =====
  app.delete('/mcp', async (req, res) => {
    const sessionId = mcpSessionId(req);

    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    logger.info(`终止会话: ${sessionId}`);

    try {
      transports[sessionId].lastSeen = Date.now();
      const transport = transports[sessionId].transport;
      await transport.handleRequest(req as any, res);
    } catch (error) {
      logger.error('终止会话时出错:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error processing session termination' });
      }
    }
  });

  // ===== 健康检查端点 =====
  app.get('/health', (_req, res) => {
    if (config.exposePublicInfo) {
      res.json({
        status: 'ok',
        name: 'code-repo-mcp-server',
        version: '1.0.0',
        activeSessions: Object.keys(transports).length,
        terminalEnabled: config.enableTerminal,
      });
      return;
    }

    res.json({ status: 'ok' });
  });

  // ===== 根路径信息 =====
  app.get('/', (_req, res) => {
    if (!config.exposePublicInfo) {
      res.json({
        name: 'Code Repository MCP Server',
        status: 'ok',
        mcpEndpoint: '/mcp',
      });
      return;
    }

    res.json({
      name: 'Code Repository MCP Server',
      description: 'MCP Server for code repository operations via ChatGPT',
      version: '1.0.0',
      endpoints: {
        mcp: 'POST/GET/DELETE /mcp - MCP Streamable HTTP endpoint',
        oauthProtectedResource: 'GET /.well-known/oauth-protected-resource - OAuth protected resource metadata',
        health: 'GET /health - Health check',
      },
      tools: [
        'list_directory', 'read_file', 'write_file', 'edit_file',
        'delete_file', 'create_directory', 'move_file', 'get_file_info',
        'search_files', 'search_content', 'get_file_tree',
        'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit',
        'git_branch', 'git_show', 'git_push', 'git_pull',
        ...(config.enableTerminal ? ['run_command'] : []),
      ],
    });
  });

  (app as any).__transports = transports;

  return app;
}
