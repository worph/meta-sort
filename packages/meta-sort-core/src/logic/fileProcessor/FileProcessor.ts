import {HashIndexManager} from "@metazla/meta-hash";
import {config} from "../../config/EnvConfig.js";
import {stat} from "fs/promises";
import {targetHash} from "../../config/TargetHash.js";
import {HashMeta} from "@metazla/meta-interface";
import {FileAnalyzerInterface} from "./FileAnalyzerInterface.js";
import {FileProcessorInternal} from "./FileProcessorInternal.js";
import {globalHashIndex} from "./SimpleFileToCid.js";
import {FileMetadata} from "../../types/FileMetadata.js";



export class FileProcessor implements FileAnalyzerInterface{
    database = new Map<string, FileMetadata>();//Map<filePath,FileMetadata>
    indexManager = globalHashIndex;
    fileProcessor = new FileProcessorInternal();

    constructor() {
    }

    async init() {
        await this.indexManager.init(true);
        console.log('Index loaded:', this.indexManager.getCacheSize(), 'entry');
    }

    /**
     * Quick metadata processing - extracts metadata without computing content hash
     * Note: Plugin processing is now handled by container plugins via TaskScheduler
     */
    async processFileQuick(filePath: string): Promise<FileMetadata> {
        // Initialize metadata with processing status
        const metadata: FileMetadata = {
            processingStatus: 'processing'
        };

        // Add to database immediately
        // Plugin processing will be done asynchronously by container plugins
        this.database.set(filePath, metadata);

        return metadata;
    }

    getDatabase<T>(): Map<string, T> {
        return this.database as Map<string, T>;
    }

    async processFile(filePath: string, current: number, queueSize: number) {
        try {
            if (this.database.has(filePath)) {
                return;
            }

            const stats = await stat(filePath);
            let indexLine = this.indexManager.getCidForFile(filePath, stats.size, stats.mtime.toISOString());
            let hash: HashMeta = {};
            if(indexLine) {
                for (const hashKey of targetHash) {
                    if (indexLine[hashKey]) {
                        hash[hashKey] = indexLine[hashKey];
                    }
                }
            }

            // Hash logic compute and get the hash - use cache etc...
            const result = await this.fileProcessor.processFile(filePath,hash);

            //save the metadata to the cache or disk
            this.database.set(filePath, result.metadata);
            this.indexManager.addFileCid(filePath, stats.size, stats.mtime.toISOString(), result.metadata);
        } catch (e) {
            console.error(`Error processing file [No Thread] ${filePath}:`, e);
        }
    }

    async processLightPhase(filePath: string, current: number, queueSize: number) {
        // Legacy FileProcessor doesn't support split phases - just use processFile
        await this.processFile(filePath, current, queueSize);
    }

    async processHashPhase(filePath: string, current: number, queueSize: number) {
        // Legacy FileProcessor doesn't support split phases - no-op
        // (processFile already did everything)
    }

    deleteFile(filePath: string) {
        this.database.delete(filePath);
    }
}