import {FolderWatcher, PollingWatcher} from "@metazla/meta-hash";
import {config} from "./config/EnvConfig.js";

import os from 'os';
import {existsSync} from 'fs';
import {WatchedFileProcessor} from "./logic/WatchedFileProcessor.js";
import {UnifiedAPIServer} from "./api/UnifiedAPIServer.js";
import {StreamingPipeline} from "./logic/pipeline/StreamingPipeline.js";
import {SUPPORTED_EXTENSIONS} from "./config/SupportedFileTypes.js";
import {performanceMetrics} from "./metrics/PerformanceMetrics.js";
import {KVManager} from "./kv/KVManager.js";
import {getPluginManagerInstance, initializePluginManager} from "./logic/fileProcessor/FileProcessorPiscina.js";
import {ContainerManager} from "./container-plugins/ContainerManager.js";
import {ContainerPluginScheduler} from "./container-plugins/ContainerPluginScheduler.js";

try {
    // Get current user information
    const userInfo = os.userInfo();
    // Display the current user and UID
    console.log(`[node] Current User: ${userInfo.username}`);
    console.log(`[node] User ID (UID): ${userInfo.uid}`);
}catch (error) {
    /* ignore */
}

console.log(`BUILD_VERSION: ${process.env.BUILD_VERSION || 'dev'}`);

//display the config
console.log(config);

process.umask(0);//This unable the process to create files with 777 permissions

let fileProcessor = new WatchedFileProcessor();
let folders = config.WATCH_FOLDER_LIST;

// KV Manager for Redis-based storage with leader election (optional)
let kvManager: KVManager | null = null;

// Container Manager for containerized plugins
let containerManager: ContainerManager | null = null;
let containerPluginScheduler: ContainerPluginScheduler | null = null;

// Calculate concurrency for pipeline stages
const cpuCount = os.cpus().length;
// Smart defaults optimized for network storage + HDD scenarios:
// - Fast queue: CPU (fast operations: filename parsing, stats)
// - Background queue: CPU / 2 (slow operations: SHA-256, FFmpeg)
const defaultBackgroundWorkers = Math.max(1, Math.floor(cpuCount / 2));
const validationConcurrency = config.MAX_WORKER_THREADS ? config.MAX_WORKER_THREADS * 2 : cpuCount * 2;
const fastQueueConcurrency = config.MAX_WORKER_THREADS ? config.MAX_WORKER_THREADS : cpuCount;
const backgroundQueueConcurrency = config.MAX_WORKER_THREADS || defaultBackgroundWorkers;

console.log(`Pipeline concurrency: validation=${validationConcurrency}, fastQueue=${fastQueueConcurrency}, backgroundQueue=${backgroundQueueConcurrency} (cpuCount=${cpuCount}, defaultBackgroundWorkers=${defaultBackgroundWorkers})`);

// Create streaming pipeline
const pipeline = new StreamingPipeline({
    supportedExtensions: SUPPORTED_EXTENSIONS,
    validationConcurrency,
    fastQueueConcurrency,
    backgroundQueueConcurrency,
    strictMimeValidation: false, // Skip MIME for speed
    fileProcessor: fileProcessor.fileProcessor,
    stateManager: fileProcessor.unifiedStateManager,
    kvClient: fileProcessor.getKVClient(),
    virtualFileSystem: fileProcessor.getVirtualFileSystem(),
    metaDataToFolderStruct: fileProcessor.metaDataToFolderStruct
});

// Connect pipeline to fileProcessor for queue status monitoring
fileProcessor.setPipeline(pipeline);

// Create generic file discovery
const folderWatcher = new FolderWatcher();

// Parse folder list
const folderList = folders.split(',').map(f => f.trim()).filter(f => f.length > 0);
console.log(`Watching folders: ${folderList.join(', ')}`);

// VFS and state manager are available immediately
const vfs = fileProcessor.getVirtualFileSystem();
const unifiedStateManager = fileProcessor.getUnifiedStateManager();
const getDuplicateResult = () => fileProcessor.getDuplicateResult();

// API Server will be initialized after KV is ready (deferred to async init)
let apiServer: UnifiedAPIServer | null = null;

