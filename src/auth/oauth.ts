import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { auth } from 'express-oauth2-jwt-bearer';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

type JwtPrimitive = string | number | boolean | null;
type JwtPayload = Record<string, JwtPrimitive | JwtPrimitive[]>;

interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
}

export const OAUTH_SCOPES = {
  read: 'repo:read',
  write: 'repo:write',
  git: 'repo:git',
} as const;

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'create_directory',
  'move_file',
]);

const GIT_WRITE_TOOLS = new Set([
  'git_add',
  'git_commit',
  'git_push',
  'git_pull',
]);

const HIGH_RISK_TOOLS = new Set([
  'run_command',
]);

let jwtAuthMiddleware: RequestHandler | undefined;

function publicOrigin(): string {
  return new URL(config.publicMcpUrl).origin;
}

export function protectedResourceMetadataUrl(): string {
  return `${publicOrigin()}/.well-known/oauth-protected-resource`;
}

export function protectedResourceMetadata() {
  return {
    resource: config.publicMcpUrl,
    authorization_servers: [config.oauthIssuer],
    scopes_supported: config.oauthScopes,
    bearer_methods_supported: ['header'],
    resource_documentation: `${publicOrigin()}/`,
  };
}

function getJwtAuthMiddleware(): RequestHandler {
  if (!jwtAuthMiddleware) {
    jwtAuthMiddleware = auth({
      issuerBaseURL: config.oauthIssuer,
      audience: config.oauthAudience,
      tokenSigningAlg: 'RS256',
    });
  }

  return jwtAuthMiddleware;
}

function requestBodyItems(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

function toolCallsFromRequest(req: Request): ToolCallRequest[] {
  return requestBodyItems(req.body)
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const jsonRpc = item as {
        method?: unknown;
        params?: {
          name?: unknown;
          arguments?: unknown;
        };
      };

      if (jsonRpc.method !== 'tools/call' || typeof jsonRpc.params?.name !== 'string') {
        return undefined;
      }

      const args = jsonRpc.params.arguments && typeof jsonRpc.params.arguments === 'object'
        ? jsonRpc.params.arguments as Record<string, unknown>
        : {};

      return {
        name: jsonRpc.params.name,
        args,
      };
    })
    .filter((toolCall): toolCall is ToolCallRequest => Boolean(toolCall));
}

export function requiredScopesForRequest(req: Request): string[] {
  const toolCalls = toolCallsFromRequest(req);

  if (toolCalls.length === 0) {
    return config.oauthScopes;
  }

  const requiredScopes = new Set<string>();

  for (const toolCall of toolCalls) {
    if (HIGH_RISK_TOOLS.has(toolCall.name)) {
      requiredScopes.add(OAUTH_SCOPES.git);
      continue;
    }

    if (toolCall.name === 'git_branch') {
      requiredScopes.add(toolCall.args.action === 'list' ? OAUTH_SCOPES.read : OAUTH_SCOPES.git);
      continue;
    }

    if (GIT_WRITE_TOOLS.has(toolCall.name)) {
      requiredScopes.add(OAUTH_SCOPES.git);
      continue;
    }

    if (WRITE_TOOLS.has(toolCall.name)) {
      requiredScopes.add(OAUTH_SCOPES.write);
      continue;
    }

    requiredScopes.add(OAUTH_SCOPES.read);
  }

  return Array.from(requiredScopes);
}

function tokenScopes(payload: JwtPayload): string[] {
  const rawScope = payload.scope;
  if (typeof rawScope === 'string') {
    return rawScope.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  }

  const permissions = payload.permissions;
  if (Array.isArray(permissions)) {
    return permissions.filter((scope): scope is string => typeof scope === 'string');
  }

  return [];
}

function hasRequiredScopes(payload: JwtPayload, requiredScopes: string[]): boolean {
  const grantedScopes = new Set(tokenScopes(payload));
  return requiredScopes.every((scope) => grantedScopes.has(scope));
}

function sendUnauthorized(res: Response, requiredScopes: string[]): void {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${protectedResourceMetadataUrl()}", scope="${requiredScopes.join(' ')}"`
  );

  res.status(401).json({ error: 'Unauthorized' });
}

function runJwtAuth(req: Request, res: Response): Promise<JwtPayload> {
  return new Promise((resolve, reject) => {
    getJwtAuthMiddleware()(req, res, (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }

      const payload = req.auth?.payload as JwtPayload | undefined;
      if (!payload) {
        reject(new Error('Missing authenticated JWT payload'));
        return;
      }

      resolve(payload);
    });
  });
}

export async function requireOAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!config.oauthEnabled) {
    next();
    return;
  }

  const requiredScopes = requiredScopesForRequest(req);

  try {
    const payload = await runJwtAuth(req, res);

    if (!hasRequiredScopes(payload, requiredScopes)) {
      throw new Error(`Missing required OAuth scopes: ${requiredScopes.join(', ')}`);
    }

    res.locals.oauth = payload;
    next();
  } catch (error) {
    logger.warn(`OAuth token 校验失败: ${(error as Error).message}`);
    if (!res.headersSent) {
      sendUnauthorized(res, requiredScopes);
    }
  }
}
