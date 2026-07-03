import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeZipEntries,
  createExcludeMatcher,
  createZipFromDirectory,
  extractZipBuffer,
  readZipEntries,
} from './lib/zip-utils.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const incomingDir = path.resolve(projectRoot, '.incoming');
const backupsDir = path.resolve(projectRoot, '.backups');
const targetRoot = path.resolve(projectRoot, '..', 'mindx-agent');
const maxImportZipBytes = 100 * 1024 * 1024;

const excludedDirectoryNames = [
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache',
  'coverage', '.venv', 'venv', '__pycache__',
];

const excludedFileNamePatterns = [
  '.env', '.env.*', '.envrc', '.npmrc', '.pypirc', '*.pem', '*.key',
  '*.crt', '*.cer', '*.p12', '*.pfx', 'id_rsa', 'id_rsa.*',
  'id_ed25519', 'id_ed25519.*',
];

const matcher = createExcludeMatcher({ excludedDirs: excludedDirectoryNames, excludedFiles: excludedFileNamePatterns });

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function latestUpload() {
  const entries = await fs.readdir(incomingDir, { withFileTypes: true });
  const zips = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^mindx-agent-safe-.*\.zip$/.test(entry.name)) continue;
    const fullPath = path.join(incomingDir, entry.name);
    const stats = await fs.stat(fullPath);
    zips.push({ name: entry.name, mtimeMs: stats.mtimeMs });
  }
  zips.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!zips[0]) throw new Error('No uploaded mindx-agent-safe-*.zip found in .incoming.');
  return path.join('.incoming', zips[0].name);
}

async function readZipFromIncomingFile(incomingFile, outputPath) {
  const incomingPath = path.resolve(projectRoot, incomingFile);
  if (!isPathInside(incomingPath, incomingDir)) {
    throw new Error(`Import file must be inside .incoming: ${incomingPath}`);
  }
  const data = await fs.readFile(incomingPath);
  await fs.copyFile(incomingPath, outputPath);
  return { data, importSource: incomingPath };
}

async function getContentRoot(expandedRoot) {
  const entries = await fs.readdir(expandedRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  return directories.length === 1 && files.length === 0 ? path.join(expandedRoot, directories[0].name) : expandedRoot;
}

async function copyOverlay(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const relativePath = path.relative(source, sourcePath);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!matcher.isExcludedPath(relativePath)) await copyOverlay(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile() || matcher.isExcludedFile(entry.name)) continue;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  }
}

async function main() {
  const incomingFile = await latestUpload();

  const targetStats = await fs.stat(targetRoot).catch(() => null);
  if (!targetStats?.isDirectory()) throw new Error(`Target directory does not exist: ${targetRoot}`);

  await fs.mkdir(incomingDir, { recursive: true });
  await fs.mkdir(backupsDir, { recursive: true });

  const stamp = timestamp();
  const importedZip = path.join(incomingDir, `mindx-agent-import-${stamp}.zip`);
  const expandedRoot = path.join(os.tmpdir(), `mindx-agent-import-expanded-${crypto.randomUUID()}`);
  const backupZip = path.join(backupsDir, `mindx-agent-before-import-${stamp}.zip`);

  try {
    const { data, importSource } = await readZipFromIncomingFile(incomingFile, importedZip);

    if (data.length === 0 || data.length > maxImportZipBytes) throw new Error(`Invalid import zip size: ${data.length}`);
    if (data[0] !== 0x50 || data[1] !== 0x4b) throw new Error('Import file is not a zip.');

    const entries = readZipEntries(data);
    assertSafeZipEntries(entries, matcher);
    await extractZipBuffer({ buffer: data, entries, destinationRoot: expandedRoot });
    const contentRoot = await getContentRoot(expandedRoot);
    const packageJson = await fs.stat(path.join(contentRoot, 'package.json')).catch(() => null);
    if (!packageJson?.isFile()) throw new Error('Expanded archive does not contain package.json at its content root.');

    await createZipFromDirectory({ sourceRoot: targetRoot, destinationZip: backupZip, matcher });
    await copyOverlay(contentRoot, targetRoot);

    console.log(JSON.stringify({
      importSource,
      importedZip,
      importedZipSizeBytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      contentRoot,
      targetRoot,
      backupZip,
    }, null, 2));
  } finally {
    await fs.rm(expandedRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
