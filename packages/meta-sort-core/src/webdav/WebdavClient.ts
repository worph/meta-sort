/**
 * WebDAV Client for Meta-Sort
 *
 * Provides HTTP-based file access to meta-core's WebDAV server.
 * Files are accessed exclusively via WebDAV - no local filesystem access.
 *
 * The WebDAV URL is discovered automatically from the leader via LeaderClient.
 */

import { Readable } from 'stream';
import { createHash } from 'crypto';
import { create } from 'multiformats/hashes/digest';
import { CID } from 'multiformats/cid';

// Configuration - set dynamically after leader discovery
let WEBDAV_URL: string = '';
const FILES_PATH = process.env.FILES_PATH || '/files';

/**
 * Configure the WebDAV client with a URL discovered from leader.
 * Called after LeaderClient connects to the leader.
 */
export function configure(webdavUrl: string): void {
    if (!webdavUrl) {
        return;
    }
    WEBDAV_URL = webdavUrl.replace(/\/$/, '');
    console.log(`[webdav-client] Configured: ${WEBDAV_URL}`);
}

/**
 * Check if WebDAV client is configured.
 */
export function isConfigured(): boolean {
    return Boolean(WEBDAV_URL);
}

/**
 * Get the configured WebDAV URL.
 */
export function getWebdavUrl(): string {
    return WEBDAV_URL;
}

/**
 * Convert a local file path to a WebDAV URL.
 *
 * @param filePath - Local file path (e.g., /files/watch/movie.mp4)
 * @returns WebDAV URL or null if not configured
 */
export function toWebdavUrl(filePath: string): string | null {
    if (!WEBDAV_URL) {
        return null;
    }

    // Strip the FILES_PATH prefix to get relative path
    let relativePath = filePath;
    if (filePath.startsWith(FILES_PATH + '/')) {
        relativePath = filePath.slice(FILES_PATH.length);
    } else if (filePath.startsWith(FILES_PATH)) {
        relativePath = filePath.slice(FILES_PATH.length);
    }

    // Ensure path starts with /
    if (!relativePath.startsWith('/')) {
        relativePath = '/' + relativePath;
    }

    // URL-encode path segments (but not slashes)
    const encodedPath = relativePath
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');

    return WEBDAV_URL + encodedPath;
}

/**
 * File stats returned from WebDAV HEAD request.
 */
export interface WebdavFileStats {
    size: number;
    mtime: Date;
    exists: boolean;
}

/**
 * Get file stats via HTTP HEAD request to WebDAV.
 *
 * @param filePath - File path
 * @returns File stats or null on error
 */
export async function stat(filePath: string): Promise<WebdavFileStats | null> {
    const url = toWebdavUrl(filePath);
    if (!url) {
        console.error('[webdav-client] Not configured, cannot stat file');
        return null;
    }

    try {
        const response = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(30000)
        });

        if (response.status === 404) {
            return { size: 0, mtime: new Date(0), exists: false };
        }

        if (!response.ok) {
            console.error(`[webdav-client] HEAD error for ${url}: ${response.status}`);
            return null;
        }

        const contentLength = response.headers.get('Content-Length');
        const lastModified = response.headers.get('Last-Modified');

        return {
            size: contentLength ? parseInt(contentLength, 10) : 0,
            mtime: lastModified ? new Date(lastModified) : new Date(),
            exists: true
        };
    } catch (error) {
        console.error(`[webdav-client] HEAD error for ${url}:`, error);
        return null;
    }
}

/**
 * Check if file exists via HTTP HEAD request to WebDAV.
 *
 * @param filePath - File path
 * @returns True if file exists
 */
export async function exists(filePath: string): Promise<boolean> {
    const stats = await stat(filePath);
    return stats?.exists ?? false;
}

/**
 * Read entire file from WebDAV.
 *
 * @param filePath - File path
 * @returns File contents as Buffer, or null on error
 */
