import {Piscina} from "piscina";
import {Input, Output} from "./worker.js";
import {HashIndexManager} from "@metazla/meta-hash";
import {config} from "../../config/EnvConfig.js";
import {stat} from "fs/promises";
// Note: Full hashes are now computed by the full-hash container plugin
import {HashMeta} from "@metazla/meta-interface";
import {FileAnalyzerInterface} from "./FileAnalyzerInterface.js";
import {globalHashIndex} from "./SimpleFileToCid.js";
import {performanceMetrics} from "../../metrics/PerformanceMetrics.js";
import {UnifiedProcessingStateManager} from "../UnifiedProcessingStateManager.js";
import {renamingRule} from "../../config/RenamingRule.js";
import {FileMetadata, ProcessingStatus} from "../../types/FileMetadata.js";
import { PluginManager } from "../../plugin-engine/index.js";
import type {IKVClient} from "../../kv/IKVClient.js";
import * as path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// Get the directory of this file to resolve plugin paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Singleton PluginManager instance
let pluginManagerInstance: PluginManager | null = null;
let pluginManagerInitPromise: Promise<void> | null = null;

/**
 * Get the plugin manager instance (for API access)
 * Returns null if not yet initialized
 */
export function getPluginManagerInstance(): PluginManager | null {
    return pluginManagerInstance;
}

/**
 * Set the plugin manager instance (called by container initialization)
 */
export function setPluginManagerInstance(manager: PluginManager): void {
    pluginManagerInstance = manager;
}

/**
 * Initialize the plugin manager on startup
 * Note: With container-based plugins, the PluginManager is initialized
 * by the ContainerManager. This function creates a basic instance
 * for state management if container plugins are not yet ready.
 */
export async function initializePluginManager(): Promise<PluginManager> {
    if (pluginManagerInstance) {
        return pluginManagerInstance;
    }

    // Create basic plugin manager for state management
    const statePath = path.join(config.CACHE_FOLDER_PATH, 'plugins.json');
    const cacheDir = path.join(config.CACHE_FOLDER_PATH, 'plugin-cache');

    console.log(`[PluginManager] Initializing with:`);
    console.log(`  - State path: ${statePath}`);
    console.log(`  - Cache dir: ${cacheDir}`);

    pluginManagerInstance = new PluginManager({
        statePath,
        cacheDir,
    });

    console.log(`[PluginManager] Basic instance created (waiting for container plugins)`);
    return pluginManagerInstance;
}

export class FileProcessorPiscina implements FileAnalyzerInterface{
    private piscina: Piscina;
    database = new Map<string, FileMetadata>();//Map<filePath,FileMetadata>
    indexManager = globalHashIndex;
    private unifiedStateManager: UnifiedProcessingStateManager | null = null;

    // Unified KV client (Redis)
    private kvClient: IKVClient | null = null;

    // Track running hash workers for abort capability
    private runningHashTasks = new Map<string, AbortController>();

    constructor() {
        // Construct the URL for the current module
        let distFolder = import.meta.dirname;
        distFolder = distFolder.replace('src', 'dist');
        distFolder = distFolder + "/worker.js";
        const workerUrl = new URL(distFolder,"file://").href;

        // Set maxThreads: Smart default uses half CPU cores to avoid starving the system
        // (especially important for network storage + HDD scenarios)
        const cpuCount = os.cpus().length;
        const defaultWorkers = Math.max(1, Math.floor(cpuCount / 2));
        const maxThreads = config.MAX_WORKER_THREADS || defaultWorkers;

        this.piscina = new Piscina({
            maxThreads,
            //maxThreads: 1,//TODO note for DEBUG must be set to 1 to avoid memory issues
            filename:workerUrl
        });

        console.log(`Piscina worker pool initialized with ${maxThreads} threads (cpuCount=${cpuCount}, defaultWorkers=${defaultWorkers})`);
    }

    async init() {
        await this.indexManager.init(true);
        console.log('Index loaded:', this.indexManager.getCacheSize(), 'entry');
    }

