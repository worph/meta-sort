import {CidAlgorithm} from "../hash-compute/MultiHashData";
import {SimpleHash} from "./SimpleHash";
import {createHash} from "crypto";
import {Crc32Hash} from "./Crc32Hash";
import {BtihV2Hasher} from "./BtihV2Hasher";

/**
 * Build the stream hasher for one algorithm.
 *
 * `midhash256` is absent on purpose: it is not a stream digest (it hashes the
 * file size plus the middle 1 MB), so it is produced by `FastHash.ts` instead.
 */
export async function createHasher(algo: CidAlgorithm): Promise<SimpleHash> {
    switch (algo) {
        case 'sha256':
            return createHash("sha256");
        case 'sha1':
            return createHash("sha1");
        case 'md5':
            return createHash("md5");
        case 'sha3_256':
            return createHash("sha3-256");
        case 'sha3_384':
            return createHash("sha3-384");
        case 'crc32':
            return new Crc32Hash();
        case 'btih_v2':
            return new BtihV2Hasher();
        default:
            throw new Error(`Unsupported algorithm: ${algo}`);
    }
}
