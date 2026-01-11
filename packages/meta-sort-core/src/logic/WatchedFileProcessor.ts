import {promises as fs} from 'fs';
import {dirname, join, parse} from 'path';
import {config} from "../config/EnvConfig.js";
import {FileProcessorInterface} from "@metazla/meta-hash";
import {MetaDataToFolderStruct} from "./MetaDataToFolderStruct.js";
import {DuplicateFinder, DuplicateResult} from "./DuplicateFinder.js";
import {FileType} from "@metazla/filename-tools";
import {existsAsync} from "@metazla/meta-hash";
import {FileAnalyzerInterface} from "./fileProcessor/FileAnalyzerInterface.js";
import {FileProcessorPiscina} from "./fileProcessor/FileProcessorPiscina.js";
import {renamingRule} from "../config/RenamingRule.js";
import {MetaMeshFormat} from "./MetaMeshFormat.js";
import {JellyfinAPI} from "../jellyfin/JellyfinAPI.js";
import {VirtualFileSystem} from "../api/VirtualFileSystem.js";
import {performanceMetrics} from "../metrics/PerformanceMetrics.js";
import {UnifiedProcessingStateManager} from "./UnifiedProcessingStateManager.js";
import type {IKVClient} from "../kv/IKVClient.js";
import PQueue from "p-queue";
import os from 'os';
import { TaskScheduler, createTaskScheduler, MetadataNodeKVStore } from "../plugin-engine/index.js";
import { initializePluginManager } from "./fileProcessor/FileProcessorPiscina.js";
import { from } from "@metazla/meta-interface";
import { stat } from "fs/promises";
import type { StreamingPipeline } from "./pipeline/StreamingPipeline.js";

export class WatchedFileProcessor implements FileProcessorInterface {
    jellyfinAPI = new JellyfinAPI();
    metaMeshFormat = new MetaMeshFormat();
    metaDataToFolderStruct = new MetaDataToFolderStruct(renamingRule);
    virtualFileSystem: VirtualFileSystem;
    unifiedStateManager = new UnifiedProcessingStateManager();
    //fileProcessor:FileAnalyzerInterface = new FileProcessor();//TODO only use for debug
    fileProcessor:FileAnalyzerInterface = new FileProcessorPiscina();
    duplicateFinder = new DuplicateFinder();
    duplicateResult: DuplicateResult | null = null;
    fileType = new FileType();
    supported = ['video','subtitle','torrent'];

    // Task-based plugin scheduler (replaces two-queue system)
    private taskScheduler: TaskScheduler | null = null;

    // Pre-processing queue for midhash256 computation (before plugins)
    private preProcessQueue: PQueue;

    // Reference to StreamingPipeline for queue status
    private pipeline: StreamingPipeline | null = null;

    constructor() {
        // Always initialize VirtualFileSystem for FUSE API
        this.virtualFileSystem = new VirtualFileSystem({
            fileMode: 0o644,
            directoryMode: config.CHMOD_FOR_NEW_FOLDER || 0o755
        });

        // Pass the unified state manager to the fileProcessor
        if (this.fileProcessor instanceof FileProcessorPiscina) {
            this.fileProcessor.setUnifiedStateManager(this.unifiedStateManager);
        }

        // Pre-processing queue for midhash256 computation
        const cpuCount = os.cpus().length;
        const preProcessConcurrency = config.MAX_WORKER_THREADS || cpuCount * 2;
        this.preProcessQueue = new PQueue({concurrency: preProcessConcurrency, autoStart: true});

        console.log(`WatchedFileProcessor: TaskScheduler-based system initialized`);
        console.log(`  - Pre-process queue: ${preProcessConcurrency} workers (midhash256)`);
        console.log(`  - TaskScheduler handles plugin execution (fast/background queues)`);
    }

    getVirtualFileSystem(): VirtualFileSystem {
        return this.virtualFileSystem;
    }

