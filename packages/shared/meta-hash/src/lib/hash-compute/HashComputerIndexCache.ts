import {HashComputerWorker} from "./HashComputerWorker";
import {CID_ALGORITHM_NAMES, ComputeInterface, MultiHashData} from "./MultiHashData";
import {HashIndexManager} from "./HashIndexManager";
import {stat} from "fs/promises";
import path from "path";

export class HashComputerIndexCache implements ComputeInterface {
    private hashIndexManager: HashIndexManager;
    private hashComputer: HashComputerWorker;

    constructor(indexFolderPath: string,private targetHash: CID_ALGORITHM_NAMES[] = [CID_ALGORITHM_NAMES.sha1, CID_ALGORITHM_NAMES.sha256],workerPath?:string) {
        this.hashComputer = new HashComputerWorker(targetHash,workerPath);
        this.hashIndexManager = new HashIndexManager(indexFolderPath,targetHash);
    }

    public async computeMissingHash(filePath: string, metadata: MultiHashData): Promise<void> {
        await this.hashIndexManager.init();
        let stats = await stat(filePath);
        if (this.hashIndexManager.hasFileInCache(path.basename(filePath),stats)) {
            const indexLine = this.hashIndexManager.getCidForFile(filePath, stats.size, stats.mtime.toISOString());
            if(indexLine) {
                for (const hash of this.targetHash) {
                    if (!metadata[hash] && indexLine[hash]) {
                        metadata[hash] = indexLine[hash];
                    }
                }
            }
        }
        await this.hashComputer.computeMissingHash(filePath, metadata);
        this.hashIndexManager.addFileCid(filePath, stats.size, stats.mtime.toISOString(), metadata);
    }

    async getHashIndexManager(): Promise<HashIndexManager> {
        await this.hashIndexManager.init();
        return this.hashIndexManager;
    }
}