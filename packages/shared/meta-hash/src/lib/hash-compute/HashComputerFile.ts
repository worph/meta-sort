import {CidAlgorithm, ComputeInterface, MultiHashData} from "./MultiHashData";
import {Readable} from "stream";

import {computeCIDs} from "@root/file-id/ComputeHash";
import {addCid, hasAlgorithm} from "@root/file-id/CidDecode";
import fs from "fs";
import {createHasher} from "@root/file-id/CreateHasher";

export class HashComputerFile implements ComputeInterface {

    constructor(private targetHash: CidAlgorithm[]) {
    }

    public async computeMissingHash(filePath: string, metadata: MultiHashData): Promise<void> {
        const cids = (metadata.cids ??= []);

        const neededHashes = this.targetHash.filter(algo => !hasAlgorithm(cids, algo));
        if (neededHashes.length === 0) {
            return;
        }

        const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
        const computed = await computeCIDs({stream, algorithms: neededHashes, createHasher});
        for (const cid of computed) {
            addCid(cids, cid);
        }
    }
}
