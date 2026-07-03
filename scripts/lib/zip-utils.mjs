import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function normalizeZipPath(value) {
  return value.split(path.sep).join('/');
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function createExcludeMatcher({ excludedDirs, excludedFiles }) {
  const dirSet = new Set(excludedDirs.map((item) => item.toLowerCase()));
  const filePatterns = excludedFiles.map(wildcardToRegExp);

  return {
    isExcludedPath(relativePath) {
      const segments = normalizeZipPath(relativePath)
        .split('/')
        .filter(Boolean)
        .map((segment) => segment.toLowerCase());
      return segments.some((segment) => dirSet.has(segment));
    },
    isExcludedFile(fileName) {
      return filePatterns.some((pattern) => pattern.test(fileName));
    },
  };
}

async function collectFiles(root, current, matcher, files) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!matcher.isExcludedPath(relativePath)) {
        await collectFiles(root, fullPath, matcher, files);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (matcher.isExcludedPath(relativePath) || matcher.isExcludedFile(entry.name)) continue;
    files.push({ fullPath, relativePath: normalizeZipPath(relativePath) });
  }
}

export async function listFilesForZip(root, matcher) {
  const files = [];
  await collectFiles(root, root, matcher, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function createZipFromDirectory({ sourceRoot, destinationZip, matcher }) {
  const files = await listFilesForZip(sourceRoot, matcher);
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const file of files) {
    const data = await fs.readFile(file.fullPath);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const payload = deflated.length < data.length ? deflated : data;
    const method = payload === deflated ? DEFLATE_METHOD : STORE_METHOD;
    const name = Buffer.from(file.relativePath, 'utf8');
    const checksum = crc32(data);
    const stats = await fs.stat(file.fullPath);
    const { dosTime, dosDate } = toDosDateTime(stats.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, name, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectory.push(centralHeader, name);

    offset += localHeader.length + name.length + payload.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  await fs.mkdir(path.dirname(destinationZip), { recursive: true });
  await fs.writeFile(destinationZip, Buffer.concat([...chunks, ...centralDirectory, end]));
  return files.length;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('Invalid zip: end of central directory not found.');
}

export function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error('Invalid zip: central directory header mismatch.');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

export function assertSafeZipEntries(entries, matcher) {
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || /^[A-Za-z]:\//.test(name) || name.split('/').includes('..')) {
      throw new Error(`Unsafe zip entry path: ${name}`);
    }
    if (name.endsWith('/')) continue;
    const fileName = path.posix.basename(name);
    if (matcher.isExcludedPath(name)) throw new Error(`Zip contains excluded directory path: ${name}`);
    if (matcher.isExcludedFile(fileName)) throw new Error(`Zip contains excluded sensitive file: ${name}`);
  }
}

export async function extractZipBuffer({ buffer, entries, destinationRoot }) {
  await fs.mkdir(destinationRoot, { recursive: true });
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    if (buffer.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error(`Invalid zip: local header mismatch for ${name}`);
    }

    const localNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let data;
    if (entry.method === STORE_METHOD) {
      data = compressed;
    } else if (entry.method === DEFLATE_METHOD) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported zip compression method ${entry.method} for ${name}`);
    }

    if (data.length !== entry.uncompressedSize) {
      throw new Error(`Invalid zip: uncompressed size mismatch for ${name}`);
    }

    const destination = path.resolve(destinationRoot, ...name.split('/'));
    const relative = path.relative(destinationRoot, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Unsafe extraction target: ${name}`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, data);
  }
}
