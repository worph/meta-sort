import {HashMeta} from "@metazla/meta-interface";
import {FileMetadata} from "../../types/FileMetadata.js";

export interface FileAnalyzerInterface {
    /**
     * Full file processing - computes midhash256 and extracts all metadata
     * Since midhash256 is instant (< 1s), files appear in VFS immediately with permanent ID
     */
    processFile(filePath: string, current: number, queueSize: number):Promise<void>;

    /**
     * Light processing phase - fast metadata extraction + midhash256
     * File becomes accessible in VFS with permanent ID after this phase
     */
    processLightPhase(filePath: string, current: number, queueSize: number):Promise<void>;

    /**
     * Hash processing phase - background hash computation
     * Computes full hashes (SHA-256, SHA-1, MD5, CRC32) and updates KV
     */
    processHashPhase(filePath: string, current: number, queueSize: number):Promise<void>;

    /**
     * Get the metadata database
     */
    getDatabase<T extends FileMetadata>(): Map<string, T>;

    /**
     * Delete a file from the database
     */
    deleteFile(filePath: string): Promise<void> | void;

    /**
     * Initialize the file analyzer
     */
    init():Promise<void>;
}