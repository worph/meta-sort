import * as path from 'path';
import PQueue from 'p-queue';
import {PipelineConfig} from './PipelineConfig.js';
import {performanceMetrics} from '../../metrics/PerformanceMetrics.js';

// Pub/sub channel for batched updates to meta-fuse
const UPDATE_CHANNEL = 'meta-sort:file:batch';

// Pub/sub channel for scan reset notification
const RESET_CHANNEL = 'meta-sort:scan:reset';

// Batch update interval (5 seconds)
const BATCH_INTERVAL_MS = 5000;

interface BatchChange {
    action: 'add' | 'update' | 'remove';
    hashId: string;
}

/**
 * Streaming Pipeline for file processing
 * Files flow through two stages as they're discovered:
 * Discovery → Validation → Processing (midhash256 + metadata)
 *
 * With midhash256 being instant (< 1s), files appear in VFS immediately
 *
 * Publishes batched updates to meta-fuse via Redis pub/sub every 5 seconds.
 */
export class StreamingPipeline {
    private validationQueue: PQueue;
    private fastQueue: PQueue;
    private backgroundQueue: PQueue;
    private config: PipelineConfig;

    private discoveredCount = 0;
    private validatedCount = 0;
    private fastProcessedCount = 0;
    private backgroundProcessedCount = 0;

    // Batch buffer for pub/sub notifications
    private batchBuffer: BatchChange[] = [];
    private batchTimer: NodeJS.Timeout | null = null;

    constructor(config: PipelineConfig) {
        this.config = config;

        // Stage 1: Validation (high concurrency - fast I/O checks)
        this.validationQueue = new PQueue({
            concurrency: config.validationConcurrency,
            autoStart: true
        });

        // Stage 2: Fast Queue - metadata + midhash256 (high concurrency, fast)
        this.fastQueue = new PQueue({
            concurrency: config.fastQueueConcurrency,
            autoStart: true
        });

        // Stage 3: Background Queue - SHA-256 computation (lower concurrency, CPU-intensive)
        this.backgroundQueue = new PQueue({
            concurrency: config.backgroundQueueConcurrency,
            autoStart: true
        });

        console.log(`[Pipeline] Initialized with concurrency: validation=${config.validationConcurrency}, fastQueue=${config.fastQueueConcurrency}, backgroundQueue=${config.backgroundQueueConcurrency}`);

        // Start batch publish timer
        this.startBatchTimer();
    }

    /**
     * Start the batch publish timer
     * Publishes accumulated changes to meta-fuse every 5 seconds
     */
    private startBatchTimer(): void {
        this.batchTimer = setInterval(() => {
            this.flushBatch().catch(err => {
                console.error('[Pipeline] Failed to flush batch:', err.message);
            });
        }, BATCH_INTERVAL_MS);
    }

