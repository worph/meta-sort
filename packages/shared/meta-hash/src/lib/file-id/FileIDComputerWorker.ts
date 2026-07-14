import {Piscina} from "piscina";
import {CidAlgorithm} from "../hash-compute/MultiHashData";

export class FileIDComputerWorker{
    private piscina: Piscina;

    constructor(workerPath?:string) {
        // `WORKER_URL` is the escape hatch the tests have always set — it just
        // wasn't read. Honour it before falling back to path derivation, which
        // only works for a caller running from `dist/`.
        if (!workerPath && process.env.WORKER_URL) {
            workerPath = new URL(process.env.WORKER_URL, `file://${process.cwd()}/`).href;
        }
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
    public async computeCIDs(filePath: string, algorithms: CidAlgorithm[]): Promise<string[]> {
        return this.piscina.run({filePath, algorithms});
    }
}