    getUnifiedStateManager(): UnifiedProcessingStateManager {
        return this.unifiedStateManager;
    }

    getDuplicateResult(): DuplicateResult | null {
        return this.duplicateResult;
    }

    /**
     * Get the KV client
     */
    getKVClient(): IKVClient | null {
        if (this.fileProcessor instanceof FileProcessorPiscina) {
            return this.fileProcessor.getKVClient();
        }
        return null;
    }

    /**
     * Set the KV client
     * This is called by KVManager after successful connection
     */
    setKVClient(client: IKVClient): void {
        if (this.fileProcessor instanceof FileProcessorPiscina) {
            this.fileProcessor.setKVClient(client);
        }
    }

    /**
     * Set the StreamingPipeline reference for queue status
     * This is called by index.ts after creating the pipeline
     */
    setPipeline(pipeline: StreamingPipeline): void {
        this.pipeline = pipeline;
        console.log('[WatchedFileProcessor] Pipeline connected for queue status');
    }

    /**
     * Get current queue status for monitoring UI
     * Uses StreamingPipeline queues which do the actual processing:
     * Pipeline flow: validation → lightProcessing → hashProcessing
     *
     * Mapping to UI:
     * - Pre-Process = validation (quick extension checks, high concurrency)
     * - Fast Queue = lightProcessing (midhash256 + metadata extraction)
     * - Background Queue = hashProcessing (SHA-256 full file hash)
     */
    getQueueStatus() {
        // Use StreamingPipeline stats if available (this is the actual processing engine)
        if (this.pipeline) {
            const pipelineStats = this.pipeline.getStats();
            const queues = pipelineStats.queues;

            // Map StreamingPipeline queues to the 3-queue architecture UI expects
            // PQueue: .pending = currently running, .size = waiting in queue
            // API expects: .pending = running, .size = waiting
            const result = {
                preProcessQueue: {
                    // validation = pre-process (quick extension checks)
                    size: queues.validation.size, // waiting in queue
                    pending: queues.validation.pending, // running jobs
                    isPaused: false
                },
                fastQueue: {
                    // fastQueue = fast queue (midhash256 + metadata)
                    running: queues.fastQueue.pending, // running jobs
                    pending: queues.fastQueue.size, // waiting in queue
                    size: queues.fastQueue.size,
                    isPaused: false
                },
                backgroundQueue: {
                    // backgroundQueue = background (SHA-256 computation)
                    running: queues.backgroundQueue.pending, // running jobs
                    pending: queues.backgroundQueue.size, // waiting in queue
                    size: queues.backgroundQueue.size,
                    isPaused: false
                }
            };
            return result;
        }

        // Fallback: use TaskScheduler if available (for future plugin-based architecture)
        if (this.taskScheduler) {
            const status = this.taskScheduler.getQueueStatus();
            return {
                preProcessQueue: {
                    size: this.preProcessQueue.pending,
                    pending: this.preProcessQueue.size,
                    isPaused: this.preProcessQueue.isPaused
                },
                fastQueue: {
                    size: status.fast.ready,
                    pending: status.fast.pending,
                    running: status.fast.running,
                    isPaused: status.fast.isPaused
                },
                backgroundQueue: {
                    size: status.background.ready,
                    pending: status.background.pending,
                    running: status.background.running,
                    isPaused: status.background.isPaused
                }
            };
        }

        // Fallback: empty status
        return {
            preProcessQueue: { size: 0, pending: 0, isPaused: false },
            fastQueue: { size: 0, pending: 0, running: 0, isPaused: false },
            backgroundQueue: { size: 0, pending: 0, running: 0, isPaused: false }
        };
    }

    /**
     * Get the TaskScheduler instance
     */
    getTaskScheduler(): TaskScheduler | null {
        return this.taskScheduler;
    }