// Shared progressive discovery and cleanup logic (used by both startup and manual scan)
const runProgressiveDiscovery = async () => {
    console.log(`[Discovery] Progressive scan mode: ${folderList.length} folders`);

    // Process folders one at a time for progressive cleanup
    for (const folder of folderList) {
        console.log(`[Discovery] Scanning folder: ${folder}`);

        // Track discovered files for this folder
        const discoveredFilesInFolder = new Set<string>();

        // Wrap discovery stream to track files
        async function* trackDiscoveredFiles(stream: AsyncGenerator<string>) {
            for await (const filePath of stream) {
                discoveredFilesInFolder.add(filePath);
                yield filePath;
            }
        }

        const discoveryStream = folderWatcher.discoverFiles([folder]);
        const trackedStream = trackDiscoveredFiles(discoveryStream);

        await pipeline.start(trackedStream);

        // Progressive cleanup: clean up after each folder completes
        console.log(`[Discovery] Folder scan complete: ${folder}. Found ${discoveredFilesInFolder.size} files. Running cleanup...`);
        await fileProcessor.cleanupStaleEntries([folder], discoveredFilesInFolder);
        console.log(`[Discovery] Cleanup complete for folder: ${folder}`);
    }

    console.log(`[Discovery] All folders scanned and cleaned up`);
};

// Manual scan trigger (called from API)
// Note: Stremio updates happen automatically via incremental add/remove notifications
// during file processing (like FUSE), so no explicit refresh needed here
const triggerScan = async () => {
    console.log('[Scan] Triggering manual scan from API...');

    // Reset pipeline counters and state before fresh scan
    // Also publishes reset event to meta-fuse
    await pipeline.reset();

    console.log('[Scan] Starting fresh discovery...');
    await runProgressiveDiscovery();
    console.log('[Scan] Manual scan complete');
};

