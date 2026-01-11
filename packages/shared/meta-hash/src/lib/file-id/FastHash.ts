import { createHash } from 'crypto';
import { open, stat } from 'fs/promises';
import { create } from 'multiformats/hashes/digest';
import { CID } from 'multiformats/cid';
import { CID_ALGORITHM_CODES } from '../hash-compute/MultiHashData.js';

/**
 * Computes a midhash256 based on sampling the middle 1MB of a file
 * plus the file size as a 64-bit integer prefix.
 *
 * Algorithm:
 * - For files <= 1MB: Hashes entire file content + size prefix
 * - For files > 1MB: Hashes middle 1MB + size prefix
 *
 * The size prefix ensures that files with identical middle content
 * but different sizes produce different hashes.
 *
 * Performance: ~20ms regardless of file size (O(1) complexity)
 *
 * @param filePath - Path to file
 * @returns CID string in proper CID v1 format with multicodec 0x1000
 */
export async function computeMidHash256(filePath: string): Promise<string> {
    const SAMPLE_SIZE = 1024 * 1024; // 1MB

    // Get file size (instant - no file read)
    const stats = await stat(filePath);
    const fileSize = stats.size;

    // Create size buffer (64-bit big-endian)
    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

    // Extract sample data
    let sampleData: Buffer;
    if (fileSize <= SAMPLE_SIZE) {
        // Small file: read entire content
        const fd = await open(filePath, 'r');
        sampleData = Buffer.allocUnsafe(fileSize);
        await fd.read(sampleData, 0, fileSize, 0);
        await fd.close();
    } else {
        // Large file: read middle 1MB
        const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
        const fd = await open(filePath, 'r');
        sampleData = Buffer.allocUnsafe(SAMPLE_SIZE);
        await fd.read(sampleData, 0, SAMPLE_SIZE, middleOffset);
        await fd.close();
    }

    // Compute SHA-256 hash of [size + sample]
    const hashInput = Buffer.concat([sizeBuffer, sampleData]);
    const hashBuffer = createHash('sha256')
        .update(hashInput)
        .digest();

    // Wrap in CID format with custom multicodec 0x1000
    const digest = create(CID_ALGORITHM_CODES.midhash256, hashBuffer);
    return CID.createV1(CID_ALGORITHM_CODES.midhash256, digest).toString();
}

/**
 * Synchronous version of computeMidHash256 for use in worker threads
 * Uses synchronous fs operations for compatibility with Piscina workers
 */
export function computeMidHash256Sync(filePath: string): string {
    const fs = require('fs');
    const SAMPLE_SIZE = 1024 * 1024; // 1MB

    // Get file size
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    // Create size buffer (64-bit big-endian)
    const sizeBuffer = Buffer.allocUnsafe(8);
    sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

    // Extract sample data
    let sampleData: Buffer;
    if (fileSize <= SAMPLE_SIZE) {
        // Small file: read entire content
        const fd = fs.openSync(filePath, 'r');
        sampleData = Buffer.allocUnsafe(fileSize);
        fs.readSync(fd, sampleData, 0, fileSize, 0);
        fs.closeSync(fd);
    } else {
        // Large file: read middle 1MB
        const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
        const fd = fs.openSync(filePath, 'r');
        sampleData = Buffer.allocUnsafe(SAMPLE_SIZE);
        fs.readSync(fd, sampleData, 0, SAMPLE_SIZE, middleOffset);
        fs.closeSync(fd);
    }

    // Compute SHA-256 hash of [size + sample]
    const hashInput = Buffer.concat([sizeBuffer, sampleData]);
    const hashBuffer = createHash('sha256')
        .update(hashInput)
        .digest();

    // Wrap in CID format with custom multicodec 0x1000
    const digest = create(CID_ALGORITHM_CODES.midhash256, hashBuffer);
    return CID.createV1(CID_ALGORITHM_CODES.midhash256, digest).toString();
}
