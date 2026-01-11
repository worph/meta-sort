import {CID_ALGORITHM_NAMES} from "../hash-compute/MultiHashData";
import {SimpleHash} from "./SimpleHash";
import {Crc32Hash} from "./Crc32Hash";
import {BrowserHasher} from "@root/file-id/BrowserHasher";

export async function createHasher(algo: CID_ALGORITHM_NAMES): Promise<SimpleHash> {
    const hasher = (() => {
        switch (algo) {
            case CID_ALGORITHM_NAMES.sha256:
                return new BrowserHasher('sha-256');
            case CID_ALGORITHM_NAMES.sha1:
                return new BrowserHasher('sha-1');
            case CID_ALGORITHM_NAMES.md5:
                return new BrowserHasher('md5');
            case CID_ALGORITHM_NAMES.sha3_256:
                return new BrowserHasher('sha3-256');
            case CID_ALGORITHM_NAMES.sha3_384:
                return new BrowserHasher('sha3-384');
            case CID_ALGORITHM_NAMES.crc32:
                return new Crc32Hash();
            default:
                throw new Error(`Unsupported algorithm: ${algo}`);
        }
    })();

    if (hasher instanceof BrowserHasher) {
        await hasher.initialize();
    }

    return hasher;
}