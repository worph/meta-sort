import {MultiHashData} from '../hash-compute/MultiHashData';
import {CID} from 'multiformats/cid';

/**
 * Magnet Link Generator for BitTorrent v2
 *
 * Generates BitTorrent v2 magnet links from file metadata.
 *
 * Format: magnet:?xt=urn:btmh:1220<info-hash-hex>&dn=<filename>&xl=<filesize>
 *
 * Components:
 * - xt: eXact Topic (torrent identifier)
 * - btmh: BitTorrent Merkle Hash (v2 URN scheme)
 * - 1220: Multihash prefix (0x12 = SHA-256, 0x20 = 32 bytes)
 * - info-hash-hex: 64-character hex string (32 bytes SHA-256)
 * - dn: Display Name (filename)
 * - xl: eXact Length (file size in bytes)
 *
 * Reference: BEP 52, BEP 9 (magnet URIs)
 */
export class MagnetLinkGenerator {
    /**
     * Generate BitTorrent v2 magnet link from metadata
     *
     * @param metadata - File metadata containing cid_btih_v2
     * @param fileName - Original filename for display name
     * @param fileSize - File size in bytes
     * @returns Magnet link string, or null if btih_v2 not available
     *
     * @example
     * const metadata = {cid_btih_v2: 'bafyb...'};
     * const magnet = MagnetLinkGenerator.generate(metadata, 'video.mp4', 1024000);
     * // Returns: magnet:?xt=urn:btmh:1220abc...&dn=video.mp4&xl=1024000
     */
    static generate(
        metadata: MultiHashData,
        fileName: string,
        fileSize: number
    ): string | null {
        const cidString = metadata.cid_btih_v2;
        if (!cidString) {
            return null; // BitTorrent v2 hash not computed
        }

        try {
            // Decode CID to get raw info hash
            const cid = CID.parse(cidString);
            const infoHash = cid.multihash.digest; // Raw 32-byte SHA-256 hash

            // Convert to hex for magnet link
            const infoHashHex = Buffer.from(infoHash).toString('hex');

            // Build magnet link components
            const components = [
                `xt=urn:btmh:1220${infoHashHex}`, // 1220 = multihash prefix (SHA-256, 32 bytes)
                `dn=${encodeURIComponent(fileName)}`, // Display name (URL encoded)
                `xl=${fileSize}` // Exact length in bytes
            ];

            return `magnet:?${components.join('&')}`;
        } catch (error) {
            console.error('Failed to generate magnet link from CID:', error);
            return null;
        }
    }

    /**
     * Extract info hash from magnet link
     *
     * @param magnetLink - Magnet link string
     * @returns Info hash as hex string, or null if invalid
     *
     * @example
     * const hash = MagnetLinkGenerator.extractInfoHash('magnet:?xt=urn:btmh:1220abc...');
     * // Returns: 'abc...'
     */
    static extractInfoHash(magnetLink: string): string | null {
        try {
            const match = magnetLink.match(/xt=urn:btmh:1220([0-9a-f]{64})/i);
            return match ? match[1] : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Extract filename from magnet link
     *
     * @param magnetLink - Magnet link string
     * @returns Decoded filename, or null if not present
     */
    static extractFileName(magnetLink: string): string | null {
        try {
            const match = magnetLink.match(/dn=([^&]+)/);
            return match ? decodeURIComponent(match[1]) : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Extract file size from magnet link
     *
     * @param magnetLink - Magnet link string
     * @returns File size in bytes, or null if not present
     */
    static extractFileSize(magnetLink: string): number | null {
        try {
            const match = magnetLink.match(/xl=(\d+)/);
            return match ? parseInt(match[1], 10) : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Validate BitTorrent v2 magnet link format
     *
     * @param magnetLink - Magnet link string
     * @returns True if valid BitTorrent v2 magnet link
     */
    static isValid(magnetLink: string): boolean {
        if (!magnetLink.startsWith('magnet:?')) {
            return false;
        }

        // Must have btmh (BitTorrent Merkle Hash) identifier
        if (!magnetLink.includes('xt=urn:btmh:1220')) {
            return false;
        }

        // Must have 64-character hex hash (32 bytes SHA-256)
        const hashMatch = magnetLink.match(/1220([0-9a-f]{64})/i);
        if (!hashMatch) {
            return false;
        }

        return true;
    }

    /**
     * Parse magnet link into components
     *
     * @param magnetLink - Magnet link string
     * @returns Object with parsed components, or null if invalid
     */
    static parse(magnetLink: string): {
        infoHash: string;
        fileName?: string;
        fileSize?: number;
    } | null {
        if (!this.isValid(magnetLink)) {
            return null;
        }

        const infoHash = this.extractInfoHash(magnetLink);
        if (!infoHash) {
            return null;
        }

        return {
            infoHash,
            fileName: this.extractFileName(magnetLink) || undefined,
            fileSize: this.extractFileSize(magnetLink) || undefined
        };
    }

    /**
     * Generate magnet link from CID string directly
     *
     * @param cidString - CID string (e.g., 'bafyb...')
     * @param fileName - Original filename
     * @param fileSize - File size in bytes
     * @returns Magnet link string, or null if CID invalid
     */
    static fromCID(
        cidString: string,
        fileName: string,
        fileSize: number
    ): string | null {
        return this.generate({cid_btih_v2: cidString}, fileName, fileSize);
    }
}
