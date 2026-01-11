import {CID_ALGORITHM_NAMES} from "@root/hash-compute/MultiHashData";
import fs from "fs";
import {Readable} from 'stream';
import {computeCIDs as computeCIDsInternal} from "./ComputeHash";
import {createHasher} from "@root/file-id/CreateHasher";

/**
 * Compute the CIDs of a file using specific algorithms
 * @param filePath The path to the file
 * @param algorithms Array of algorithms ('sha256', 'sha1')
 * @returns Array of CIDs (in the order of the algorithms)
 */
export default async function computeCIDs({filePath, algorithms}: {
    filePath: string;
    algorithms: CID_ALGORITHM_NAMES[]
}): Promise<string[]> {
    const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
    return computeCIDsInternal({stream, algorithms, createHasher});
}