import {createReadStream, promises as fs} from 'fs';
import {parse} from 'csv-parse';
import {parse as parseSync} from 'csv-parse/sync';
import {stringify} from 'csv-stringify/sync';
import {existsAsync} from "../utils/ExistsAsync";
import path from "path";
import {clearInterval} from "node:timers";
import {CID_ALGORITHM_NAMES} from "./MultiHashData";
import {stat} from "fs/promises";
import {Stats} from "node:fs";

interface IndexLine extends Partial<Record<CID_ALGORITHM_NAMES, string>> {
    path: string;
    size: string;
    mtime: string;
}

export const INDEX_HEADERS = ['path', 'size', 'mtime'];

export class HashIndexManager {
    private cache: Map<string, IndexLine> = new Map<string, IndexLine>();//the key is the file `${file_name}-${filesize}-${mtime_ISOstr}`
    private intervalId: any;
    private intervalTime: number = 30000;
    private lastIndexFileSize: { [key in CID_ALGORITHM_NAMES]?: number } = {}; //size of the index file last time it was read
    private lastCacheFile: { [key in CID_ALGORITHM_NAMES]?: IndexLine[] } = {}; //state of the file last time it was read
    private indexOpsInProgress: boolean = false;
    private hasChanged: boolean = false;
    private initialLoad: Promise<void>;
    private filePaths: { [key in CID_ALGORITHM_NAMES]?: string } = {};

    constructor(private indexFolderPath: string,
                private targetHash: CID_ALGORITHM_NAMES[]) {
    }

    hasFileInCache(filePath: string,stats:Stats): boolean {
        return this.cache.has(`${path.basename(filePath)}-${stats.size}-${stats.mtime.toISOString()}`);
    }

    getCacheSize(): number {
        return this.cache.size;
    }

