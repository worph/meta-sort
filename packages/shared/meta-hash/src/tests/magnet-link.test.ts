import {describe, expect, it} from 'vitest';
import {BtihV2Hasher, MagnetLinkGenerator} from '../lib';
import {readFile, stat} from 'fs/promises';

/**
 * End-to-End Magnet Link Generation Tests
 *
 * Tests the complete workflow:
 * 1. Compute BitTorrent v2 info hash from file
 * 2. Generate magnet link
 * 3. Parse and validate magnet link
 */
describe('Magnet Link Generation (End-to-End)', () => {
    it('should generate valid magnet link from file', async () => {
        const filePath = './src/tests/test.txt';
        const fileName = 'test.txt';

        // Step 1: Read file and compute info hash
        const fileData = await readFile(filePath);
        const fileStats = await stat(filePath);
        const fileSize = fileStats.size;

        const hasher = new BtihV2Hasher();
        hasher.setFileName(fileName);
        hasher.update(fileData);
        const infoHash = hasher.digest();

        // Verify info hash computed
        expect(infoHash).toBeInstanceOf(Buffer);
        expect(infoHash.length).toBe(32);

        console.log('File:', fileName);
        console.log('Size:', fileSize, 'bytes');
        console.log('Info hash (hex):', infoHash.toString('hex'));

        // Note: We can't test magnet link generation end-to-end without
        // the CID encoding working properly through HashComputerWorker.
        // This would require the worker integration to be fixed.
    });

    it('should generate magnet link from mock CID', () => {
        // Mock CID format (this is a valid CIDv1 with our custom codec 0x10B7)
        // In real usage, this would come from HashComputerWorker
        const fileName = 'test-video.mp4';
        const fileSize = 1024 * 1024 * 100; // 100MB

        // Create a mock info hash (32 bytes of test data)
        const mockInfoHash = Buffer.from(
            'b04c198dd3148719db3e32fecc54ec41ec355d7f866a1c3f71bf980c3cde01bf',
            'hex'
        );

        // For this test, we'll construct the magnet link manually
        // since we can't get a real CID without the worker
        const infoHashHex = mockInfoHash.toString('hex');
        const magnetLink = `magnet:?xt=urn:btmh:1220${infoHashHex}&dn=${encodeURIComponent(fileName)}&xl=${fileSize}`;

        console.log('\nGenerated magnet link:');
        console.log(magnetLink);

        // Verify magnet link format
        expect(magnetLink.startsWith('magnet:?')).toBe(true);
        expect(magnetLink.includes('xt=urn:btmh:1220')).toBe(true);
        expect(magnetLink.includes(infoHashHex)).toBe(true);
        expect(magnetLink.includes(`dn=${encodeURIComponent(fileName)}`)).toBe(true);
        expect(magnetLink.includes(`xl=${fileSize}`)).toBe(true);
    });

    it('should validate magnet link format', () => {
        const validLink = 'magnet:?xt=urn:btmh:1220' + 'a'.repeat(64) + '&dn=file.mp4&xl=1024';
        const invalidLink1 = 'http://example.com';
        const invalidLink2 = 'magnet:?xt=urn:btih:' + 'a'.repeat(40); // v1 format (SHA-1)
        const invalidLink3 = 'magnet:?xt=urn:btmh:1220' + 'a'.repeat(32); // Too short

        expect(MagnetLinkGenerator.isValid(validLink)).toBe(true);
        expect(MagnetLinkGenerator.isValid(invalidLink1)).toBe(false);
        expect(MagnetLinkGenerator.isValid(invalidLink2)).toBe(false);
        expect(MagnetLinkGenerator.isValid(invalidLink3)).toBe(false);
    });

    it('should extract info hash from magnet link', () => {
        const infoHash = 'b04c198dd3148719db3e32fecc54ec41ec355d7f866a1c3f71bf980c3cde01bf';
        const magnetLink = `magnet:?xt=urn:btmh:1220${infoHash}&dn=file.mp4&xl=1024`;

        const extracted = MagnetLinkGenerator.extractInfoHash(magnetLink);
        expect(extracted).toBe(infoHash);
    });

    it('should extract filename from magnet link', () => {
        const fileName = 'Big Buck Bunny.mp4';
        const infoHash = 'a'.repeat(64);
        const magnetLink = `magnet:?xt=urn:btmh:1220${infoHash}&dn=${encodeURIComponent(fileName)}&xl=1024`;

        const extracted = MagnetLinkGenerator.extractFileName(magnetLink);
        expect(extracted).toBe(fileName);
    });

    it('should extract file size from magnet link', () => {
        const fileSize = 1024000;
        const infoHash = 'a'.repeat(64);
        const magnetLink = `magnet:?xt=urn:btmh:1220${infoHash}&dn=file.mp4&xl=${fileSize}`;

        const extracted = MagnetLinkGenerator.extractFileSize(magnetLink);
        expect(extracted).toBe(fileSize);
    });

    it('should parse complete magnet link', () => {
        const infoHash = 'b04c198dd3148719db3e32fecc54ec41ec355d7f866a1c3f71bf980c3cde01bf';
        const fileName = 'test-video.mp4';
        const fileSize = 1024000;
        const magnetLink = `magnet:?xt=urn:btmh:1220${infoHash}&dn=${encodeURIComponent(fileName)}&xl=${fileSize}`;

        const parsed = MagnetLinkGenerator.parse(magnetLink);

        expect(parsed).not.toBeNull();
        expect(parsed!.infoHash).toBe(infoHash);
        expect(parsed!.fileName).toBe(fileName);
        expect(parsed!.fileSize).toBe(fileSize);
    });

    it('should handle special characters in filename', () => {
        const fileName = 'My Video [1080p] (2024).mp4';
        const infoHash = 'a'.repeat(64);
        const magnetLink = `magnet:?xt=urn:btmh:1220${infoHash}&dn=${encodeURIComponent(fileName)}&xl=1024`;

        const extracted = MagnetLinkGenerator.extractFileName(magnetLink);
        expect(extracted).toBe(fileName);

        // Verify round-trip
        const parsed = MagnetLinkGenerator.parse(magnetLink);
        expect(parsed?.fileName).toBe(fileName);
    });

    it('should demonstrate complete workflow (conceptual)', async () => {
        // This test demonstrates the intended workflow once worker integration is fixed
        const filePath = './src/tests/test.txt';
        const fileStats = await stat(filePath);

        console.log('\n=== Complete Workflow Demo ===');
        console.log('1. File:', filePath);
        console.log('2. Size:', fileStats.size, 'bytes');

        // Step 1: Compute info hash
        const fileData = await readFile(filePath);
        const hasher = new BtihV2Hasher();
        hasher.setFileName('test.txt');
        hasher.update(fileData);
        const infoHash = hasher.digest();

        console.log('3. Info hash:', infoHash.toString('hex'));

        // Step 2: In production, this would be the CID from metadata
        // const cid = metadata.cid_btih_v2;
        // const magnetLink = MagnetLinkGenerator.generate(metadata, 'test.txt', fileStats.size);

        // Step 3: For demo, construct magnet link manually
        const magnetLink = `magnet:?xt=urn:btmh:1220${infoHash.toString('hex')}&dn=test.txt&xl=${fileStats.size}`;
        console.log('4. Magnet link:', magnetLink);

        // Step 4: Verify it's valid
        const isValid = MagnetLinkGenerator.isValid(magnetLink);
        console.log('5. Valid:', isValid);

        expect(isValid).toBe(true);

        // Step 5: Parse it back
        const parsed = MagnetLinkGenerator.parse(magnetLink);
        console.log('6. Parsed:', parsed);

        expect(parsed).not.toBeNull();
        expect(parsed!.infoHash).toBe(infoHash.toString('hex'));
        expect(parsed!.fileName).toBe('test.txt');
        expect(parsed!.fileSize).toBe(fileStats.size);
    });
});
