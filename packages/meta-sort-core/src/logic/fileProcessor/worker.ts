import {FileProcessorInternal} from "./FileProcessorInternal.js";
import {HashMeta} from "@metazla/meta-interface";

const fileProcessor = new FileProcessorInternal();

export interface Input {
    filePath: string;
    hash:HashMeta;
}

export interface Output {
    time: number;
    metadata: HashMeta;
    hashTimings?: Record<string, number>; // Per-hash computation times in ms
    pluginTimings?: Record<string, number>; // Per-plugin processing times in ms
}

export default async function processFile({ filePath,hash}: Input): Promise<Output> {
    return fileProcessor.processFile(filePath,hash);
}