    /**
     * After init consecutively calls to this method will not reload the index
     * readThe index for the first time and enable autosave
     * @param autosave
     */
    public async init(autosave = true) {
        if (!this.initialLoad) {
            this.initialLoad = new Promise<void>(async (resolve, reject) => {
                // Create the index folder if it doesn't exist
                await fs.mkdir(this.indexFolderPath, { recursive: true });
                const stat = await fs.stat(this.indexFolderPath);
                if (!stat.isDirectory()) {
                    throw new Error(`Invalid index folder path ${this.indexFolderPath}`);
                }
                for (const hash of this.targetHash) {
                    this.filePaths[hash] = path.join(this.indexFolderPath, `index-${hash}.csv`);
                    console.log(`Index file path for ${hash} is ${this.filePaths[hash]}`);
                    if (!this.filePaths[hash]) {
                        throw new Error(`Invalid index file path for ${hash}`);
                    }
                }
                try {
                    for (const hash of this.targetHash) {
                        if (!this.checkCSVHeaders(this.filePaths[hash], hash)) {
                            throw new Error(`Invalid index file headers for ${hash}`);
                        }
                        await this.loadIndex(hash);
                    }
                    if (autosave) {
                        this.startAutoSave()
                    }
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        }
        return this.initialLoad;
    }

    // Function to check CSV headers
    private checkCSVHeaders(csvContent: string, hash: CID_ALGORITHM_NAMES): boolean {
        const records = parseSync(csvContent, {
            bom: true,
            columns: true,
            skip_empty_lines: true,
        });

        if (records.length === 0) {
            //we will write the headers
            return true;
        }

        // Extract headers
        const headers = Object.keys(records[0]);

        // Define required headers
        //from the IndexLine interface
        const requiredHeaders = [...INDEX_HEADERS, hash];

        // Check if all required headers are present
        return requiredHeaders.every(header => headers.includes(header));
    };

    public stopAutoSave() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
    }

    public startAutoSave(time: number = this.intervalTime) {
        this.stopAutoSave();
        this.intervalTime = time;
        this.intervalId = setInterval(() => this.saveCacheToFile(), time);
    }

    public async loadIndex(hash: CID_ALGORITHM_NAMES): Promise<IndexLine[]> {
        if (await existsAsync(this.filePaths[hash])) {
            // check the file size and if it did not change, do not read the file
            const stats = await fs.stat(this.filePaths[hash]);
            if (this.lastIndexFileSize[hash] !== stats.size) {
                // Read existing file content and parse it
                const records: IndexLine[] = await this.readCsv(hash);
                for (const record of records) {
                    const cacheKey = `${record.path}-${record.size}-${record.mtime}`;
                    let indexLine = this.cache.get(cacheKey);
                    if (!indexLine) {
                        this.cache.set(cacheKey, record);
                    } else if(record[hash]){
                        //update the cache with the latest data
                        indexLine[hash] = record[hash];
                    }
                }
                this.lastIndexFileSize[hash] = stats.size;
                this.lastCacheFile[hash] = records;
                return records;
            } else {
                return this.lastCacheFile[hash];
            }
        }
        return [];
    }

    private loadIndexFromCache(): IndexLine[] {
        return Array.from(this.cache.values());
    }

    private async readCsv(hash: CID_ALGORITHM_NAMES): Promise<IndexLine[]> {
        if (!(await existsAsync(this.filePaths[hash]))) {
            return [];
        }
        const start = performance.now();

        const parser = parse({
            columns: true,
            skip_empty_lines: true,
        });

        const records: IndexLine[] = [];

        return new Promise<IndexLine[]>((resolve, reject) => {
            createReadStream(this.filePaths[hash])
                .pipe(parser)
                .on('data', (record) => {
                    records.push(record);
                })
                .on('end', () => {
                    resolve(records);
                    console.log(`Index read ${hash} time ${performance.now() - start}ms`);
                })
                .on('error', (err) => {
                    reject(err);
                });
        });
    }

    public async saveCacheToFile(): Promise<void> {
        if (this.indexOpsInProgress || !this.hasChanged) {
            return;
        }
        this.hasChanged = false;
        this.indexOpsInProgress = true;
        const start = performance.now();

        let cacheRows: IndexLine[];
        if (this.cache.size !== 0) {
            cacheRows = this.loadIndexFromCache();
        }
        let didWrite=false;
        for (const hash of this.targetHash) {
            let existingRows: IndexLine[] = await this.loadIndex(hash);
            let existingRowsAsMap: Map<string, IndexLine> = new Map(existingRows.map(row => [row.path + '-' + row.size + '-' + row.mtime, row]));
            if (this.cache.size !== 0) {
                // Filter out cacheRows that are already in the file
                const newRows = cacheRows.filter(row => {
                    //to be added a row must not exist in the file and must exist in the cache (with a hash)
                    const newRow = !existingRowsAsMap.has(row.path + '-' + row.size + '-' + row.mtime);
                    return newRow && !!row[hash];
                });

                if (newRows.length !== 0) {
                    // Serialize new cacheRows to CSV string
                    const csvString = stringify(newRows, {
                        header: existingRows.length === 0, // Only add header if the file was empty
                        columns: [
                            {key: 'path', header: 'path'},
                            {key: 'size', header: 'size'},
                            {key: 'mtime', header: 'mtime'},
                            {key: hash, header: hash},
                        ],
                    });

                    // Append new cacheRows to the file
                    await fs.appendFile(this.filePaths[hash], csvString);
                    didWrite = true;
                }
            }
        }

        if(didWrite) {
            const totalTime = performance.now() - start;
            console.log(`Index saved in ${totalTime}ms`);
            // Check if the time to save the index is greater than the interval time. increase the interval time if needed
            if (totalTime * 10 > this.intervalTime) {
                this.startAutoSave(totalTime * 10);
                console.log(`Index save interval increased to ${totalTime * 10}ms`);
            }
        }
        this.indexOpsInProgress = false;
    }

    /**
     * this.getCidForFile(fileName, stats.size, stats.mtime.toISOString())
     * @param filePath
     */
    public async getCidForFileAsync(filePath: string): Promise<IndexLine> {
        const fileName = path.basename(filePath);
        const stats = await stat(filePath);
        return this.getCidForFile(fileName, stats.size, stats.mtime.toISOString());
    }

    public getCidForFile(filePath: string, fileSize: number, mtime: string): IndexLine {
        const fileName = path.basename(filePath);
        let fileNameIndex = this.cache.get(`${fileName}-${fileSize}-${mtime}`);
        if (fileNameIndex) {
            for (const hash of this.targetHash) {
                if (!fileNameIndex[hash]) {
                    delete fileNameIndex[hash];
                }
            }
            if (fileNameIndex.mtime) {
                //if we have a mtime, we need to check it
                if (fileNameIndex.size === (fileSize + "") && fileNameIndex.mtime === mtime) {
                    return fileNameIndex;
                }
            } else {
                //mtime is optional
                if (fileNameIndex.size === (fileSize + "")) {
                    return fileNameIndex;
                }
            }
        }

        // 3 - if not found, delete the entry (keeps the index clean)
        /*if (fileNameIndex && fileNameIndex.size !== (fileSize + "") && pathIndex && pathIndex.size !== (fileSize + "")) {
            this.cache.delete(fileName);
            this.cache.delete(filePath);
        }*/

        return null;
    }

    public addFileCid(filePath: string, fileSize: number, mtime: string, hashs: Partial<Record<CID_ALGORITHM_NAMES, string>>): void {
        if (!filePath || !fileSize || !mtime || !hashs) {
            throw new Error('Invalid parameters');
        }
        for (const hash of this.targetHash) {
            if (!hashs[hash]) {
                throw new Error(`Missing hash ${hash}`);
            }
        }
        const size = fileSize + "";
        const baseName = path.basename(filePath);
        const cacheKey = `${baseName}-${size}-${mtime}`;
        let indexLine = this.cache.get(cacheKey);
        if (!indexLine) {
            //filter only the hashes we need
            let filteredHash = {};
            for (const hash of this.targetHash) {
                filteredHash[hash] = hashs[hash];
            }
            const data = {path: baseName, size: size, mtime: mtime, ...filteredHash};
            this.cache.set(cacheKey, data);
        } else {
            //update the cache with the latest data
            for (const hash of this.targetHash) {
                indexLine[hash] = hashs[hash];
            }
        }
        this.hasChanged = true;
    }

}