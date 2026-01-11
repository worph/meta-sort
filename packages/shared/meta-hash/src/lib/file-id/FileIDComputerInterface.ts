import {CID_ALGORITHM_NAMES} from "@root/hash-compute/MultiHashData";

export interface FileIDComputerInterface{
    computeCIDs(filePath: ReadableStream<Uint8Array>, algorithms: CID_ALGORITHM_NAMES[]): Promise<string[]>;
}