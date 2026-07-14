import {FileIDComputerWorker} from "../file-id/FileIDComputerWorker";
import {CidAlgorithm, ComputeInterface, MultiHashData} from "./MultiHashData";
import {addCid, hasAlgorithm} from "@root/file-id/CidDecode";

export class HashComputerWorker implements ComputeInterface {
    private fileIDComputer: FileIDComputerWorker;

    constructor(private targetHash: CidAlgorithm[], workerPath?: string) {
        this.fileIDComputer = new FileIDComputerWorker(workerPath);
    }

    async computeMissingHash(filePath: string, metadata: MultiHashData): Promise<void> {
        const cids = (metadata.cids ??= []);

        const neededHashes = this.targetHash.filter(algo => !hasAlgorithm(cids, algo));
        if (neededHashes.length === 0) {
            return;
        }

        const computed = await this.fileIDComputer.computeCIDs(filePath, neededHashes);
        for (const cid of computed) {
            addCid(cids, cid);
        }
    }
}
