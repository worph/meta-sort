/**
 * HashMeta - Content identification hashes
 *
 * Primary Global ID: cid_midhash256 (SHA-256 hash of middle 1MB + file size)
 * - Format: CID v1 with custom multicodec 0x1000
 * - Example: bafkr4ih5kapbjzqvmj7jxr... (base32 CID encoding)
 *
 * Legacy IDs: cid_sha2-256, cid_sha1 (computed optionally for compatibility)
 *
 * Migration Note: cid_midhash256 is the new primary identifier replacing full SHA-256.
 * Old hashes remain for backward compatibility and external system integration.
 * All CIDs now use proper CID v1 format (IPFS-compatible structure).
 */
export interface HashMeta {
    cid_crc32?: string; //0x0132 CRC32 (SFV)
    cid_md5?: string; // 0xd5 md5
    cid_sha1?: string; // 0x11 sha1
    "cid_sha2-256"?: string;//0x12 sha2-256
    "cid_sha3-256"?: string; // 0x16 sha3-256
    "cid_sha3_384"?: string; // 0x16 sha3-256
    cid_midhash256?: string; // 0x1000 midhash256 (CID v1 format with custom multicodec)
}

export const HashMetaFields = [
    "cid_crc32",
    "cid_md5",
    "cid_sha1",
    "cid_sha2-256",
    "cid_sha3-256",
    "cid_sha3_384",
    "cid_midhash256",
];