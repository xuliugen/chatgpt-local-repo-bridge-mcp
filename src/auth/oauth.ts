import type { Request, Response, NextFunction } from 'express';
import { createPublicKey, createVerify } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

type JwtPrimitive = string | number | boolean | null;
type JwtPayload = Record<string, JwtPrimitive | JwtPrimitive[]>;

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwksKey {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

interface JwksResponse {
  keys?: JwksKey[];
}

interface CachedJwks {
  expiresAt: number;
  keys: JwksKey[];
}

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

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
let cachedJwks: CachedJwks | undefined;

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

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function parseJwtPart<T>(part: string, label: string): T {
  try {
    return JSON.parse(base64UrlDecode(part).toString('utf-8')) as T;
  } catch {
    throw new Error(`Invalid JWT ${label}`);
  }
}

function splitJwt(token: string): { header: JwtHeader; payload: JwtPayload; signingInput: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error('Invalid JWT format');
  }

  return {
    header: parseJwtPart<JwtHeader>(parts[0], 'header'),
    payload: parseJwtPart<JwtPayload>(parts[1], 'payload'),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64UrlDecode(parts[2]),
  };
}

async function fetchJwks(): Promise<JwksKey[]> {
  const now = Date.now();
  if (cachedJwks && cachedJwks.expiresAt > now) {
    return cachedJwks.keys;
  }

  const response = await fetch(config.oauthJwksUri, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: HTTP ${response.status}`);
  }

  const body = await response.json() as JwksResponse;
  if (!Array.isArray(body.keys)) {
    throw new Error('Invalid JWKS response');
  }

  cachedJwks = {
    expiresAt: now + JWKS_CACHE_TTL_MS,
    keys: body.keys,
  };

  return body.keys;
}

async function findSigningKey(header: JwtHeader): Promise<JwksKey> {
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT alg: ${header.alg ?? '(missing)'}`);
  }

  const keys = await fetchJwks();
  const key = keys.find((candidate) => {
    if (header.kid && candidate.kid !== header.kid) return false;
    if (candidate.use && candidate.use !== 'sig') return false;
    if (candidate.alg && candidate.alg !== 'RS256') return false;
    return candidate.kty === 'RSA';
  });

  if (!key) {
    throw new Error(`No matching JWKS key found for kid=${header.kid ?? '(missing)'}`);
  }

  return key;
}

function verifySignature(signingInput: string, signature: Buffer, key: JwksKey): void {
  const publicKey = createPublicKey({ key, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();

  if (!verifier.verify(publicKey, signature)) {
    throw new Error('Invalid JWT signature');
  }
}

function stringClaim(payload: JwtPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' ? value : undefined;
}

function numberClaim(payload: JwtPayload, name: string): number | undefined {
  const value = payload[name];
  return typeof value === 'number' ? value : undefined;
}

function audienceMatches(payload: JwtPayload): boolean {
  const aud = payload.aud;
  if (typeof aud === 'string') {
    return aud === config.oauthAudience;
  }
  if (Array.isArray(aud)) {
    return aud.includes(config.oauthAudience);
  }
  return false;
}

function verifyStandardClaims(payload: JwtPayload): void {
  const issuer = stringClaim(payload, 'iss');
  if (issuer !== config.oauthIssuer) {
    throw new Error('Invalid JWT issuer');
  }

  if (!audienceMatches(payload)) {
    throw new Error('Invalid JWT audience');
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = numberClaim(payload, 'exp');
  if (expiresAt === undefined || expiresAt <= now - CLOCK_SKEW_SECONDS) {
    throw new Error('JWT is expired');
  }

  const notBefore = numberClaim(payload, 'nbf');
  if (notBefore !== undefined && notBefore > now + CLOCK_SKEW_SECONDS) {
    throw new Error('JWT is not active yet');
  }
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

async function verifyAccessToken(token: string, requiredScopes: string[]): Promise<JwtPayload> {
  const { header, payload, signingInput, signature } = splitJwt(token);
  const key = await findSigningKey(header);

  verifySignature(signingInput, signature, key);
  verifyStandardClaims(payload);

  if (!hasRequiredScopes(payload, requiredScopes)) {
    throw new Error(`Missing required OAuth scopes: ${requiredScopes.join(', ')}`);
  }

  return payload;
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
  const authorization = req.header('authorization');

  if (!authorization?.startsWith('Bearer ')) {
    sendUnauthorized(res, requiredScopes);
    return;
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) {
    sendUnauthorized(res, requiredScopes);
    return;
  }

  try {
    const payload = await verifyAccessToken(token, requiredScopes);
    res.locals.oauth = payload;
    next();
  } catch (error) {
    logger.warn(`OAuth token 校验失败: ${(error as Error).message}`);
    sendUnauthorized(res, requiredScopes);
  }
}
