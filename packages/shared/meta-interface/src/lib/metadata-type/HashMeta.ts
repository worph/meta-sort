/**
 * HashMeta - Content identification hashes.
 *
 * Sibling CIDs are NOT stored as per-algorithm fields anymore. Every digest
 * of the file (sha2-256, sha1, md5, crc32, sha3-*, midhash256, btih-v2, …)
 * lives in a single bare-CID key-set on the record:
 *
 *     cids/<cidV1> = "true"
 *
 * A CIDv1 is self-describing — its algorithm is the multicodec — so there is
 * no per-algorithm field name and no `<algo>:` prefix. The canonical /
 * network CID is derived by rank from this set on read, never stored. The
 * midhash stays the file's address (hashId). See METADATA_KEYS.md §2/§14.13.
 *
 * Because the members are dynamic keys (`cids/<cid>`), they can't be typed as
 * named fields here; consumers read them by prefix-scanning the flat record
 * and recover the algorithm from each CID's multicodec.
 */
export interface HashMeta {
    // Intentionally empty: sibling CIDs are the `cids/<cid>` key-set (above),
    // not typed fields. Kept as a named type so existing `extends HashMeta`
    // composition sites stay valid.
}