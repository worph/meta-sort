import {FileIDComputerWorker} from "../file-id/FileIDComputerWorker";
import {CID_ALGORITHM_NAMES, ComputeInterface, MultiHashData} from "./MultiHashData";

export class HashComputerWorker implements ComputeInterface {
    private fileIDComputer: FileIDComputerWorker;

    constructor(private targetHash: CID_ALGORITHM_NAMES[], workerPath?: string) {
        this.fileIDComputer = new FileIDComputerWorker(workerPath);
    }

    async computeMissingHash(filePath: string, metadata: MultiHashData): Promise<void> {
        // Dynamically determine which hashes are needed
        const neededHashes = this.targetHash.filter(hashName => !metadata[hashName]);

        // If all hashes are already computed, skip the processing
        if (neededHashes.length === 0) {
            return;
        }

        // Compute only the needed CIDs
        const cids = await this.fileIDComputer.computeCIDs(filePath, neededHashes);

        // Map the computed CIDs back to their respective metadata properties
        for (const [index, cid] of cids.entries()) {
            const hashType = neededHashes[index];
            metadata[hashType] = cid;
        }
    }
}
