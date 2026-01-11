import {CID_ALGORITHM_NAMES} from "@metazla/meta-hash";

// Target hashes for Piscina worker (full-file hash computation)
// Note: midhash256 is NOT included here because it's computed in the main thread
// during light processing, not by the Piscina worker
export const targetHash = [
    CID_ALGORITHM_NAMES.sha1,        // For torrent verification
    CID_ALGORITHM_NAMES.sha256,      // For IPFS compatibility
    CID_ALGORITHM_NAMES.md5,         // For compatibility
    CID_ALGORITHM_NAMES.sha3_256,    // Additional cryptographic hash
    CID_ALGORITHM_NAMES.sha3_384,    // Additional cryptographic hash
    CID_ALGORITHM_NAMES.crc32,       // Fast checksum
    CID_ALGORITHM_NAMES.btih_v2      // BitTorrent v2 info hash (BEP 52)
]

// Target hashes for index-cid cache (includes all hashes we want to cache)
// This includes midhash256 which is computed separately from the worker hashes
export const targetHashForIndex = [
    ...targetHash,
    CID_ALGORITHM_NAMES.midhash256   // Fast hash for file identification (computed in light processing)
]