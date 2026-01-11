import {CID_ALGORITHM_CODES, CID_ALGORITHM_NAMES} from "../hash-compute/MultiHashData";
import {create} from "multiformats/hashes/digest";
import {CID} from 'multiformats/cid';
import {SimpleHash} from "./SimpleHash";
import {codeTable} from "@root/file-id/CodeTable";

/**
 * Compute the CIDs of a file using specific algorithms
 * @param stream The Readable stream of the file
 * @param algorithms Array of algorithms ('sha256', 'sha1', etc.)
 * @returns Array of CIDs (in the order of the algorithms)
 */
export async function computeCIDs({stream, algorithms,createHasher}: {
    stream: ReadableStream<Uint8Array>;
    algorithms: CID_ALGORITHM_NAMES[];
    createHasher : (algo: CID_ALGORITHM_NAMES) => Promise<SimpleHash>
}): Promise<string[]> {
    const hashers = await hasherDefiner(algorithms,createHasher);
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

async function hasherDefiner(algorithms: CID_ALGORITHM_NAMES[],
                             createHasher : (algo: CID_ALGORITHM_NAMES) => Promise<SimpleHash>): Promise<{
    hasher: SimpleHash,
    code: CID_ALGORITHM_CODES
}[]> {
    const hashers = algorithms.filter(algo => Object.values(CID_ALGORITHM_NAMES).includes(algo))
        .map(async algo => ({
            hasher: await createHasher(algo),
            code: codeTable[algo]
        }));
    return await Promise.all(hashers);
}

async function cidFinalize(hashers: { hasher: SimpleHash, code: number }[]): Promise<string[]> {
    return await Promise.all(hashers.map(async ({code, hasher}) => {
        const hashBuffer = await hasher.digest();
        const digest = create(code, hashBuffer);
        return CID.createV1(code, digest).toString();
    }));
}