    /**
     * Single-phase metadata processing - computes midhash256 immediately and extracts metadata
     * Files appear in VFS instantly with their permanent midhash256 ID
     *
     * @param filePath - Path to the file to process
     * @param current - Current file number (for progress reporting)
     * @param queueSize - Total queue size (for progress reporting)
     * @returns FileMetadata with midhash256 and all metadata
     */

    setUnifiedStateManager(manager: UnifiedProcessingStateManager): void {
        this.unifiedStateManager = manager;
    }

    getDatabase<T>(): Map<string, T> {
        return this.database as Map<string, T>;
    }

    /**
     * Abort all running hash workers immediately (for priority enforcement)
     * @returns Number of workers aborted
     */
    abortAllHashWorkers(): number {
        const abortedCount = this.runningHashTasks.size;

        for (const [filePath, controller] of this.runningHashTasks.entries()) {
            controller.abort();
            console.log(`[Abort] Hash worker aborted: ${filePath}`);
        }

        this.runningHashTasks.clear();
        return abortedCount;
    }

    /**
     * Gracefully shutdown - close KV client
     */
    async shutdown(): Promise<void> {
        if (this.kvClient) {
            console.log('[FileProcessor] Closing KV client...');
            await this.kvClient.close();
            console.log('[FileProcessor] KV client closed');
        }
    }

