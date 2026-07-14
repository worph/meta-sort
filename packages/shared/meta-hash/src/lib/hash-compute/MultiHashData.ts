/**
 * Multicodec / multihash codes for every digest meta-hash can compute.
 *
 * Source of truth for these numbers, mirrored in:
 *   - `packages/meta-core/internal/cid/rank.go`
 *   - the `cid_rank.rs` in each of meta-search and meta-share
 *   - `/cid-rank-vectors.json` (the golden fixture that pins them all together)
 *
 * ⚠ meta-hash encodes `codec == multihash code` (see `ComputeHash.cidFinalize`:
 * `CID.createV1(code, create(code, digest))`), whereas the fullhash plugin and
 * the gateway wrap every digest with the **raw** codec `0x55` and put the
 * algorithm in the multihash code. The multihash code is the algorithm in both
 * conventions — so anything selecting a CID by algorithm must read the
 * **multihash code**, never the content codec. See `CidDecode.ts`.
 *
 * https://github.com/multiformats/multicodec/blob/master/table.csv
 */
export enum CID_ALGORITHM_CODES {
    crc32 = 0x0132,
    md5 = 0xd5,
    sha1 = 0x11,
    sha256 = 0x12,
    sha3_256 = 0x16,
    sha3_384 = 0x15,
    midhash256 = 0x1000, // Custom — SHA-256(size ‖ middle 1MB)
    btih_v2 = 0x10B7, // Custom — BitTorrent v2 info hash (BEP 52)
}

/**
 * An algorithm *selector*: which digests to compute, and which column of the
 * local hash-index cache to read.
 *
 * This is deliberately **not** a metadata field name. The old
 * `CID_ALGORITHM_NAMES` enum ('cid_sha2-256', 'cid_midhash256', …) did triple
 * duty — selector, record property name, and CSV column — and the middle duty
 * was the deprecated one: those `cid_<algo>` fields were stored on records but
 * never reverse-indexed by meta-core, leaving records unresolvable by their own
 * CID. meta-core now rejects them at the write boundary (400). See
 * METADATA_KEYS.md §2/§14.13.
 *
 * The triple duty also rotted on its own: the interface declared `cid_sha3_384`
 * (underscore) while the enum emitted `'cid_sha3-384'` (hyphen), and the doc
 * comment on it named the wrong multicodec. A self-describing CID cannot drift
 * from its own name that way.
 */
export type CidAlgorithm = keyof typeof CID_ALGORITHM_CODES;

/** Every algorithm meta-hash knows how to compute. */
export const CID_ALGORITHMS: CidAlgorithm[] = [
    'crc32',
    'md5',
    'sha1',
    'sha256',
    'sha3_256',
    'sha3_384',
    'midhash256',
    'btih_v2',
];

/**
 * The output of a hash computation: **bare CIDv1 strings, nothing else**.
 *
 * A CIDv1 is self-describing — its algorithm is the multicodec — so there is no
 * per-algorithm field name to keep in sync, and no `<algo>:` prefix. To find a
 * specific digest, decode the members (`pickCidByAlgorithm` in `CidDecode.ts`).
 *
 * This is persisted onto a record as the bare-CID key-set
 * (`cids/<cid> = "true"`), which is the only shape meta-core indexes.
 */
export interface MultiHashData {
    cids?: string[];
}

export interface ComputeInterface {
    computeMissingHash(filePath: string, metadata: MultiHashData): Promise<void>;
}