// Global error handlers - prevent crashes from unforeseen errors
process.on('uncaughtException', (error: Error) => {
    console.error('❌ [CRITICAL] Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    // Log but don't exit - allow process to continue
    // Monitor for worker health issues
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('❌ [CRITICAL] Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
    // Log but don't exit - allow process to continue
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    if (apiServer) {
        await apiServer.stop();
    }

    // Stop Container Manager if running
    if (containerManager) {
        console.log('[Shutdown] Stopping Container Manager...');
        await containerManager.shutdown();
    }

    // Stop KV Manager if running
    if (kvManager) {
        console.log('[Shutdown] Stopping KV Manager...');
        await kvManager.stop();
    }

    process.exit(0);
});

// Start initial discovery and processing (streaming pipeline)
(async () => {
    try {
        // Initialize KV Manager if configured (Redis + leader election)
        if (config.META_CORE_PATH) {
            console.log('[Startup] Initializing KV Manager (Redis + leader election)...');
            kvManager = new KVManager({
                metaCorePath: config.META_CORE_PATH,
                filesPath: config.FILES_PATH,
                serviceName: config.SERVICE_NAME,
                version: config.SERVICE_VERSION,
                apiPort: config.FUSE_API_PORT,
                redisPort: config.REDIS_PORT,
                redisUrl: config.REDIS_URL,
                baseUrl: config.BASE_URL,
                capabilities: ['write', 'mount', 'monitor']
            });

            // Wait for KV to be ready
            await kvManager.start();
            await kvManager.waitForReady();

            // Pass KV client to file processor and pipeline
            const client = kvManager.getClient();
            if (client) {
                fileProcessor.setKVClient(client);
                pipeline.setKVClient(client);
                console.log(`[Startup] KV Manager ready (role: ${kvManager.isLeader() ? 'LEADER' : 'FOLLOWER'})`);
            }
        }

        // Start Unified API Server AFTER KV is ready (so kvClient is available)
        const kvClient = fileProcessor.getKVClient();
        apiServer = new UnifiedAPIServer(vfs, {
            port: config.FUSE_API_PORT,
            host: config.FUSE_API_HOST,
            enableCors: true,
        }, unifiedStateManager, getDuplicateResult, kvClient || undefined, triggerScan, undefined, fastQueueConcurrency, () => fileProcessor.getQueueStatus(), kvManager || undefined, getPluginManagerInstance, () => fileProcessor.getTaskScheduler());

        await apiServer.start();
        console.log('Unified API Server started successfully');

        // Initialize plugin manager early so it's available for API
        console.log('[Startup] Initializing plugin manager...');
        const pluginManager = await initializePluginManager();
        console.log('[Startup] Plugin manager initialized');

        // Initialize container plugins if config file exists
        if (existsSync(config.CONTAINER_PLUGINS_CONFIG)) {
            console.log('[Startup] Initializing container plugins...');
            try {
                containerManager = new ContainerManager();
                await containerManager.initialize();

                // Connect container manager to plugin manager
                pluginManager.setContainerManager(containerManager);
                await pluginManager.loadContainerPlugins();

                // Create container plugin scheduler
                containerPluginScheduler = new ContainerPluginScheduler(containerManager, {
                    fastConcurrency: config.FAST_QUEUE_CONCURRENCY,
                    kvClient: kvClient || undefined,
                });

                // Connect to API server (for callback handling)
                apiServer.setContainerPluginManager(containerManager, containerPluginScheduler);
                console.log('[Startup] ContainerPluginScheduler connected to API server');

                const status = containerManager.getStatus();
                console.log(`[Startup] Container plugins initialized: ${status.pluginCount} plugins, ${status.healthyContainers}/${status.runningContainers} healthy`);
            } catch (error) {
                console.error('[Startup] Failed to initialize container plugins:', error);
                console.log('[Startup] Continuing without container plugins...');
            }
        } else {
            console.log(`[Startup] Container plugins config not found at ${config.CONTAINER_PLUGINS_CONFIG}, skipping`);
        }

        // Initialize hash index cache (loads existing hashes from disk)
        // This also initializes the TaskScheduler
        console.log('[Startup] Initializing hash index cache...');
        await fileProcessor.initialize();
        console.log('[Startup] Hash index cache initialized');

        // Connect ContainerPluginScheduler to TaskScheduler and Pipeline
        if (containerPluginScheduler) {
            const taskScheduler = fileProcessor.getTaskScheduler();
            if (taskScheduler) {
                taskScheduler.setContainerPluginScheduler(containerPluginScheduler);
                console.log('[Startup] ContainerPluginScheduler connected to TaskScheduler');
            }

            // Connect to StreamingPipeline for file processing dispatch
            pipeline.setContainerPluginScheduler(containerPluginScheduler);
            console.log('[Startup] ContainerPluginScheduler connected to StreamingPipeline');
        }

        // Connect StreamingPipeline to API server (for pause/resume control)
        apiServer.setStreamingPipeline(pipeline);
        console.log('[Startup] StreamingPipeline connected to API server');

        // First, rebuild VFS from KV to restore state from previous runs
        console.log('[Startup] Rebuilding VirtualFileSystem from KV...');
        await fileProcessor.rebuildVFSFromKV();
        console.log('[Startup] VFS rebuild completed');

        console.log('[Startup] Starting initial file discovery with progressive cleanup...');
        await runProgressiveDiscovery();
        console.log('[Startup] Initial discovery completed, processing continues in background');

        // Log cache performance summary
        const metrics = performanceMetrics.getMetrics();
        if (metrics.cacheHits.midhash256 || metrics.cacheMisses.midhash256) {
            const hits = metrics.cacheHits.midhash256 || 0;
            const misses = metrics.cacheMisses.midhash256 || 0;
            const total = hits + misses;
            const hitRate = total > 0 ? ((hits / total) * 100).toFixed(1) : '0.0';
            console.log(`[Cache] midhash256 cache: ${hits} hits, ${misses} misses (${hitRate}% hit rate)`);
        }

        // Setup file watching for changes
        console.log('[Startup] Setting up file watching...');
        folderWatcher.watch(folderList, {
            onAdd: (filePath) => pipeline.handleFileAdded(filePath),
            onChange: (filePath) => pipeline.handleFileChanged(filePath),
            onUnlink: (filePath) => pipeline.handleFileDeleted(filePath)
        }, {
            interval: config.WATCH_FOLDER_POOLING_INTERVAL_MS || 30000,
            stabilityThreshold: 30000,
            pollInterval: 5000
        });
        console.log('[Startup] File watching active');
    } catch (error) {
        console.error('[Startup] Error during initial discovery:', error);
    }
})();

// Start PollingWatcher for path-specific polling (if configured)
if (config.POLLING_PATHS && config.POLLING_PATHS.length > 0) {
    console.log(`PollingWatcher: ${config.POLLING_PATHS.length} paths configured`);
    const pollingWatcher = new PollingWatcher(fileProcessor, config.POLLING_PATHS);
    pollingWatcher.start().then(() => {
        console.log('PollingWatcher started successfully');
    }).catch((error) => {
        console.error('Error starting PollingWatcher:', error);
    });
} else {
    console.log('PollingWatcher: No polling paths configured (skipped)');
}