    async initialize() {
        await this.fileProcessor.init();

        // Initialize TaskScheduler with PluginManager using config values
        const pluginManager = await initializePluginManager();
        this.taskScheduler = createTaskScheduler(pluginManager, performanceMetrics, {
            fastQueueConcurrency: config.FAST_QUEUE_CONCURRENCY,
            backgroundQueueConcurrency: config.BACKGROUND_QUEUE_CONCURRENCY,
            fastThresholdMs: config.FAST_THRESHOLD_MS,
            minSamplesForMeasurement: config.MIN_SAMPLES_FOR_MEASUREMENT,
        });

        // Set up event listeners for VFS updates
        this.setupTaskSchedulerEvents();

        console.log(`[WatchedFileProcessor] TaskScheduler initialized with:`);
        console.log(`  - Fast queue concurrency: ${config.FAST_QUEUE_CONCURRENCY}`);
        console.log(`  - Background queue concurrency: ${config.BACKGROUND_QUEUE_CONCURRENCY}`);
        console.log(`  - Fast threshold: ${config.FAST_THRESHOLD_MS}ms`);
        console.log(`  - Min samples for measurement: ${config.MIN_SAMPLES_FOR_MEASUREMENT}`);
    }

    /**
     * Set up TaskScheduler event listeners for VFS integration and Redis pub/sub
     */
    private setupTaskSchedulerEvents(): void {
        if (!this.taskScheduler) return;

        // When a task completes, check if we should update VFS
        this.taskScheduler.on('task:complete', (event: any) => {
            const { task } = event;

            // Update VFS when filename-parser completes (has basic metadata)
            if (task.pluginId === 'filename-parser') {
                this.updateVFSForFile(task.fileHash, task.filePath);
            }

            // Publish plugin completion event to Redis
            this.publishPluginComplete(task.fileHash, task.pluginId, task.filePath);
        });

        // When all tasks for a file complete
        this.taskScheduler.on('file:complete', (event: any) => {
            const { fileHash, filePath } = event;
            console.log(`[TaskScheduler] All plugins complete for ${filePath}`);

            // Final VFS update with complete metadata
            this.updateVFSForFile(fileHash, filePath);

            // Update unified state manager
            if (this.unifiedStateManager) {
                this.unifiedStateManager.completeHashProcessing(filePath, fileHash);
            }
        });
    }

    /**
     * Publish plugin completion event to Redis
     * Channel: meta-sort:plugin:complete
     */
    private async publishPluginComplete(fileHash: string, pluginId: string, filePath: string): Promise<void> {
        const kvClient = this.getKVClient();
        if (!kvClient || typeof (kvClient as any).publish !== 'function') {
            return;
        }

        try {
            const message = JSON.stringify({
                fileHash,
                pluginId,
                filePath,
                timestamp: Date.now()
            });
            await (kvClient as any).publish('meta-sort:plugin:complete', message);
        } catch (error) {
            // Silent fail - pub/sub is optional
        }
    }

    /**
     * Update VFS for a file with current metadata
     */
    private updateVFSForFile(fileHash: string, filePath: string): void {
        const metadata = this.fileProcessor.getDatabase().get(filePath);
        if (metadata && metadata.cid_midhash256) {
            try {
                const virtualPath = this.metaDataToFolderStruct.renamingRule(metadata as any, '');
                this.virtualFileSystem.addFile(virtualPath, filePath, metadata);
            } catch (e) {
                // Renaming rule may fail for incomplete metadata
            }
        }
    }

    markPending(filePath: string): void {
        // STATE 1: Mark as pending when file is discovered (before queue)
        this.unifiedStateManager.addPending(filePath);
    }