export async function readFile(filePath: string): Promise<Buffer | null> {
    const url = toWebdavUrl(filePath);
    if (!url) {
        console.error('[webdav-client] Not configured, cannot read file');
        return null;
    }

    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(60000)
        });

        if (!response.ok) {
            if (response.status !== 404) {
                console.error(`[webdav-client] GET error for ${url}: ${response.status}`);
            }
            return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        console.error(`[webdav-client] GET error for ${url}:`, error);
        return null;
    }
}

/**
 * Read file as text from WebDAV.
 *
 * @param filePath - File path
 * @param encoding - Text encoding (default: utf-8)
 * @returns File contents as string, or null on error
 */
export async function readTextFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string | null> {
    const buffer = await readFile(filePath);
    return buffer?.toString(encoding) ?? null;
}

/**
 * Read a byte range from a file via WebDAV.
 *
 * @param filePath - File path
 * @param start - Start byte offset (inclusive)
 * @param end - End byte offset (inclusive)
 * @returns Bytes in the specified range, or null on error
 */
export async function readRange(filePath: string, start: number, end: number): Promise<Buffer | null> {
    const url = toWebdavUrl(filePath);
    if (!url) {
        console.error('[webdav-client] Not configured, cannot read range');
        return null;
    }

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Range': `bytes=${start}-${end}`
            },
            signal: AbortSignal.timeout(60000)
        });

        if (!response.ok && response.status !== 206) {
            console.error(`[webdav-client] Range GET error for ${url}: ${response.status}`);
            return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        console.error(`[webdav-client] Range GET error for ${url}:`, error);
        return null;
    }
}

/**
 * Write file to WebDAV.
 *
 * @param filePath - File path
 * @param content - File contents (Buffer or string)
 * @returns True on success
 */
export async function writeFile(filePath: string, content: Buffer | string): Promise<boolean> {
    const url = toWebdavUrl(filePath);
    if (!url) {
        console.error('[webdav-client] Not configured, cannot write file');
        return false;
    }

    try {
        const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

        const response = await fetch(url, {
            method: 'PUT',
            // Node.js fetch accepts Buffer directly at runtime
            body: buffer as unknown as BodyInit,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': buffer.length.toString()
            },
            signal: AbortSignal.timeout(60000)
        });

        if (!response.ok && response.status !== 201 && response.status !== 204) {
            console.error(`[webdav-client] PUT error for ${url}: ${response.status}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`[webdav-client] PUT error for ${url}:`, error);
        return false;
    }
}

/**
 * Delete file from WebDAV.
 *
 * @param filePath - File path
 * @returns True on success
 */
export async function deleteFile(filePath: string): Promise<boolean> {
    const url = toWebdavUrl(filePath);
    if (!url) {
        console.error('[webdav-client] Not configured, cannot delete file');
        return false;
    }

    try {
        const response = await fetch(url, {
            method: 'DELETE',
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok && response.status !== 204 && response.status !== 404) {
            console.error(`[webdav-client] DELETE error for ${url}: ${response.status}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`[webdav-client] DELETE error for ${url}:`, error);
        return false;
    }
}

/**
 * Create directory on WebDAV (MKCOL).
 *
 * @param dirPath - Directory path
 * @returns True on success
 */
