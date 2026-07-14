import {CidAlgorithm} from "@metazla/meta-hash";

// Target hashes for Piscina worker (full-file hash computation)
// Note: midhash256 is NOT included here because it's computed in the main thread
// during light processing, not by the Piscina worker
//
// These are algorithm *selectors*, not metadata field names. The old
// `CID_ALGORITHM_NAMES` enum ('cid_sha2-256', …) served as both, which is how the
// removed `cid_<algo>` record fields kept getting minted in the first place.
// Digests are now persisted only as bare-CID key-set members (`cids/<cid>`).
// See METADATA_KEYS.md §2/§14.13.
export const targetHash: CidAlgorithm[] = [
    'sha1',        // For torrent verification
    'sha256',      // For IPFS compatibility
    'md5',         // For compatibility
    'sha3_256',    // Additional cryptographic hash
    'sha3_384',    // Additional cryptographic hash
    'crc32',       // Fast checksum
    'btih_v2',     // BitTorrent v2 info hash (BEP 52)
]

// Target hashes for index-cid cache (includes all hashes we want to cache)
// This includes midhash256 which is computed separately from the worker hashes
export const targetHashForIndex: CidAlgorithm[] = [
    ...targetHash,
    'midhash256',  // Fast hash for file identification (computed in light processing)
]