    async queueFile(filePath: string): Promise<void> {
        // TaskScheduler-based processing
        // Phase 1: Pre-process (midhash256 computation)
        // Phase 2: Plugin execution via TaskScheduler (fast/background queues)

        // Debug: log queue state before adding
        console.log(`[DEBUG queueFile] Before add: size=${this.preProcessQueue.size}, pending=${this.preProcessQueue.pending}`);

        await this.preProcessQueue.add(async () => {
            console.log(`[DEBUG queueFile] Task started: size=${this.preProcessQueue.size}, pending=${this.preProcessQueue.pending}`);
            try {
                // STATE: Start LIGHT processing
                if (this.unifiedStateManager) {
                    this.unifiedStateManager.startLightProcessing(filePath);
                }

                // STEP 1: Compute midhash256 (file identifier)
                const fileStats = await stat(filePath);
                const { computeMidHash256 } = await import('@metazla/meta-hash');

                // Check cache first
                const indexLine = (this.fileProcessor as any).indexManager?.getCidForFile(
                    filePath,
                    fileStats.size,
                    fileStats.mtime.toISOString()
                );

                let midHash256: string;
                if (indexLine?.cid_midhash256) {
                    midHash256 = indexLine.cid_midhash256;
                    performanceMetrics.recordCacheHit('midhash256');
                } else {
                    const computeStart = performance.now();
                    midHash256 = await computeMidHash256(filePath);
                    performanceMetrics.recordHashComputation('cid_midhash256', Math.ceil(performance.now() - computeStart));
                    performanceMetrics.recordCacheMiss('midhash256');
                }

                // STEP 2: Initialize metadata with midhash256
                const metadata: any = {
                    cid_midhash256: midHash256,
                    filePath,
                    processingStatus: 'processing'
                };

                // Store in local database
                this.fileProcessor.getDatabase().set(filePath, metadata);

                // STEP 3: Create KV store for plugins
                const metaDataNode = from(metadata);
                const kv = new MetadataNodeKVStore(metaDataNode);

                // STEP 4: Create and enqueue plugin tasks
                if (this.taskScheduler) {
                    const tasks = this.taskScheduler.createTasksForFile(filePath, midHash256, kv);
                    this.taskScheduler.enqueueTasks(tasks);
                }

                // STATE: Light processing setup complete
                if (this.unifiedStateManager) {
                    this.unifiedStateManager.completeLightProcessing(
                        filePath,
                        midHash256,
                        undefined // Virtual path will be computed by plugins
                    );
                }
            } catch (error) {
                console.error(`Failed pre-processing for ${filePath}:`, error);

                // Mark processing as failed
                if (this.unifiedStateManager) {
                    this.unifiedStateManager.completeLightProcessing(
                        filePath,
                        '',
                        undefined,
                        error instanceof Error ? error.message : String(error)
                    );
                }
            }
        });
    }

    async processFile(current: number, queueSize: number, filePath: string): Promise<void> {
        // This method is now a wrapper for queueFile for backwards compatibility
        // In the new single-phase model, queueFile handles everything
        await this.queueFile(filePath);
    }

    async finalize(): Promise<void> {
        try {
            console.log(`Virtual filesystem update start`);
            const start = performance.now();
            if (this.fileProcessor.getDatabase().size === 0) {
                console.log(`No files to process`);
                return;
            }
            let startTime = performance.now();
            const newDuplicateResult = await this.duplicateFinder.findDuplicates(this.fileProcessor.getDatabase());//find duplicates and removes them to avoid conflict
            const duplicateTime = Math.ceil(performance.now() - startTime);
            const totalDuplicates = newDuplicateResult.hashDuplicates.length + newDuplicateResult.titleDuplicates.length;
            console.log(`Duplicate find took ${duplicateTime}ms - found ${newDuplicateResult.hashDuplicates.length} hash groups, ${newDuplicateResult.titleDuplicates.length} title groups`);

            // Only update duplicateResult if we found new duplicates, or if it's the first run
            if (totalDuplicates > 0 || this.duplicateResult === null) {
                this.duplicateResult = newDuplicateResult;
            }

            performanceMetrics.recordDuplicateDetection(duplicateTime, totalDuplicates);

            startTime = performance.now();
            console.log(`Generating virtual structure for ${this.fileProcessor.getDatabase().size} files`);
            const virtualStructure = this.metaDataToFolderStruct.generateVirtualStructure(this.fileProcessor.getDatabase());
            const virtualStructureTime = Math.ceil(performance.now() - startTime);
            console.log(`Virtual structure generation took ${virtualStructureTime}ms`);
            performanceMetrics.recordVirtualStructureGeneration(virtualStructureTime);

            // Build VirtualFileSystem for FUSE/WebDAV API
            startTime = performance.now();
            this.virtualFileSystem.buildFromComputed(virtualStructure, this.fileProcessor.getDatabase());
            const vfsBuildTime = Math.ceil(performance.now() - startTime);
            console.log(`VirtualFileSystem build took ${vfsBuildTime}ms`);
            performanceMetrics.recordVFSUpdate(vfsBuildTime);
            const stats = this.virtualFileSystem.getStats();
            console.log(`VirtualFileSystem: ${stats.fileCount} files (${stats.metaFileCount} .meta), ${stats.directoryCount} directories, ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`);

            if(this.jellyfinAPI.jellyApiAvailable()) {
                await this.jellyfinAPI.refreshLibrary();
                console.log(`Jellyfin refreshed`);
            }

            console.log(`Virtual filesystem update took ${Math.ceil(performance.now() - start)}ms`);
        } catch (error) {
            console.error(error);
        }
    }

