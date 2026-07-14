import {CidAlgorithm} from "../hash-compute/MultiHashData";
import {SimpleHash} from "./SimpleHash";
import {Crc32Hash} from "./Crc32Hash";
import {BrowserHasher} from "@root/file-id/BrowserHasher";

/**
 * Browser build. Note it supports fewer algorithms than the node one: there is
 * no `btih_v2` (and no `midhash256`, which is never a stream hash) — asking for
 * either throws.
 */
export async function createHasher(algo: CidAlgorithm): Promise<SimpleHash> {
    const hasher = (() => {
        switch (algo) {
            case 'sha256':
                return new BrowserHasher('sha-256');
            case 'sha1':
                return new BrowserHasher('sha-1');
            case 'md5':
                return new BrowserHasher('md5');
            case 'sha3_256':
                return new BrowserHasher('sha3-256');
            case 'sha3_384':
                return new BrowserHasher('sha3-384');
            case 'crc32':
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