    async processFile(filePath: string, current: number, queueSize: number) {
        const startTime = Date.now();

        try {
            // STATE: Start LIGHT processing (fast: midhash256 + metadata extraction)
            if (this.unifiedStateManager) {
                this.unifiedStateManager.startLightProcessing(filePath);
            }

            const stats = await stat(filePath);

            // STEP 1: Check cache for midhash256 FIRST (avoids network I/O on unchanged files)
            let midHash256: string | undefined;
            const indexLine = this.indexManager.getCidForFile(filePath, stats.size, stats.mtime.toISOString());

            if (indexLine && indexLine.cid_midhash256) {
                // Cache hit! Use cached midhash256 (no network I/O needed)
                midHash256 = indexLine.cid_midhash256;
                performanceMetrics.recordCacheHit('midhash256');
            } else {
                // Cache miss - compute midhash256 (< 1 second, but requires network I/O on network drives)
                const computeStart = performance.now();
                const { computeMidHash256 } = await import('@metazla/meta-hash');
                midHash256 = await computeMidHash256(filePath);
                const computeTime = Math.ceil(performance.now() - computeStart);

                // Record midhash256 computation time (excludes cache hits)
                performanceMetrics.recordHashComputation('cid_midhash256', computeTime);
                performanceMetrics.recordCacheMiss('midhash256');

                // Store in cache for future lookups
                this.indexManager.addFileCid(filePath, stats.size, stats.mtime.toISOString(), { cid_midhash256: midHash256 });
            }

            // Initialize metadata with midhash256
            const metadata: FileMetadata = {
                cid_midhash256: midHash256,
                processingStatus: 'processing'
            };

            // STEP 2: Plugin metadata extraction is now handled by container plugins
            // The TaskScheduler will dispatch tasks to container plugins asynchronously
            // Basic metadata processing continues below

            // Generate virtualPath from metadata (needed for VFS access)
            let virtualPath: string | undefined;
            try {
                virtualPath = renamingRule(metadata as any, '');
            } catch (e) {
                // If renamingRule fails, virtualPath remains undefined
            }

            // STEP 3: Collision detection and store preliminary metadata in KV
            let collisionDetected = false;
            if (this.kvClient) {
                try {
                    const hashId = midHash256; // Use midhash256 as primary ID

                    if (hashId) {
                        // COLLISION DETECTION: Check if this midhash256 already exists
                        const existingFilePath = await this.kvClient.getMetadata(hashId, 'filePath');

                        if (existingFilePath && existingFilePath !== filePath) {
                            // COLLISION DETECTED: Different file with same midhash256!
                            collisionDetected = true;
                            console.warn(`⚠️  MIDHASH256 COLLISION DETECTED!`);
                            console.warn(`   Hash: ${hashId}`);
                            console.warn(`   Existing file: ${existingFilePath}`);
                            console.warn(`   New file:      ${filePath}`);
                            console.warn(`   Action: Skipping VFS addition, forcing full hash computation`);

                            // Do NOT store in KV with midhash256
                            // File will be processed with full SHA-256 instead (see below)
                        } else {
                            // No collision or same file - safe to store
                            const finalMetadata = {
                                ...metadata,
                                filePath
                            };

                            // Store using nested key architecture
                            await this.kvClient.setMetadataFlat(hashId, finalMetadata, ['processingStatus']);
                        }
                    }
                } catch (metaError) {
                    console.error(`Failed to store metadata in KV:`, metaError);
                }
            }

            // STATE: Light processing complete, move to HASH processing queue
            // If collision detected, skip VFS addition (virtualPath = undefined)
            if (this.unifiedStateManager) {
                if (collisionDetected) {
                    // Collision: Do NOT complete light processing with virtualPath
                    // This prevents file from being added to VFS
                    this.unifiedStateManager.completeLightProcessing(
                        filePath,
                        midHash256,
                        undefined  // No virtualPath = not added to VFS
                    );
                } else {
                    // No collision: File becomes accessible in VFS
                    this.unifiedStateManager.completeLightProcessing(
                        filePath,
                        midHash256,
                        virtualPath
                    );
                }
                // Start hash processing phase immediately
                this.unifiedStateManager.startHashProcessing(filePath);
            }

            // STEP 4: Full hashes (SHA-256, SHA-1, MD5, CRC32) are computed by the
            // container plugin "full-hash" in background queue - not here.
            // Only midhash256 is computed in-process for fast file identification.

            // Mark processing as complete
            metadata.processingStatus = 'complete';
            this.database.set(filePath, metadata);

            // STEP 5: Update metadata in KV with full hashes
            if (this.kvClient) {
                try {
                    // Choose hash ID: Use SHA-256 if collision detected, otherwise midhash256
                    let hashId: string;
                    if (collisionDetected && metadata['cid_sha2-256']) {
                        // Collision: Use full SHA-256 as primary ID
                        hashId = metadata['cid_sha2-256'];
                        console.log(`   Using SHA-256 as primary ID for collision: ${hashId}`);
                    } else {
                        // Normal: Use midhash256 as primary ID
                        hashId = midHash256;
                    }

                    if (hashId) {
                        // Prepare metadata with filePath added
                        const finalMetadata = {
                            ...metadata,
                            filePath
                        };

                        // Store using nested key architecture
                        await this.kvClient.setMetadataFlat(hashId, finalMetadata, ['processingStatus']);
                    }
                } catch (metaError) {
                    console.error(`Failed to store metadata in KV:`, metaError);
                }
            }

            // STATE: Hash processing complete, move to done
            if (this.unifiedStateManager) {
                this.unifiedStateManager.completeHashProcessing(
                    filePath,
                    midHash256,
                    virtualPath
                );
            }
        } catch (e) {
            console.error(`Error processing file ${filePath}:`, e);

            // Mark processing as failed (complete hash processing with error)
            if (this.unifiedStateManager) {
                this.unifiedStateManager.completeHashProcessing(
                    filePath,
                    undefined,
                    undefined,
                    e instanceof Error ? e.message : String(e)
                );
            }
        }
    }

