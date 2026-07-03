import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExcludeMatcher, createZipFromDirectory } from './lib/zip-utils.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

const sourceRoot = path.resolve(projectRoot, '..', 'mindx-agent');
const artifactsDir = path.resolve(projectRoot, '.artifacts');
const downloadToken = 'mindx-agent-download-token-20260703-local-only-change-before-sharing';
const keepArchives = 5;

const excludedDirectoryNames = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
];

const excludedFileNamePatterns = [
  '.env',
  '.env.*',
  '.envrc',
  '.npmrc',
  '.pypirc',
  '*.pem',
  '*.key',
  '*.crt',
  '*.cer',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  'mindx-agent-source-*.zip',
];

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function getPublicOrigin() {
  const publicMcpUrl = process.env.PUBLIC_MCP_URL?.trim();
  if (publicMcpUrl) return new URL(publicMcpUrl).origin;
  return `http://localhost:${process.env.PORT?.trim() || '3100'}`;
}

async function removeOldArchives() {
  const entries = await fs.readdir(artifactsDir, { withFileTypes: true }).catch(() => []);
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^mindx-agent-source-.*\.zip$/.test(entry.name)) continue;
    const fullPath = path.join(artifactsDir, entry.name);
    const stats = await fs.stat(fullPath);
    archives.push({ fullPath, mtimeMs: stats.mtimeMs });
  }
  archives.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(archives.slice(keepArchives).map((archive) => fs.rm(archive.fullPath, { force: true })));
}

async function main() {
  const sourceStats = await fs.stat(sourceRoot).catch(() => null);
  if (!sourceStats?.isDirectory()) {
    throw new Error(`Source directory does not exist: ${sourceRoot}`);
  }

  await fs.mkdir(artifactsDir, { recursive: true });
  const archiveFileName = `mindx-agent-source-${timestamp()}.zip`;
  const destinationZip = path.join(artifactsDir, archiveFileName);
  const matcher = createExcludeMatcher({
    excludedDirs: excludedDirectoryNames,
    excludedFiles: excludedFileNamePatterns,
  });
  const fileCount = await createZipFromDirectory({ sourceRoot, destinationZip, matcher });
  await removeOldArchives();

  const archiveStats = await fs.stat(destinationZip);
  const encodedName = encodeURIComponent(archiveFileName);
  const encodedToken = encodeURIComponent(downloadToken);
  const downloadUrl = `${getPublicOrigin()}/downloads/artifacts/${encodedName}?token=${encodedToken}`;

  console.log(JSON.stringify({
    archivePath: destinationZip,
    fileName: archiveFileName,
    sizeBytes: archiveStats.size,
    fileCount,
    sourceRoot,
    artifactsDir,
    downloadUrl,
    downloadEnabled: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
