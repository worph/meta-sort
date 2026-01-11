import {createHash} from 'crypto';
import {SimpleHash} from './SimpleHash';
import {encode} from 'bencodec';
import {basename} from 'path';

/**
 * BitTorrent v2 Info Hash Hasher (BEP 52)
 *
 * Implements BitTorrent v2 file hashing with:
 * - Fixed 16KB block size
 * - SHA-256 merkle tree
 * - Info hash computation
 *
 * Architecture:
 * 1. Streaming: Accumulates file data into 16KB blocks
 * 2. Block hashing: SHA-256 hash each complete block
 * 3. Merkle tree: Build balanced tree from block hashes
 * 4. Info hash: SHA-256(bencode(info_dict))
 */
export class BtihV2Hasher implements SimpleHash {
    private static readonly BLOCK_SIZE = 16 * 1024; // 16KB fixed by BEP 52

    private blockHashes: Buffer[] = [];
    private currentBlock: Buffer[] = [];
    private currentBlockSize: number = 0;
    private fileSize: number = 0;
    private fileName: string = 'unknown';

    /**
     * Optional: Set filename for info dictionary
     * If not set, defaults to 'unknown'
     */
    setFileName(fileName: string): void {
        this.fileName = basename(fileName);
    }

    /**
     * Update hasher with new data chunk
     * Accumulates chunks into 16KB blocks and hashes each complete block
     */
    update(data: Uint8Array): SimpleHash {
        const buffer = Buffer.from(data);
        this.fileSize += buffer.length;

        let offset = 0;
        while (offset < buffer.length) {
            const remaining = BtihV2Hasher.BLOCK_SIZE - this.currentBlockSize;
            const toRead = Math.min(remaining, buffer.length - offset);

            // Accumulate chunk into current block
            this.currentBlock.push(buffer.subarray(offset, offset + toRead));
            this.currentBlockSize += toRead;
            offset += toRead;

            // When block is complete, hash it
            if (this.currentBlockSize === BtihV2Hasher.BLOCK_SIZE) {
                this.finalizeBlock();
            }
        }

        return this;
    }

    /**
     * Finalize current block by hashing it and storing the hash
     */
    private finalizeBlock(): void {
        if (this.currentBlock.length === 0) return;

        const blockData = Buffer.concat(this.currentBlock);
        const blockHash = createHash('sha256').update(blockData).digest();
        this.blockHashes.push(blockHash);

        // Reset current block
        this.currentBlock = [];
        this.currentBlockSize = 0;
    }

    /**
     * Compute final info hash
     *
     * Steps:
     * 1. Finalize any partial block
     * 2. Build merkle tree from block hashes
     * 3. Construct info dictionary (name, length, pieces_root)
     * 4. Bencode info dict
     * 5. SHA-256 of bencoded data = info hash
     */
    digest(): Buffer {
        // Finalize any remaining partial block
        if (this.currentBlockSize > 0) {
            this.finalizeBlock();
        }

        // Handle empty file edge case
        if (this.blockHashes.length === 0) {
            // Empty file: hash empty block
            const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest();
            this.blockHashes.push(emptyHash);
        }

        // Build merkle tree to get pieces root
        const piecesRoot = this.buildMerkleTree(this.blockHashes);

        // Construct info dictionary (BEP 52 v2 format)
        const infoDict = {
            name: this.fileName,
            length: this.fileSize,
            'piece length': this.computePieceLength(this.fileSize),
            'pieces root': piecesRoot,
            'meta version': 2 // BitTorrent v2
        };

        // Bencode the info dictionary
        const bencodedInfo = encode(infoDict);

        // Info hash = SHA-256 of bencoded info dict
        const infoHash = createHash('sha256').update(bencodedInfo).digest();

        return infoHash;
    }

    /**
     * Build balanced merkle tree from leaf hashes
     *
     * Algorithm (from BEP 52 reference implementation):
     * 1. Pad to power of 2 with zero hashes
     * 2. Recursively pair adjacent hashes
     * 3. Hash each pair: SHA-256(left || right)
     * 4. Repeat until single root hash remains
     */
    private buildMerkleTree(hashes: Buffer[]): Buffer {
        if (hashes.length === 0) {
            throw new Error('Cannot build merkle tree from empty hash list');
        }

        // Pad to next power of 2 with zero hashes
        let paddedHashes = [...hashes];
        const targetSize = this.nextPowerOfTwo(paddedHashes.length);
        const zeroHash = Buffer.alloc(32); // 32 bytes of zeros for SHA-256
        while (paddedHashes.length < targetSize) {
            paddedHashes.push(zeroHash);
        }

        // Build tree by repeatedly pairing and hashing
        while (paddedHashes.length > 1) {
            const parentHashes: Buffer[] = [];

            for (let i = 0; i < paddedHashes.length; i += 2) {
                const left = paddedHashes[i];
                const right = paddedHashes[i + 1];
                const combined = Buffer.concat([left, right]);
                const parentHash = createHash('sha256').update(combined).digest();
                parentHashes.push(parentHash);
            }

            paddedHashes = parentHashes;
        }

        return paddedHashes[0];
    }

    /**
     * Compute piece length using BEP 52 formula
     *
     * Formula: piece_length = 16KB * 2^n
     * where: file_size / piece_length < 2048
     *
     * This ensures each file has between 1024 and 2047 pieces
     */
    private computePieceLength(fileSize: number): number {
        if (fileSize === 0) {
            return BtihV2Hasher.BLOCK_SIZE; // 16KB for empty files
        }

        let pieceLength = BtihV2Hasher.BLOCK_SIZE; // Start at 16KB
        const maxPieces = 2048;

        // Increase piece length until we have < 2048 pieces
        while (Math.ceil(fileSize / pieceLength) >= maxPieces) {
            pieceLength *= 2;
        }

        return pieceLength;
    }

    /**
     * Find next power of 2 >= n
     */
    private nextPowerOfTwo(n: number): number {
        if (n === 0) return 1;
        n--;
        n |= n >> 1;
        n |= n >> 2;
        n |= n >> 4;
        n |= n >> 8;
        n |= n >> 16;
        return n + 1;
    }
}