    /**
     * Light Processing Phase - Fast processing to make file accessible in VFS
     * - Compute midhash256 (< 1s)
     * - Extract metadata (filename, FFmpeg analysis)
     * - Store in KV
     * - File becomes accessible in VFS with midhash256 ID
     *
     * @deprecated Use TaskScheduler-based processing via WatchedFileProcessor.queueFile() instead.
     * This method is kept for backward compatibility with StreamingPipeline.
     */
    async processLightPhase(filePath: string, current: number, queueSize: number) {
        try {
            // STATE: Start LIGHT processing
            if (this.unifiedStateManager) {
                this.unifiedStateManager.startLightProcessing(filePath);
            }

            const stats = await stat(filePath);

            // STEP 1: Check cache for midhash256 FIRST (avoids network I/O on unchanged files)
            let midHash256: string | undefined;
            const indexLine = this.indexManager.getCidForFile(filePath, stats.size, stats.mtime.toISOString());

            if (indexLine && indexLine.cid_midhash256) {
                // Cache hit! Use cached midhash256 (no network I/O needed)
                midHash256 = indexLine.cid_midhash256;
                performanceMetrics.recordCacheHit('midhash256');
            } else {
                // Cache miss - compute midhash256 (< 1 second, but requires network I/O on network drives)
                const computeStart = performance.now();
                const { computeMidHash256 } = await import('@metazla/meta-hash');
                midHash256 = await computeMidHash256(filePath);
                const computeTime = Math.ceil(performance.now() - computeStart);

                // Record midhash256 computation time (excludes cache hits)
                performanceMetrics.recordHashComputation('cid_midhash256', computeTime);
                performanceMetrics.recordCacheMiss('midhash256');

                // Store in cache for future lookups
                this.indexManager.addFileCid(filePath, stats.size, stats.mtime.toISOString(), { cid_midhash256: midHash256 });
            }

            // Initialize metadata with midhash256
            const metadata: FileMetadata = {
                cid_midhash256: midHash256,
                processingStatus: 'processing'
            };

            // STEP 2: Plugin metadata extraction is now handled by container plugins
            // The TaskScheduler will dispatch tasks to container plugins asynchronously

            // Generate virtualPath from metadata (needed for VFS access)
            let virtualPath: string | undefined;
            try {
                virtualPath = renamingRule(metadata as any, '');
            } catch (e) {
                // If renamingRule fails, virtualPath remains undefined
            }

            // STEP 3: Store metadata in KV (file becomes accessible in VFS)
            if (this.kvClient) {
                try {
                    const hashId = midHash256; // Use midhash256 as primary ID

                    if (hashId) {
                        // Prepare metadata with filePath added
                        const finalMetadata = {
                            ...metadata,
                            filePath
                        };

                        // Store using nested key architecture
                        await this.kvClient.setMetadataFlat(hashId, finalMetadata, ['processingStatus']);
                    }
                } catch (metaError) {
                    console.error(`Failed to store metadata in KV:`, metaError);
                }
            }

            // Store in local database
            this.database.set(filePath, metadata);

            // STATE: Light processing complete, move to HASH processing queue
            // File is now accessible in VFS with midhash256 ID
            if (this.unifiedStateManager) {
                this.unifiedStateManager.completeLightProcessing(
                    filePath,
                    midHash256,
                    virtualPath
                );
            }
        } catch (e) {
            console.error(`Error in light processing for ${filePath}:`, e);

            // Mark processing as failed
            if (this.unifiedStateManager) {
                this.unifiedStateManager.completeLightProcessing(
                    filePath,
                    '',
                    undefined,
                    e instanceof Error ? e.message : String(e)
                );
            }
            throw e;
        }
    }

