import {Piscina} from "piscina";
import {CID_ALGORITHM_NAMES} from "../hash-compute/MultiHashData";

export class FileIDComputerWorker{
    private piscina: Piscina;

    constructor(workerPath?:string) {
        if(!workerPath) {
            // Construct the URL for the current module
            let distFolder = import.meta.dirname;
            distFolder = distFolder.replace('src', 'dist');
            distFolder = distFolder + "/worker.js";
            workerPath = new URL(distFolder,"file://").href;
        }
        this.piscina = new Piscina({
            maxThreads: 4,
            //filename: new URL('./ShaComputeWorker.ts', import.meta.url).href
            filename: workerPath
        });
    }

    /**
     * Compute the CIDs of a file using specific algorithms
     * @param filePath The path to the file
     * @param algorithms Array of algorithms ('sha256', 'sha1')
     * @returns Array of CIDs (in the order of the algorithms)
     */
    public async computeCIDs(filePath: string, algorithms: CID_ALGORITHM_NAMES[]): Promise<string[]> {
        return this.piscina.run({filePath, algorithms});
    }
}