    async canProcessFile(filePath: string) {
        const fileTypeResult = await this.fileType.getFileType(filePath);
        //check if filetype is one of the suported ones
        return this.supported.includes(fileTypeResult);
    }

    async deleteFile(filePath: string) {
        this.fileProcessor.deleteFile(filePath);
        this.unifiedStateManager.removeFile(filePath);
    }

    /**
     * Clean up stale entries from in-memory database for scanned directories
     *
     * This is called after discovery scans a folder. It removes files from
     * in-memory DB that belong to the scanned folder but were not seen during
     * the scan (meaning they no longer exist on disk).
     *
     * Design Philosophy:
     * - Discovery is the source of truth for file existence
     * - Empty/missing folders → remove all child paths from memory
     * - KV keeps everything (distributed metadata archive)
     *
     * @param scannedFolders - Array of folder paths that were completely scanned
     * @param discoveredFiles - Set of file paths that were found during scan
     */
    async cleanupStaleEntries(scannedFolders: string[], discoveredFiles: Set<string>): Promise<void> {
        console.log(`[Cleanup] Starting cleanup for ${scannedFolders.length} scanned folders...`);
        const startTime = performance.now();

        let removedCount = 0;
        const db = this.fileProcessor.getDatabase();
        const removedHashIds: string[] = []; // Collect hashIds for Stremio notification

        for (const folder of scannedFolders) {
            const normalizedFolder = folder.endsWith('/') ? folder : folder + '/';

            // Find all in-memory files that belong to this folder
            const filesToCheck: string[] = [];
            for (const [filePath] of db.entries()) {
                if (filePath.startsWith(normalizedFolder) || filePath === folder) {
                    filesToCheck.push(filePath);
                }
            }

            // Remove files that weren't discovered (no longer exist)
            for (const filePath of filesToCheck) {
                if (!discoveredFiles.has(filePath)) {
                    // File is in memory but wasn't seen during scan → removed/offline
                    const metadata = db.get(filePath);

                    // Collect hashId before deletion (for Stremio notification)
                    if (metadata && metadata.cid_midhash256) {
                        removedHashIds.push(metadata.cid_midhash256);
                    }

                    db.delete(filePath);
                    this.unifiedStateManager.removeFile(filePath);
                    removedCount++;
                }
            }
        }

        const elapsed = Math.ceil(performance.now() - startTime);
        console.log(`[Cleanup] Removed ${removedCount} stale entries in ${elapsed}ms`);

        // If we removed files, rebuild VFS to update structure
        if (removedCount > 0) {
            console.log('[Cleanup] Rebuilding VFS after cleanup...');
            await this.finalize();

            // Notify Stremio addon to remove videos (incremental updates like FUSE)
            if (removedHashIds.length > 0) {
                console.log(`[Cleanup] Notifying Stremio to remove ${removedHashIds.length} videos...`);
                for (const hashId of removedHashIds) {
                    this.notifyStremioRemove(hashId).catch(() => {
                        // Silent fail - Stremio addon may not be running
                    });
                }
            }
        }
    }

