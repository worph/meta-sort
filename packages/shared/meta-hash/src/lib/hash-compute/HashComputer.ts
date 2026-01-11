import {CID_ALGORITHM_NAMES, MultiHashData} from "./MultiHashData";

import {computeCIDs} from "@root/file-id/ComputeHash";
import {SimpleHash} from "@root/file-id/SimpleHash";

export class HashComputer{

    constructor(private targetHash: CID_ALGORITHM_NAMES[],
                private createHasher : (algo: CID_ALGORITHM_NAMES) => Promise<SimpleHash>) {
    }

    async computeMissingHash(stream: ReadableStream<Uint8Array>, metadata: MultiHashData): Promise<void> {
        // Dynamically determine which hashes are needed
        const neededHashes = this.targetHash.filter(hashName => !metadata[hashName]);

        // If all hashes are already computed, skip the processing
        if (neededHashes.length === 0) {
            return;
        }

        // Compute only the needed CIDs
        const cids = await computeCIDs({stream, algorithms:neededHashes,createHasher:this.createHasher});

        // Map the computed CIDs back to their respective metadata properties
        for (const [index, cid] of cids.entries()) {
            const hashType = neededHashes[index];
            metadata[hashType] = cid;
        }
    }
}