    /**
     * Stop the batch publish timer
     */
    stopBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
    }

    /**
     * Queue a change for batched notification
     */
    private queueChange(action: 'add' | 'update' | 'remove', hashId: string): void {
        // Deduplicate: remove existing entries for same hashId
        this.batchBuffer = this.batchBuffer.filter(c => c.hashId !== hashId);
        this.batchBuffer.push({ action, hashId });
    }

    /**
     * Flush the batch buffer and publish to Redis
     */
    private async flushBatch(): Promise<void> {
        if (this.batchBuffer.length === 0) {
            return;
        }

        const changes = [...this.batchBuffer];
        this.batchBuffer = [];

        try {
            const kvClient = this.config.kvClient;
            if (kvClient && typeof (kvClient as any).publish === 'function') {
                const message = JSON.stringify({
                    timestamp: Date.now(),
                    changes
                });
                await (kvClient as any).publish(UPDATE_CHANNEL, message);
                console.log(`[Pipeline] Published batch update: ${changes.length} changes`);
            }
        } catch (error: any) {
            // Put changes back in buffer on failure
            this.batchBuffer = [...changes, ...this.batchBuffer];
            console.warn(`[Pipeline] Failed to publish batch: ${error.message}`);
        }
    }

    /**
     * Start processing files from discovery stream
     * Processing begins immediately as files are discovered
     *
     * @param discoveryStream - Async generator yielding file paths
     */
    async start(discoveryStream: AsyncGenerator<string>): Promise<void> {
        console.log('[Pipeline] Starting file processing stream...');
        const startTime = Date.now();

        try {
            // Consume discovery stream
            for await (const filePath of discoveryStream) {
                this.discoveredCount++;

                // Mark as discovered immediately when file is found
                this.config.stateManager.addDiscovered(filePath);

                // Stage 1: Validation (fire and forget)
                this.validationQueue.add(() => this.validateFile(filePath))
                    .catch(err => console.error(`[Pipeline] Validation error for ${filePath}:`, err.message));

                // Log progress every 1000 files
                if (this.discoveredCount % 1000 === 0) {
                    this.logProgress();
                }
            }

            const elapsed = Date.now() - startTime;
            console.log(`[Pipeline] Discovery completed: ${this.discoveredCount} files found in ${elapsed}ms`);
            console.log(`[Pipeline] Processing continues in background...`);
            this.logProgress();
        } catch (error: any) {
            console.error(`[Pipeline] Error in discovery stream:`, error.message);
            throw error;
        }
    }

    /**
     * Stage 1: Validation
     * - Quick extension check (no file I/O)
     * - Optional MIME validation (reads file header)
     * - Files already marked as discovered in start()
     * - After validation passes, file is removed from discovered (tracked by PQueue pending)
     */
    private async validateFile(filePath: string): Promise<void> {
        try {
            // Extension check (instant, no I/O)
            const ext = path.extname(filePath).toLowerCase();
            if (!this.config.supportedExtensions.has(ext)) {
                // Skip unsupported file types - remove from discovered
                this.config.stateManager.removeFile(filePath);
                return;
            }

            // Optional strict MIME validation
            // Note: Skipped for performance - extension check is sufficient
            // If needed, could add MIME validation via external library

            this.validatedCount++;

            // Remove from discovered - file will be tracked by PQueue pending
            // until a fast queue worker picks it up and calls startLightProcessing()
            this.config.stateManager.removeFile(filePath);

            // Stage 2: Fast Queue - metadata + midhash256 (fire and forget)
            this.fastQueue.add(() => this.processLightPhase(filePath))
                .catch(err => console.error(`[Pipeline] Fast queue error for ${filePath}:`, err.message));
        } catch (error: any) {
            console.error(`[Pipeline] Validation failed for ${filePath}:`, error.message);
            // Remove failed file from discovered
            this.config.stateManager.removeFile(filePath);
        }
    }

    /**
     * Stage 2: Fast Queue Phase
     * - Extract metadata (filename parsing, FFmpeg analysis)
     * - Compute midhash256 (< 1s)
     * - Store to KV (file becomes accessible in VFS)
     * - Queue for background processing
     */
    private async processLightPhase(filePath: string): Promise<void> {
        try {
            // Call light processing
            const current = this.fastProcessedCount + 1;
            const queueSize = this.discoveredCount;

            await this.config.fileProcessor.processLightPhase(filePath, current, queueSize);

            // After light processing, add to VFS
            const metadata = this.config.fileProcessor.getDatabase().get(filePath);
            if (metadata && metadata.cid_midhash256) {
                // Generate virtual path from metadata
                const virtualPath = this.config.metaDataToFolderStruct.renamingRule(metadata as any, filePath);

                if (virtualPath) {
                    // Add to VFS immediately (file appears with permanent midhash256 ID)
                    this.config.virtualFileSystem.addFile(virtualPath, filePath, metadata);

                    // Queue for pub/sub notification to meta-fuse
                    if (metadata.cid_midhash256) {
                        this.queueChange('add', metadata.cid_midhash256);
                    }

                    // Notify Stremio addon to add video (incremental update like FUSE)
                    if (metadata.cid_midhash256) {
                        this.notifyStremioAdd(metadata.cid_midhash256).catch(err => {
                            // Silent fail - Stremio addon may not be running
                        });
                    }
                } else {
                    // File cannot be added to VFS (e.g., unsupported type, missing title)
                    console.log(`⚠ File skipped from VFS (no virtual path): ${filePath}`);
                }

                // Dispatch tasks to container plugins (fire and forget)
                this.dispatchContainerPluginTasks(filePath, metadata.cid_midhash256, metadata);

                // Stage 3: Queue for background processing (SHA-256 computation)
                this.backgroundQueue.add(() => this.processHashPhase(filePath))
                    .catch(err => console.error(`[Pipeline] Background queue error for ${filePath}:`, err.message));
            }

            this.fastProcessedCount++;
        } catch (error: any) {
            // Processing failed - mark as failed (manual retry available via UI)
            console.error(`[Pipeline] Fast queue processing failed for ${filePath}: ${error.message}`);

            // Record failed file in metrics
            performanceMetrics.recordFailedFile(
                filePath,
                error.message || 'Unknown error',
                1,
                'processing'
            );

            // Remove from processing
            this.config.stateManager.removeFile(filePath);
        }
    }

    /**
     * Stage 3: Background Queue Phase
     * - Compute full hashes (SHA-256, SHA-1, MD5, CRC32)
     * - Update KV with additional hash metadata
     * - Mark processing as complete (if no container plugins)
     */
    private async processHashPhase(filePath: string): Promise<void> {
        try {
            // Call hash processing
            const current = this.backgroundProcessedCount + 1;
            const queueSize = this.discoveredCount;

            await this.config.fileProcessor.processHashPhase(filePath, current, queueSize);

            this.backgroundProcessedCount++;

            // If container plugins are NOT configured, mark file as complete immediately.
            // Otherwise, wait for 'file:complete' event from ContainerPluginScheduler.
            if (!this.config.containerPluginScheduler) {
                const metadata = this.config.fileProcessor.getDatabase().get(filePath);
                const hashId = metadata?.cid_midhash256;
                let virtualPath: string | undefined;
                try {
                    virtualPath = metadata ? this.config.metaDataToFolderStruct.renamingRule(metadata as any, filePath) : undefined;
                } catch {
                    // Renaming rule may fail for incomplete metadata
                }
                this.config.stateManager.completeHashProcessing(filePath, hashId, virtualPath);
            }
        } catch (error: any) {
            // Processing failed - mark as failed (manual retry available via UI)
            console.error(`[Pipeline] Background queue processing failed for ${filePath}: ${error.message}`);

            // Record failed file in metrics
            performanceMetrics.recordFailedFile(
                filePath,
                error.message || 'Unknown error',
                1,
                'hash'
            );

            // Complete with error
            this.config.stateManager.completeHashProcessing(filePath, undefined, undefined, error.message);
        }
    }

    /**
     * Handle file added event (from chokidar)
     */
    async handleFileAdded(filePath: string): Promise<void> {

        // Process through validation stage
        this.validationQueue.add(() => this.validateFile(filePath))
            .catch(err => console.error(`[Pipeline] Error processing added file ${filePath}:`, err.message));
    }

    /**
     * Handle file changed event (from chokidar)
     */
    async handleFileChanged(filePath: string): Promise<void> {

        // Reprocess through validation stage
        this.config.stateManager.removeFile(filePath);
        this.validationQueue.add(() => this.validateFile(filePath))
            .catch(err => console.error(`[Pipeline] Error processing changed file ${filePath}:`, err.message));
    }

    /**
     * Handle file deleted event (from chokidar)
     */
    async handleFileDeleted(filePath: string): Promise<void> {
        // Get hashId before removal for pub/sub notification
        const metadata = this.config.fileProcessor.getDatabase().get(filePath);
        const hashId = (metadata as any)?.cid_midhash256;

        // Remove from state and call cleanup
        if (this.config.fileProcessor.deleteFile) {
            this.config.fileProcessor.deleteFile(filePath);
        }
        this.config.stateManager.removeFile(filePath);

        // Queue for pub/sub notification to meta-fuse
        if (hashId) {
            this.queueChange('remove', hashId);
        }
    }

    /**
     * Get pipeline statistics
     */
    getStats() {
        // Get container scheduler queue status if available
        const containerScheduler = this.config.containerPluginScheduler;
        const containerQueueStatus = containerScheduler?.getQueueStatus();

        // Use container scheduler queues for fast/background if available
        // The container scheduler manages the actual plugin task execution
        // PQueue: .pending = running + waiting, .size = waiting only
        // So running = pending - size (but ensure non-negative)
        const fastQueue = containerQueueStatus ? {
            pending: Math.max(0, containerQueueStatus.fast.running), // running jobs
            size: Math.max(0, containerQueueStatus.fast.pending) // total pending (running + waiting)
        } : {
            pending: this.fastQueue.pending,
            size: this.fastQueue.size
        };

        const backgroundQueue = containerQueueStatus ? {
            pending: Math.max(0, containerQueueStatus.background.running), // running jobs
            size: Math.max(0, containerQueueStatus.background.pending) // total pending
        } : {
            pending: this.backgroundQueue.pending,
            size: this.backgroundQueue.size
        };

        return {
            discovered: this.discoveredCount,
            validated: this.validatedCount,
            fastProcessed: this.fastProcessedCount,
            backgroundProcessed: this.backgroundProcessedCount,
            queues: {
                validation: {
                    pending: this.validationQueue.pending,
                    size: this.validationQueue.size
                },
                fastQueue,
                backgroundQueue
            },
            state: this.config.stateManager.getSnapshot()
        };
    }

    /**
     * Reset pipeline counters and clear state manager
     * Called when triggering a fresh scan to reset statistics
     * Publishes reset event to notify meta-fuse to clear its VFS
     */
    async reset(): Promise<void> {
        console.log('[Pipeline] Resetting counters and state...');

        // Reset counters
        this.discoveredCount = 0;
        this.validatedCount = 0;
        this.fastProcessedCount = 0;
        this.backgroundProcessedCount = 0;

        // Clear batch buffer
        this.batchBuffer = [];

        // Clear state manager (discovered, processing, done states)
        this.config.stateManager.clear();

        // Publish reset event to notify meta-fuse
        if (this.config.kvClient && typeof (this.config.kvClient as any).publish === 'function') {
            try {
                const message = JSON.stringify({
                    timestamp: Date.now(),
                    action: 'reset'
                });
                await (this.config.kvClient as any).publish(RESET_CHANNEL, message);
                console.log('[Pipeline] Reset event published to meta-fuse');
            } catch (error) {
                console.error('[Pipeline] Failed to publish reset event:', error);
            }
        }

        console.log('[Pipeline] Reset complete');
    }

    /**
     * Pause all pipeline queues
     * Running tasks will complete, but no new tasks will start
     */
    pause(): void {
        this.validationQueue.pause();
        this.fastQueue.pause();
        this.backgroundQueue.pause();
        console.log('[Pipeline] All queues paused');
    }

    /**
     * Resume all pipeline queues
     */
    resume(): void {
        this.validationQueue.start();
        this.fastQueue.start();
        this.backgroundQueue.start();
        console.log('[Pipeline] All queues resumed');
    }

    /**
     * Check if pipeline is paused
     */
    isPaused(): boolean {
        return this.validationQueue.isPaused ||
               this.fastQueue.isPaused ||
               this.backgroundQueue.isPaused;
    }

    /**
     * Log current pipeline progress
     */
    private logProgress(): void {
        const stats = this.getStats();
    }

    /**
     * Notify Stremio addon to add video (incremental update like FUSE)
     */
    private async notifyStremioAdd(hashId: string): Promise<void> {
        try {
            const response = await fetch('http://localhost:7000/add', {
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
            // This is expected during development when Stremio isn't started
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
     * Set the container plugin scheduler (called after initialization)
     */
    setContainerPluginScheduler(scheduler: import('../../container-plugins/ContainerPluginScheduler.js').ContainerPluginScheduler): void {
        (this.config as any).containerPluginScheduler = scheduler;

        // Listen for file:complete events to transition files to done state
        scheduler.on('file:complete', ({ fileHash, filePath }) => {
            console.log(`[Pipeline] Container plugins complete for ${filePath} (${fileHash})`);

            // Get virtual path from metadata if available
            let virtualPath: string | undefined;
            const metadata = this.config.fileProcessor?.getDatabase().get(filePath);
            if (metadata) {
                try {
                    virtualPath = this.config.metaDataToFolderStruct.renamingRule(metadata as any, filePath);
                } catch {
                    // Renaming rule may fail for incomplete metadata
                }
            }

            // Transition file to done state
            this.config.stateManager.completeHashProcessing(filePath, fileHash, virtualPath);
        });

        console.log('[Pipeline] Container plugin scheduler connected');
    }

    /**
     * Set the KV client (called after initialization when Redis is ready)
     * This enables pub/sub notifications to meta-fuse
     */
    setKVClient(kvClient: import('../../kv/IKVClient.js').IKVClient): void {
        (this.config as any).kvClient = kvClient;
        console.log('[Pipeline] KV client connected - pub/sub enabled');
    }

    /**
     * Dispatch tasks to container plugins for metadata extraction
     * This is fire-and-forget - container plugins write results directly to meta-core
     */
    private dispatchContainerPluginTasks(filePath: string, hashId: string, existingMeta: Record<string, any>): void {
        const scheduler = this.config.containerPluginScheduler;
        if (!scheduler) {
            return; // Container plugins not configured
        }

        try {
            // Convert metadata to flat string map for plugin API
            const metaFlat: Record<string, string> = {};
            for (const [key, value] of Object.entries(existingMeta)) {
                if (value != null) {
                    metaFlat[key] = String(value);
                }
            }

            // Dispatch tasks to all enabled plugins
            scheduler.dispatchAllPlugins(hashId, filePath, metaFlat)
                .catch(err => {
                    console.error(`[Pipeline] Failed to dispatch container plugin tasks for ${filePath}:`, err.message);
                });
        } catch (error: any) {
            console.error(`[Pipeline] Error dispatching container plugin tasks for ${filePath}:`, error.message);
        }
    }
}
