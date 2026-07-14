import {CidAlgorithm} from "@root/hash-compute/MultiHashData";

export interface FileIDComputerInterface{
    computeCIDs(filePath: ReadableStream<Uint8Array>, algorithms: CidAlgorithm[]): Promise<string[]>;
}