export async function mkdir(dirPath: string): Promise<boolean> {
    const url = toWebdavUrl(dirPath);
    if (!url) {
        console.error('[webdav-client] Not configured, cannot create directory');
        return false;
    }

    try {
        const response = await fetch(url, {
            method: 'MKCOL',
            signal: AbortSignal.timeout(30000)
        });

        // 201 Created, 405 Method Not Allowed (already exists), or any 2xx
        if (!response.ok && response.status !== 201 && response.status !== 405) {
            console.error(`[webdav-client] MKCOL error for ${url}: ${response.status}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`[webdav-client] MKCOL error for ${url}:`, error);
        return false;
    }
}

/**
 * Create a readable stream from WebDAV file.
 * Uses fetch with streaming response.
 *
 * @param filePath - File path
 * @returns Readable stream or null on error
 */
export async function createReadStream(filePath: string): Promise<Readable | null> {
    const url = toWebdavUrl(filePath);
    if (!url) {
        console.error('[webdav-client] Not configured, cannot create stream');
        return null;
    }

    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(300000) // 5 minutes for streaming
        });

        if (!response.ok) {
            console.error(`[webdav-client] Stream GET error for ${url}: ${response.status}`);
            return null;
        }

        if (!response.body) {
            console.error(`[webdav-client] No response body for ${url}`);
            return null;
        }

        // Convert web ReadableStream to Node.js Readable
        return Readable.fromWeb(response.body as any);
    } catch (error) {
        console.error(`[webdav-client] Stream error for ${url}:`, error);
        return null;
    }
}

/**
 * Create a readable stream for a byte range from WebDAV file.
 *
 * @param filePath - File path
 * @param start - Start byte offset
 * @param end - End byte offset
 * @returns Readable stream or null on error
 */
export async function createRangeStream(filePath: string, start: number, end: number): Promise<Readable | null> {
    const url = toWebdavUrl(filePath);
    if (!url) {
        console.error('[webdav-client] Not configured, cannot create range stream');
        return null;
    }

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Range': `bytes=${start}-${end}`
            },
            signal: AbortSignal.timeout(300000)
        });

        if (!response.ok && response.status !== 206) {
            console.error(`[webdav-client] Range stream error for ${url}: ${response.status}`);
            return null;
        }

        if (!response.body) {
            console.error(`[webdav-client] No response body for range ${url}`);
            return null;
        }

        return Readable.fromWeb(response.body as any);
    } catch (error) {
        console.error(`[webdav-client] Range stream error for ${url}:`, error);
        return null;
    }
}

/**
 * Multicodec for midhash256 (custom algorithm code)
 */
const CID_MIDHASH256_CODE = 0x1000;

/**
 * Compute midhash256 for a file via WebDAV.
 *
 * This is a WebDAV-aware version of the midhash256 algorithm that uses
 * HTTP range requests to read only the required bytes instead of the entire file.
 *
 * Algorithm:
 * - For files <= 1MB: Hash entire file content + size prefix
 * - For files > 1MB: Hash middle 1MB + size prefix
 *
 * @param filePath - File path
 * @returns CID string or null on error
 */
export async function computeMidHash256(filePath: string): Promise<string | null> {
    const SAMPLE_SIZE = 1024 * 1024; // 1MB

    // Get file size via HEAD request
    const stats = await stat(filePath);
    if (!stats || !stats.exists) {
        console.error(`[webdav-client] Cannot compute hash - file not found: ${filePath}`);
        return null;
    }

    const fileSize = stats.size;

    // Create size buffer (64-bit big-endian)
    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

    // Read sample data via range request
    let sampleData: Buffer | null;
    if (fileSize <= SAMPLE_SIZE) {
        // Small file: read entire content
        sampleData = await readFile(filePath);
    } else {
        // Large file: read middle 1MB
        const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
        sampleData = await readRange(filePath, middleOffset, middleOffset + SAMPLE_SIZE - 1);
    }

    if (!sampleData) {
        console.error(`[webdav-client] Failed to read sample data for hash: ${filePath}`);
        return null;
    }

    // Compute SHA-256 hash of [size + sample]
    const hashInput = Buffer.concat([sizeBuffer, sampleData]);
    const hashBuffer = createHash('sha256')
        .update(hashInput)
        .digest();

    // Wrap in CID format with custom multicodec 0x1000
    const digest = create(CID_MIDHASH256_CODE, hashBuffer);
    return CID.createV1(CID_MIDHASH256_CODE, digest).toString();
}