    /**
     * Rebuild VirtualFileSystem from KV data
     * This is called on startup to restore the VFS from persistent storage
     *
     * Fast-load strategy: Load all metadata from KV WITHOUT disk validation.
     * Discovery will later validate file existence and clean up stale entries.
     *
     * Design Philosophy:
     * - KV = distributed metadata archive (permanent record)
     * - In-memory DB = current VFS state (only present files)
     * - Discovery = source of truth (validates and cleans)
     */
    async rebuildVFSFromKV(): Promise<void> {
        const kvClient = this.getKVClient();
        if (!kvClient) {
            console.warn('[VFS Rebuild] KV client not available, skipping VFS rebuild');
            return;
        }

        try {
            console.log('[VFS Rebuild] Starting fast-load from KV...');
            const startTime = performance.now();

            // Get all hash IDs from KV
            const hashIds = await kvClient.getAllHashIds();
            console.log(`[VFS Rebuild] Found ${hashIds.length} files in KV`);

            if (hashIds.length === 0) {
                console.log('[VFS Rebuild] No files in KV, VFS remains empty');
                return;
            }

            // Batch fetch all metadata in parallel (no disk validation)
            console.log('[VFS Rebuild] Fetching metadata in parallel...');
            const metadataList = await Promise.all(
                hashIds.map(async (hashId) => {
                    try {
                        return await kvClient.getMetadataFlat(hashId);
                    } catch (error) {
                        console.error(`[VFS Rebuild] Failed to load metadata for ${hashId}:`, error);
                        return null;
                    }
                })
            );

            // Populate in-memory database without disk validation
            let loadedCount = 0;
            for (const metadata of metadataList) {
                if (metadata && metadata.filePath) {
                    // Mark as unverified - discovery will validate later
                    (metadata as any)._lastVerified = 0;
                    this.fileProcessor.getDatabase().set(metadata.filePath, metadata);
                    loadedCount++;
                }
            }

            console.log(`[VFS Rebuild] Loaded ${loadedCount}/${hashIds.length} files into memory (unverified)`);

            // Build VFS immediately - may contain stale entries until discovery validates
            if (this.fileProcessor.getDatabase().size > 0) {
                await this.finalize();
                console.log(`[VFS Rebuild] VFS rebuilt in ${Math.ceil(performance.now() - startTime)}ms`);
                console.log('[VFS Rebuild] Discovery will validate file existence in background');
            } else {
                console.log('[VFS Rebuild] No files loaded, VFS remains empty');
            }
        } catch (error) {
            console.error('[VFS Rebuild] Error rebuilding VFS from KV:', error);
        }
    }

    /**
     * Notify Stremio addon to remove video (incremental update like FUSE)
     */
    private async notifyStremioRemove(hashId: string): Promise<void> {
        try {
            const response = await fetch('http://localhost:7000/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hashId }),
                signal: AbortSignal.timeout(5000) // 5 second timeout
            });

            if (!response.ok) {
                // Silent fail - Stremio may not be running
                return;
            }
        } catch (error: any) {
            // Silent fail - Stremio addon may not be running or network issue
        }
    }

    /**
     * Shutdown: clean up resources
     */
    async shutdown(): Promise<void> {
        console.log('[WatchedFileProcessor] Shutting down...');

        // Clear pre-process queue
        this.preProcessQueue.clear();

        // Shutdown TaskScheduler
        if (this.taskScheduler) {
            await this.taskScheduler.shutdown();
        }

        console.log('[WatchedFileProcessor] Shutdown complete');
    }
}