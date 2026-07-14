import {CidAlgorithm, HashComputerFile, MultiHashData, pickCidByAlgorithm} from "@metazla/meta-hash";
import {HashIndexManager} from "@metazla/meta-hash";
import {config} from "../../config/EnvConfig.js";
import {targetHash, targetHashForIndex} from "../../config/TargetHash.js";
import * as webdav from '../../webdav/WebdavClient.js';


export const globalHashIndex = new HashIndexManager(config.INDEX_FOLDER_PATH, targetHashForIndex);
export const globalHashComputer = new HashComputerFile(targetHash);

class SimpleFileToCid{

    async getcid(filePath: string): Promise<string | null> {
        try {
            const stats = await webdav.stat(filePath);
            if (!stats || !stats.exists) {
                return null;
            }
            const indexLine = globalHashIndex.getCidForFile(filePath, stats.size, stats.mtime.toISOString());
            if (indexLine) {
                // The on-disk index keeps per-algorithm columns, keyed by bare
                // algorithm name (not the removed `cid_<algo>` record fields).
                return indexLine['sha256'] ?? null;
            }

            // The computer returns bare CIDs; the algorithm is recovered from the
            // multicodec, never from a field name.
            const hashes: MultiHashData = {};
            await globalHashComputer.computeMissingHash(filePath, hashes);

            const columns: Partial<Record<CidAlgorithm, string>> = {};
            for (const algo of targetHash) {
                const cid = pickCidByAlgorithm(hashes.cids, algo);
                if (cid) {
                    columns[algo] = cid;
                }
            }
            if (Object.keys(columns).length > 0) {
                globalHashIndex.addFileCid(filePath, stats.size, stats.mtime.toISOString(), columns);
            }

            return pickCidByAlgorithm(hashes.cids, 'sha256') ?? null;
        } catch (e) {
            return null;
        }
    }
}

export const simpleFileToCid = new SimpleFileToCid();
