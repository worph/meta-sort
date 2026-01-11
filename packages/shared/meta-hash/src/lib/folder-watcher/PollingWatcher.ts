import {readdir} from "fs/promises";
import * as path from 'path';
import {FileProcessorInterface} from "./FileProcessorInterface.js";

export interface PollingPathConfig {
    path: string;
    intervalMs: number;
}

/**
 * PollingWatcher - Manual polling-based file watcher (no chokidar)
 *
 * Polls specific directories at configured intervals using simple setInterval + readdir.
 * Perfect for network drives (SMB/NFS) where filesystem events don't work reliably.
 *
 * Usage:
 * - Configure with array of {path, intervalMs} objects
 * - Each path can have its own polling interval
 * - Runs in parallel with FolderWatcher (chokidar)
 */
export class PollingWatcher {
    private fileProcessor: FileProcessorInterface;
    private pollingConfigs: PollingPathConfig[];
    private intervals: NodeJS.Timeout[] = [];
    private seenFiles: Set<string> = new Set();
    private initialized = false;

    constructor(fileProcessor: FileProcessorInterface, pollingConfigs: PollingPathConfig[]) {
        this.fileProcessor = fileProcessor;
        this.pollingConfigs = pollingConfigs;
    }

    /**
     * Recursively scan directory and find all files
     */
    private async scanDirectory(directory: string, allFiles: string[]): Promise<void> {
        try {
            const entries = await readdir(directory, {withFileTypes: true});
            for (const entry of entries) {
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    await this.scanDirectory(fullPath, allFiles);
                } else {
                    allFiles.push(fullPath);
                }
            }
        } catch (error: any) {
            // Ignore permission errors and other scan errors
            if (error.code !== 'EACCES' && error.code !== 'EPERM') {
                console.error(`Error scanning directory ${directory}:`, error.message);
            }
        }
    }

    /**
     * Process a single file (check if new, then queue for processing)
     */
    private async processFile(filePath: string): Promise<void> {
        // Skip if already seen
        if (this.seenFiles.has(filePath)) {
            return;
        }

        // Check if file type is supported
        if (!await this.fileProcessor.canProcessFile(filePath)) {
            return;
        }

        // Mark as seen
        this.seenFiles.add(filePath);
        console.log(`[PollingWatcher] New file detected: ${filePath}`);

        // Queue for processing (same pipeline as chokidar)
        if (this.fileProcessor.markPending) {
            this.fileProcessor.markPending(filePath);
        }

        if (this.fileProcessor.queueFile) {
            await this.fileProcessor.queueFile(filePath);
        }

        if (this.fileProcessor.processFile) {
            this.fileProcessor.processFile(0, 0, filePath);
        }
    }

    /**
     * Poll a specific directory once
     */
    private async pollDirectory(dirPath: string): Promise<void> {
        console.log(`[PollingWatcher] Polling ${dirPath}...`);
        const startTime = Date.now();

        try {
            const allFiles: string[] = [];
            await this.scanDirectory(dirPath, allFiles);

            console.log(`[PollingWatcher] Found ${allFiles.length} files in ${dirPath} (${Date.now() - startTime}ms)`);

            // Process new files
            const promises: Promise<void>[] = [];
            for (const filePath of allFiles) {
                promises.push(this.processFile(filePath));
            }
            await Promise.all(promises);

            console.log(`[PollingWatcher] Poll completed for ${dirPath} (${Date.now() - startTime}ms)`);
        } catch (error: any) {
            console.error(`[PollingWatcher] Error polling ${dirPath}:`, error.message);
        }
    }

    /**
     * Start polling all configured paths
     */
    async start(): Promise<void> {
        if (this.pollingConfigs.length === 0) {
            console.log('[PollingWatcher] No polling paths configured, skipping');
            return;
        }

        console.log(`[PollingWatcher] Starting polling for ${this.pollingConfigs.length} paths`);

        // Initialize file processor if needed
        if (!this.initialized && this.fileProcessor.initialize) {
            await this.fileProcessor.initialize();
            this.initialized = true;
        }

        // Do initial scan for all paths
        for (const config of this.pollingConfigs) {
            console.log(`[PollingWatcher] Initial scan: ${config.path} (interval: ${config.intervalMs}ms)`);
            await this.pollDirectory(config.path);
        }

        // Start interval polling for each path
        for (const config of this.pollingConfigs) {
            const interval = setInterval(async () => {
                await this.pollDirectory(config.path);
            }, config.intervalMs);

            this.intervals.push(interval);
            console.log(`[PollingWatcher] Polling started for ${config.path} every ${config.intervalMs}ms`);
        }

        console.log('[PollingWatcher] All polling intervals started');
    }

    /**
     * Stop all polling
     */
    stop(): void {
        console.log('[PollingWatcher] Stopping all polling intervals');
        for (const interval of this.intervals) {
            clearInterval(interval);
        }
        this.intervals = [];
        console.log('[PollingWatcher] All polling intervals stopped');
    }

    /**
     * Clear the seen files cache (useful for testing/debugging)
     */
    clearCache(): void {
        console.log(`[PollingWatcher] Clearing seen files cache (${this.seenFiles.size} files)`);
        this.seenFiles.clear();
    }
}
