import {CID_ALGORITHM_NAMES, ComputeInterface, MultiHashData} from "./MultiHashData";
import {Readable} from "stream";

import {computeCIDs} from "@root/file-id/ComputeHash";
import fs from "fs";
import {createHasher} from "@root/file-id/CreateHasher";

export class HashComputerFile implements ComputeInterface{

    constructor(private targetHash: CID_ALGORITHM_NAMES[]) {
    }

    public async computeMissingHash(filePath: string, metadata: MultiHashData): Promise<void> {
        // Dynamically determine which hashes are needed
        const neededHashes = this.targetHash.filter(hashName => !metadata[hashName]);

        // If all hashes are already computed, skip the processing
        if (neededHashes.length === 0) {
            return;
        }

        // Compute only the needed CIDs
        const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
        const cids = await computeCIDs({stream, algorithms:neededHashes,createHasher});

        // Map the computed CIDs back to their respective metadata properties
        for (const [index, cid] of cids.entries()) {
            const hashType = neededHashes[index];
            metadata[hashType] = cid;
        }
    }
}
