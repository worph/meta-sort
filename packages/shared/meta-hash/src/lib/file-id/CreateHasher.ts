import {CID_ALGORITHM_NAMES} from "../hash-compute/MultiHashData";
import {SimpleHash} from "./SimpleHash";
import {createHash} from "crypto";
import {Crc32Hash} from "./Crc32Hash";
import {BtihV2Hasher} from "./BtihV2Hasher";

/**
 * Compute the CIDs of a file using specific algorithms
 * @returns Array of CIDs (in the order of the algorithms)
 * @param algo
 */
export async function createHasher(algo: CID_ALGORITHM_NAMES): Promise<SimpleHash> {
    switch (algo) {
        case CID_ALGORITHM_NAMES.sha256:
            return createHash("sha256");
        case CID_ALGORITHM_NAMES.sha1:
            return createHash("sha1");
        case CID_ALGORITHM_NAMES.md5:
            return createHash("md5");
        case CID_ALGORITHM_NAMES.sha3_256:
            return createHash("sha3-256");
        case CID_ALGORITHM_NAMES.sha3_384:
            return createHash("sha3-384");
        case CID_ALGORITHM_NAMES.crc32:
            return new Crc32Hash();
        case CID_ALGORITHM_NAMES.btih_v2:
            return new BtihV2Hasher();
        default:
            throw new Error(`Unsupported algorithm: ${algo}`);
    }
}