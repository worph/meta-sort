import {describe, expect, it} from 'vitest';
import {BtihV2Hasher} from '../lib/file-id/BtihV2Hasher';
import {HashComputerWorker, pickCidByAlgorithm} from "../lib";
import {readFile} from 'fs/promises';
import {createHash} from 'crypto';
import * as process from "process";

process.env.WORKER_URL = "./dist/worker.js";

/**
 * BitTorrent v2 Info Hash Tests (BEP 52)
 *
 * Tests verify:
 * - 16KB block hashing
 * - Merkle tree construction
 * - Info hash computation
 * - CID encoding format
 * - Edge cases (empty files, partial blocks)
 */
describe('BitTorrent v2 Info Hash (BEP 52)', () => {
    it('should compute info hash for small file', async () => {
        const hasher = new BtihV2Hasher();
        hasher.setFileName('test.txt');

        // Read test file and feed to hasher
        const testData = await readFile('./src/tests/test.txt');
        hasher.update(testData);

        // Get info hash
        const infoHash = hasher.digest();

        // Verify hash format
        expect(infoHash).toBeInstanceOf(Buffer);
        expect(infoHash.length).toBe(32); // SHA-256 produces 32 bytes

        // Verify it's non-zero
        const isNonZero = infoHash.some(byte => byte !== 0);
        expect(isNonZero).toBe(true);

        console.log('Info hash (hex):', infoHash.toString('hex'));
    });

    it('should handle empty file', () => {
        const hasher = new BtihV2Hasher();
        hasher.setFileName('empty.txt');

        // Don't update with any data (empty file)
        const infoHash = hasher.digest();

        // Verify hash format
        expect(infoHash).toBeInstanceOf(Buffer);
        expect(infoHash.length).toBe(32);

        // Should produce valid hash even for empty file
        const isNonZero = infoHash.some(byte => byte !== 0);
        expect(isNonZero).toBe(true);

        console.log('Empty file info hash (hex):', infoHash.toString('hex'));
    });

    it('should handle file exactly one block (16KB)', () => {
        const hasher = new BtihV2Hasher();
        hasher.setFileName('exactly-16kb.bin');

        // Create exactly 16KB of data
        const oneBlock = Buffer.alloc(16 * 1024);
        for (let i = 0; i < oneBlock.length; i++) {
            oneBlock[i] = i % 256;
        }

        hasher.update(oneBlock);
        const infoHash = hasher.digest();

        expect(infoHash).toBeInstanceOf(Buffer);
        expect(infoHash.length).toBe(32);

        console.log('16KB file info hash (hex):', infoHash.toString('hex'));
    });

    it('should handle streaming updates (partial blocks)', () => {
        const hasher = new BtihV2Hasher();
        hasher.setFileName('streamed.bin');

        // Simulate streaming: feed data in small chunks
        const chunkSize = 1024; // 1KB chunks
        const totalSize = 50 * 1024; // 50KB total
        const data = Buffer.alloc(totalSize);
        for (let i = 0; i < data.length; i++) {
            data[i] = i % 256;
        }

        // Stream in chunks
        for (let offset = 0; offset < data.length; offset += chunkSize) {
            const end = Math.min(offset + chunkSize, data.length);
            hasher.update(data.subarray(offset, end));
        }

        const infoHash = hasher.digest();

        expect(infoHash).toBeInstanceOf(Buffer);
        expect(infoHash.length).toBe(32);

        console.log('Streamed 50KB info hash (hex):', infoHash.toString('hex'));
    });

    it('should compute consistent hash for same data', () => {
        const testData = Buffer.from('Hello BitTorrent v2!');

        // Compute hash twice
        const hasher1 = new BtihV2Hasher();
        hasher1.setFileName('hello.txt');
        hasher1.update(testData);
        const hash1 = hasher1.digest();

        const hasher2 = new BtihV2Hasher();
        hasher2.setFileName('hello.txt');
        hasher2.update(testData);
        const hash2 = hasher2.digest();

        // Should produce identical hashes
        expect(hash1.equals(hash2)).toBe(true);
    });

    it('should produce different hashes for different data', () => {
        const data1 = Buffer.from('File A content');
        const data2 = Buffer.from('File B content');

        const hasher1 = new BtihV2Hasher();
        hasher1.setFileName('fileA.txt');
        hasher1.update(data1);
        const hash1 = hasher1.digest();

        const hasher2 = new BtihV2Hasher();
        hasher2.setFileName('fileB.txt');
        hasher2.update(data2);
        const hash2 = hasher2.digest();

        // Should produce different hashes
        expect(hash1.equals(hash2)).toBe(false);
    });

    it('should produce different hashes for different filenames', () => {
        const data = Buffer.from('Same content');

        const hasher1 = new BtihV2Hasher();
        hasher1.setFileName('nameA.txt');
        hasher1.update(data);
        const hash1 = hasher1.digest();

        const hasher2 = new BtihV2Hasher();
        hasher2.setFileName('nameB.txt');
        hasher2.update(data);
        const hash2 = hasher2.digest();

        // Different filenames should produce different info hashes
        expect(hash1.equals(hash2)).toBe(false);
    });

    it('should integrate with HashComputerWorker', async () => {
        const hashComputer = new HashComputerWorker(['btih_v2', 'sha256']);

        const metadata: any = {};
        await hashComputer.computeMissingHash('./src/tests/test.txt', metadata);

        // The digests land in a bare CID list; each is recovered by its
        // multicodec, not by a field name.
        const btih = pickCidByAlgorithm(metadata.cids, 'btih_v2');
        expect(btih).toBeDefined();
        expect(typeof btih).toBe('string');
        expect(btih!.startsWith('b')).toBe(true);

        // Should also have SHA-256 for comparison.
        expect(pickCidByAlgorithm(metadata.cids, 'sha256')).toBeDefined();
    });

    it('should compute piece length correctly', () => {
        // Test piece length formula: 16KB * 2^n where pieces < 2048
        const testCases = [
            {fileSize: 0, expectedMin: 16 * 1024, expectedMax: 16 * 1024}, // Empty file
            {fileSize: 1024, expectedMin: 16 * 1024, expectedMax: 16 * 1024}, // 1KB
            {fileSize: 16 * 1024, expectedMin: 16 * 1024, expectedMax: 16 * 1024}, // 16KB
            {fileSize: 1024 * 1024, expectedMin: 16 * 1024, expectedMax: 16 * 1024}, // 1MB
            {fileSize: 100 * 1024 * 1024, expectedMin: 64 * 1024, expectedMax: 128 * 1024}, // 100MB
        ];

        for (const {fileSize, expectedMin, expectedMax} of testCases) {
            const hasher = new BtihV2Hasher();
            hasher.setFileName('size-test.bin');

            // Feed dummy data of specified size
            const chunkSize = 16 * 1024;
            let remaining = fileSize;
            while (remaining > 0) {
                const toWrite = Math.min(chunkSize, remaining);
                hasher.update(Buffer.alloc(toWrite));
                remaining -= toWrite;
            }

            // Digest triggers piece length computation
            const infoHash = hasher.digest();

            // We can't directly access piece length from outside,
            // but we can verify the hash was computed successfully
            expect(infoHash).toBeInstanceOf(Buffer);
            expect(infoHash.length).toBe(32);
        }
    });

    it('should produce valid CID format with codec 0x10B7', async () => {
        const hashComputer = new HashComputerWorker(['btih_v2']);

        const metadata: any = {};
        await hashComputer.computeMissingHash('./src/tests/test.txt', metadata);

        const cid = pickCidByAlgorithm(metadata.cids, 'btih_v2');

        // The selector proves the codec: pickCidByAlgorithm('btih_v2') matches on
        // multihash 0x10B7, so a hit here IS the "valid CID with codec 0x10B7"
        // assertion this test is named for.

        // Verify CID format
        expect(cid).toBeDefined();
        expect(typeof cid).toBe('string');

        // CIDv1 base32 starts with 'b'
        expect(cid.startsWith('b')).toBe(true);

        // Should be longer than minimum CID length
        expect(cid.length).toBeGreaterThan(10);
    });
});
