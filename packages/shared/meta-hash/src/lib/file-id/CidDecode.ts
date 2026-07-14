import {CID} from 'multiformats/cid';
import {CID_ALGORITHM_CODES, CidAlgorithm} from '../hash-compute/MultiHashData';

/**
 * Decoding a bare CIDv1 back into the algorithm that produced it.
 *
 * This is **the** TypeScript CID decoder for the platform. It exists because a
 * bare-CID key-set (`cids/<cid>`) carries no field names — a consumer that wants
 * "the sha2-256 of this file" has to ask the multicodec, not a string.
 *
 * Before this module, meta-dup carried a private hand-rolled base32+uvarint
 * decoder, the meta-sort editor carried a second one with a *different* rank
 * ladder, and meta-fuse had none at all (so it could only read the legacy
 * `cid_midhash256` field, and silently failed on any record that didn't have
 * one). One implementation, exported, replaces all three.
 *
 * ⚠ **Always match on the multihash code, never the content codec.** MetaMesh
 * has two encoders that disagree about the codec: meta-hash writes
 * `codec == algorithm code`, while the fullhash plugin and the gateway wrap
 * every digest with the raw codec `0x55`. The multihash code is the algorithm in
 * both. (`packages/meta-core/internal/cid/rank.go` documents the same trap.)
 */

/** The multihash function code of a bare CID, or `undefined` if it won't parse. */
export function cidMultihashCode(cid: string): number | undefined {
    try {
        return CID.parse(cid).multihash.code;
    } catch {
        return undefined;
    }
}

/** The content codec of a bare CID, or `undefined` if it won't parse. */
export function cidCodec(cid: string): number | undefined {
    try {
        return CID.parse(cid).code;
    } catch {
        return undefined;
    }
}

/**
 * The first member of `cids` whose multihash code is `mhCode`.
 *
 * Takes the raw code so callers can ask for digests meta-hash doesn't itself
 * compute (e.g. the gateway's per-file btih codes).
 */
export function pickCidByMulticodec(
    cids: readonly string[] | undefined,
    mhCode: number
): string | undefined {
    return cids?.find(cid => cidMultihashCode(cid) === mhCode);
}

/** The member of `cids` produced by `algo`, if present. */
export function pickCidByAlgorithm(
    cids: readonly string[] | undefined,
    algo: CidAlgorithm
): string | undefined {
    return pickCidByMulticodec(cids, CID_ALGORITHM_CODES[algo]);
}

/**
 * Has `algo` already been computed for this cid set?
 *
 * The "skip if already computed" check. It used to be an O(1) property lookup
 * (`metadata['cid_sha2-256']`); on a bare list it costs a decode per member.
 * That is a handful of microseconds against a hash computation that streams the
 * whole file — the trade is not close.
 */
export function hasAlgorithm(cids: readonly string[] | undefined, algo: CidAlgorithm): boolean {
    return pickCidByAlgorithm(cids, algo) !== undefined;
}

/**
 * Add `cid` to `cids` unless an equal string is already there.
 *
 * Dedup is on the exact string. Two encoders can spell the same digest
 * differently (codec 0x55 vs codec == mh), and both spellings are legitimate
 * members — meta-core's reverse index maps each to the same record.
 */
export function addCid(cids: string[], cid: string): void {
    if (cid && !cids.includes(cid)) {
        cids.push(cid);
    }
}
