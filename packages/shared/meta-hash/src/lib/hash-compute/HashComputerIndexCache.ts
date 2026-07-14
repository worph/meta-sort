import {HashComputerWorker} from "./HashComputerWorker";
import {CidAlgorithm, ComputeInterface, MultiHashData} from "./MultiHashData";
import {HashIndexManager} from "./HashIndexManager";
import {addCid, hasAlgorithm, pickCidByAlgorithm} from "@root/file-id/CidDecode";
import {stat} from "fs/promises";
import path from "path";

/**
 * The translation point between the two shapes.
 *
 * `MultiHashData` carries **bare CIDs** (`cids: string[]`) — that is what gets
 * persisted onto a record as the `cids/<cid>` key-set. The on-disk index is
 * **per-algorithm columns**, because its job is the O(1) "already computed?"
 * check. Neither shape leaks into the other; this class converts.
 */
export class HashComputerIndexCache implements ComputeInterface {
    private hashIndexManager: HashIndexManager;
    private hashComputer: HashComputerWorker;

    constructor(indexFolderPath: string, private targetHash: CidAlgorithm[] = ['sha1', 'sha256'], workerPath?: string) {
        this.hashComputer = new HashComputerWorker(targetHash, workerPath);
        this.hashIndexManager = new HashIndexManager(indexFolderPath, targetHash);
    }

    public async computeMissingHash(filePath: string, metadata: MultiHashData): Promise<void> {
        await this.hashIndexManager.init();
        const stats = await stat(filePath);
        const cids = (metadata.cids ??= []);

        // Cache hit: lift the cached CIDs into the bare list.
        if (this.hashIndexManager.hasFileInCache(path.basename(filePath), stats)) {
            const indexLine = this.hashIndexManager.getCidForFile(filePath, stats.size, stats.mtime.toISOString());
            if (indexLine) {
                for (const algo of this.targetHash) {
                    const cached = indexLine[algo];
                    if (cached && !hasAlgorithm(cids, algo)) {
                        addCid(cids, cached);
                    }
                }
            }
        }

        // Compute whatever is still missing (a no-op on a full cache hit).
        await this.hashComputer.computeMissingHash(filePath, metadata);

        // Write back: project the bare list onto the index's per-algorithm columns.
        const columns: Partial<Record<CidAlgorithm, string>> = {};
        for (const algo of this.targetHash) {
            const cid = pickCidByAlgorithm(cids, algo);
            if (cid) {
                columns[algo] = cid;
            }
        }
        if (Object.keys(columns).length > 0) {
            this.hashIndexManager.addFileCid(filePath, stats.size, stats.mtime.toISOString(), columns);
        }
    }

    async getHashIndexManager(): Promise<HashIndexManager> {
        await this.hashIndexManager.init();
        return this.hashIndexManager;
    }
}