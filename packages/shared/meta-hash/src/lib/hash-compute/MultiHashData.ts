export interface MultiHashData {
    cid_crc32?: string; //0x0132 CRC32 (SFV)
    cid_md5?: string; // 0xd5 md5
    cid_sha1?: string; // 0x11 sha1
    "cid_sha2-256"?: string;//0x12 sha2-256
    "cid_sha3-256"?: string; // 0x16 sha3-256
    "cid_sha3_384"?: string; // 0x16 sha3-256
    cid_midhash256?: string; // 0x1000 midhash256 (SHA-256 of middle 1MB + file size) - CID v1 format
    cid_btih_v2?: string; // 0x10B7 BitTorrent v2 info hash (BEP 52) - CID v1 format
}

export interface ComputeInterface {
    computeMissingHash(filePath: string, metadata: MultiHashData): Promise<void>;
}

/**
 * according to
 * https://ipfs.io/ipfs/QmXec1jjwzxWJoNbxQF5KffL8q6hFXm9QwUGaa3wKGk6dT/#title=Multicodecs&src=https://raw.githubusercontent.com/multiformats/multicodec/master/table.csv
 */
export enum CID_ALGORITHM_CODES {
    crc32 = 0x0132,
    md5 = 0xd5,
    sha1 = 0x11,
    sha256 = 0x12,
    sha3_256 = 0x16,
    sha3_384 = 0x15,
    midhash256 = 0x1000, // Custom code for midhash256
    btih_v2 = 0x10B7, // Custom code for BitTorrent v2 info hash
}

export enum CID_ALGORITHM_NAMES {
    crc32 = 'cid_crc32',
    md5 = 'cid_md5',
    sha1 = 'cid_sha1',
    sha256 = 'cid_sha2-256',
    sha3_256 = 'cid_sha3-256',
    sha3_384 = 'cid_sha3-384',
    midhash256 = 'cid_midhash256',
    btih_v2 = 'cid_btih_v2',
}

export enum CID_ALGORITHM {
    crc32 = 'crc32',
    md5 = 'md5',
    sha1 = 'sha1',
    sha256 = 'sha2-256',
    sha3_256 = 'sha3-256',
    sha3_384 = 'sha3-384',
    midhash256 = 'midhash256',
    btih_v2 = 'btih-v2',
}