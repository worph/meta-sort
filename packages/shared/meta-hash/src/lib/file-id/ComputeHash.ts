import {CID_ALGORITHM_CODES, CidAlgorithm} from "../hash-compute/MultiHashData";
import {create} from "multiformats/hashes/digest";
import {CID} from 'multiformats/cid';
import {SimpleHash} from "./SimpleHash";

/**
 * Compute the CIDs of a file using specific algorithms
 * @param stream The Readable stream of the file
 * @param algorithms Array of algorithms ('sha256', 'sha1', etc.)
 * @returns Array of bare CIDv1 strings, in the order of `algorithms`
 */
export async function computeCIDs({stream, algorithms, createHasher}: {
    stream: ReadableStream<Uint8Array>;
    algorithms: CidAlgorithm[];
    createHasher: (algo: CidAlgorithm) => Promise<SimpleHash>
}): Promise<string[]> {
    const hashers = await hasherDefiner(algorithms, createHasher);
    const reader = stream.getReader();
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        // Assuming the hasher can handle Uint8Array directly
        for (const item of hashers) {
            await item.hasher.update(value);
        }
    }
    return cidFinalize(hashers);
}

async function hasherDefiner(algorithms: CidAlgorithm[],
                             createHasher: (algo: CidAlgorithm) => Promise<SimpleHash>): Promise<{
    hasher: SimpleHash,
    code: CID_ALGORITHM_CODES
}[]> {
    const hashers = algorithms
        .filter(algo => algo in CID_ALGORITHM_CODES)
        .map(async algo => ({
            hasher: await createHasher(algo),
            code: CID_ALGORITHM_CODES[algo]
        }));
    return await Promise.all(hashers);
}

/**
 * Encoder convention: meta-hash sets `codec == multihash code`. The fullhash
 * plugin and the gateway instead use the raw codec (0x55) and carry the
 * algorithm only in the multihash. Both are valid CIDs for the same digest, and
 * both must decode to the same algorithm — which is why every consumer selects
 * on the **multihash code**, never the codec. See `CidDecode.ts`.
 */
async function cidFinalize(hashers: { hasher: SimpleHash, code: number }[]): Promise<string[]> {
    return await Promise.all(hashers.map(async ({code, hasher}) => {
        const hashBuffer = await hasher.digest();
        const digest = create(code, hashBuffer);
        return CID.createV1(code, digest).toString();
    }));
}
