import {CidAlgorithm, MultiHashData} from "./MultiHashData";

import {computeCIDs} from "@root/file-id/ComputeHash";
import {addCid, hasAlgorithm} from "@root/file-id/CidDecode";
import {SimpleHash} from "@root/file-id/SimpleHash";

export class HashComputer {

    constructor(private targetHash: CidAlgorithm[],
                private createHasher: (algo: CidAlgorithm) => Promise<SimpleHash>) {
    }

    async computeMissingHash(stream: ReadableStream<Uint8Array>, metadata: MultiHashData): Promise<void> {
        const cids = (metadata.cids ??= []);

        // Which digests are still missing? On a bare-CID list this costs a decode
        // per member rather than a property lookup — negligible against streaming
        // the whole file through a hasher.
        const neededHashes = this.targetHash.filter(algo => !hasAlgorithm(cids, algo));
        if (neededHashes.length === 0) {
            return;
        }

        const computed = await computeCIDs({stream, algorithms: neededHashes, createHasher: this.createHasher});
        for (const cid of computed) {
            addCid(cids, cid);
        }
    }
}
