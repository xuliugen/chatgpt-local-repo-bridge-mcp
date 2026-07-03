import express from 'express';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS_DIR = path.resolve(PROJECT_ROOT, '.artifacts');
const INCOMING_DIR = path.resolve(PROJECT_ROOT, '.incoming');
const ARTIFACT_TOKEN = 'mindx-agent-download-token-20260703-local-only-change-before-sharing';
const MAX_ARTIFACT_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_UPLOAD_BYTES = 100 * 1024 * 1024;

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function timingSafeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requireArtifactToken(req: express.Request, res: express.Response): boolean {
  if (!ARTIFACT_TOKEN) {
    res.status(404).json({ error: 'Artifact route is not enabled' });
    return false;
  }

  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!timingSafeTokenEqual(token, ARTIFACT_TOKEN)) {
    res.status(403).json({ error: 'Invalid artifact token' });
    return false;
  }

  return true;
}

function artifactFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(value)) return null;
  if (value.includes('/') || value.includes('\\') || value.includes('..')) return null;
  return value;
}

function timestampSuffix(): string {
  const now = new Date();
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

function addDateSuffixToZipFileName(fileName: string): string {
  return `${fileName.slice(0, -4)}-${timestampSuffix()}.zip`;
}

function contentDispositionFileName(fileName: string): string {
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${fileName}"; filename*=UTF-8''${encoded}`;
}

async function sendZipFile(res: express.Response, filePath: string, fileName: string): Promise<void> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }

  if (stats.size > MAX_ARTIFACT_DOWNLOAD_BYTES) {
    res.status(413).json({ error: 'Artifact is too large' });
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(stats.size));
  res.setHeader('Content-Disposition', contentDispositionFileName(fileName));

  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    logger.error(`读取归档文件失败: ${filePath}`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Artifact download failed' });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

export function registerArtifactRoutes(app: express.Express): void {
  app.post(
    '/uploads/artifacts/:filename',
    express.raw({ type: '*/*', limit: MAX_ARTIFACT_UPLOAD_BYTES }),
    async (req, res) => {
      if (!requireArtifactToken(req, res)) return;

      const fileName = artifactFileName(req.params.filename);
      if (!fileName) {
        res.status(400).json({ error: 'Invalid artifact filename' });
        return;
      }

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'Upload body must be a non-empty zip file' });
        return;
      }

      if (body.length > MAX_ARTIFACT_UPLOAD_BYTES) {
        res.status(413).json({ error: 'Uploaded artifact is too large' });
        return;
      }

      if (body[0] !== 0x50 || body[1] !== 0x4b) {
        res.status(400).json({ error: 'Uploaded artifact is not a zip file' });
        return;
      }

      const savedFileName = addDateSuffixToZipFileName(fileName);
      const incomingRoot = path.resolve(INCOMING_DIR);
      const uploadPath = path.resolve(incomingRoot, savedFileName);
      if (!isPathInside(uploadPath, incomingRoot)) {
        res.status(400).json({ error: 'Invalid upload path' });
        return;
      }

      await fs.mkdir(incomingRoot, { recursive: true });
      await fs.writeFile(uploadPath, body);

      logger.info(`上传归档文件: ${uploadPath} (${body.length} bytes)`);
      res.status(201).json({
        originalFileName: fileName,
        fileName: savedFileName,
        sizeBytes: body.length,
        uploadPath,
      });
    }
  );

  app.get('/downloads/artifacts/:filename', async (req, res) => {
    if (!requireArtifactToken(req, res)) return;

    const fileName = artifactFileName(req.params.filename);
    if (!fileName) {
      res.status(400).json({ error: 'Invalid artifact filename' });
      return;
    }

    const artifactsRoot = path.resolve(ARTIFACTS_DIR);
    const artifactPath = path.resolve(artifactsRoot, fileName);
    if (!isPathInside(artifactPath, artifactsRoot)) {
      res.status(400).json({ error: 'Invalid artifact path' });
      return;
    }

    try {
      logger.info(`下载归档文件: ${artifactPath}`);
      await sendZipFile(res, artifactPath, fileName);
    } catch {
      res.status(404).json({ error: 'Artifact not found' });
    }
  });
}