    /**
     * Hash Processing Phase - Background hash computation
     * - Compute full hashes (SHA-256, SHA-1, MD5, CRC32)
     * - Update KV with additional hash metadata
     * - Mark processing as complete
     * - Supports abortion for priority enforcement
     *
     * @deprecated Use the full-hash plugin via TaskScheduler instead.
     * This method is kept for backward compatibility with StreamingPipeline.
     */
    async processHashPhase(filePath: string, current: number, queueSize: number) {
        // Create abort controller for this task
        const abortController = new AbortController();
        this.runningHashTasks.set(filePath, abortController);

        try {
            // STATE: Start HASH processing
            if (this.unifiedStateManager) {
                this.unifiedStateManager.startHashProcessing(filePath);
            }

            const stats = await stat(filePath);
            const metadata = this.database.get(filePath);
            if (!metadata) {
                throw new Error('Metadata not found - light processing may have failed');
            }

            const midHash256 = metadata.cid_midhash256;
            if (!midHash256) {
                throw new Error('midhash256 not found in metadata');
            }

            // Generate virtualPath (should already be done but ensure it's available)
            let virtualPath: string | undefined;
            try {
                virtualPath = renamingRule(metadata as any, '');
            } catch (e) {
                // If renamingRule fails, virtualPath remains undefined
            }

            // Check if collision was detected during light processing
            // If the midhash256 key exists in KV with a different file path, collision occurred
            let collisionDetected = false;
            if (this.kvClient) {
                try {
                    const existingFilePath = await this.kvClient.getMetadata(midHash256, 'filePath');
                    if (existingFilePath && existingFilePath !== filePath) {
                        collisionDetected = true;
                        console.log(`   Collision detected in hash phase for ${filePath}`);
                    }
                } catch (e) {
                    // Ignore errors - if key doesn't exist, no collision
                }
            }

            // Check if aborted before processing
            if (abortController.signal.aborted) {
                throw new Error('AbortError');
            }

            // STEP 4: Full hashes (SHA-256, SHA-1, MD5, CRC32) are computed by the
            // container plugin "full-hash" in background queue - not here.
            // Only midhash256 is computed in-process for fast file identification.

            // Mark processing as complete
            metadata.processingStatus = 'complete';
            this.database.set(filePath, metadata);

            // STEP 5: Update metadata in KV (full hashes will be added later by container plugin)
            if (this.kvClient) {
                try {
                    // Use midhash256 as primary ID
                    // Note: SHA-256 is computed later by the full-hash container plugin
                    const hashId = midHash256;

                    if (hashId) {
                        // Prepare metadata with filePath added
                        const finalMetadata = {
                            ...metadata,
                            filePath
                        };

                        // Store using nested key architecture
                        await this.kvClient.setMetadataFlat(hashId, finalMetadata, ['processingStatus']);
                    }
                } catch (metaError) {
                    console.error(`Failed to store metadata in KV:`, metaError);
                }
            }

            // NOTE: File completion is handled by StreamingPipeline based on whether
            // container plugins are configured. If container plugins exist, we wait for
            // the 'file:complete' event from ContainerPluginScheduler. If not, StreamingPipeline
            // calls completeHashProcessing() directly after this method returns.
        } catch (e) {
            // Handle abort errors gracefully
            if (e instanceof Error && (e.message === 'AbortError' || e.name === 'AbortError')) {
                // Task was aborted for priority - re-queue it
                console.log(`[Abort] Hash processing aborted for ${filePath} - will retry when idle`);

                // Don't mark as failed, just remove from running tasks
                // The task will remain in hash queue and retry later
                if (this.unifiedStateManager) {
                    // Move back to hash processing start (will retry)
                    this.unifiedStateManager.startHashProcessing(filePath);
                }
            } else {
                console.error(`Error in hash processing for ${filePath}:`, e);

                // Mark hash processing as failed for real errors
                if (this.unifiedStateManager) {
                    this.unifiedStateManager.completeHashProcessing(
                        filePath,
                        undefined,
                        undefined,
                        e instanceof Error ? e.message : String(e)
                    );
                }
            }
            throw e;
        } finally {
            // Always remove from running tasks
            this.runningHashTasks.delete(filePath);
        }
    }

    async deleteFile(filePath: string) {
        const metadata = this.database.get(filePath);
        this.database.delete(filePath);

        // Delete from KV if configured (using nested key architecture)
        if (this.kvClient && metadata) {
            try {
                const hashId = metadata.cid_midhash256 || metadata['cid_sha2-256'] || metadata.cid_sha1 || metadata.cid_md5;

                // Delete all properties for this file using nested key architecture
                if (hashId) {
                    const deletedCount = await this.kvClient.deleteMetadataFlat(hashId);
                    console.log(`Metadata deleted from KV: /file/${hashId} (${deletedCount} keys)`);
                }
            } catch (metaError) {
                // Log error but don't fail the entire process
                console.error(`Failed to delete metadata from KV:`, metaError);
            }
        }
    }

    /**
     * Set the KV client
     * This is called by KVManager after successful connection
     */
    setKVClient(client: IKVClient): void {
        this.kvClient = client;
        console.log('[FileProcessor] KV client set');
    }

    /**
     * Get the KV client
     */
    getKVClient(): IKVClient | null {
        return this.kvClient;
    }
}