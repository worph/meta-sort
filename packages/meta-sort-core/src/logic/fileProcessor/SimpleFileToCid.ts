import {CID_ALGORITHM_NAMES, HashComputerFile} from "@metazla/meta-hash";
import {HashIndexManager} from "@metazla/meta-hash";
import {config} from "../../config/EnvConfig.js";
import {targetHash, targetHashForIndex} from "../../config/TargetHash.js";
import {stat} from "fs/promises";


export const globalHashIndex = new HashIndexManager(config.INDEX_FOLDER_PATH, targetHashForIndex);
export const globalHashComputer = new HashComputerFile(targetHash);

class SimpleFileToCid{

    async getcid(filePath: string): Promise<string | null> {
        try {
            const stats = await stat(filePath);
            let indexLine = globalHashIndex.getCidForFile(filePath, stats.size, stats.mtime.toISOString());
            if(indexLine) {
                return indexLine[CID_ALGORITHM_NAMES.sha256];
            }else {
                let hashs = {};
                await globalHashComputer.computeMissingHash(filePath, hashs);
                globalHashIndex.addFileCid(filePath, stats.size, stats.mtime.toISOString(), hashs);
                return hashs[CID_ALGORITHM_NAMES.sha256];
            }
        } catch (e) {
            return null;
        }
    }
}

export const simpleFileToCid = new SimpleFileToCid();