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
import {EventSubscriber} from "./events/EventSubscriber.js";

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

// KV Manager for Redis-based storage with leader election (optional)
let kvManager: KVManager | null = null;

// Container Manager for containerized plugins
let containerManager: ContainerManager | null = null;
let containerPluginScheduler: ContainerPluginScheduler | null = null;

// Event Subscriber for receiving events from meta-core (Architecture V3)
let eventSubscriber: EventSubscriber | null = null;

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

// VFS and state manager are available immediately
const vfs = fileProcessor.getVirtualFileSystem();
const unifiedStateManager = fileProcessor.getUnifiedStateManager();

// API Server will be initialized after KV is ready (deferred to async init)
let apiServer: UnifiedAPIServer | null = null;

// NOTE: Scan trigger has been moved to meta-core (Architecture V3)
// Use meta-core's /api/scan/trigger endpoint directly

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

    // Stop Event Subscriber if running
    if (eventSubscriber) {
        console.log('[Shutdown] Stopping Event Subscriber...');
        await eventSubscriber.stop();
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
        // Validate META_CORE_PATH is configured (required for leader discovery)
        if (!config.META_CORE_PATH) {
            console.error('[Startup] ERROR: META_CORE_PATH is required. Set META_CORE_PATH environment variable.');
            console.error('[Startup] Example: META_CORE_PATH=/meta-core');
            process.exit(1);
        }

        // Initialize KV Manager (Redis via leader discovery)
        if (config.META_CORE_PATH) {
            console.log('[Startup] Initializing KV Manager (leader discovery)...');
            kvManager = new KVManager({
                metaCorePath: config.META_CORE_PATH,
                filesPath: config.FILES_PATH,
                serviceName: config.SERVICE_NAME,
                apiPort: config.FUSE_API_PORT,
                baseUrl: config.BASE_URL,
            });

            // Wait for KV to be ready
            await kvManager.start();
            await kvManager.waitForReady();

            // Pass KV client to file processor and pipeline
            const client = kvManager.getClient();
            if (client) {
                fileProcessor.setKVClient(client);
                pipeline.setKVClient(client);
                console.log('[Startup] KV Manager ready');
            }
        }

        // Start Unified API Server AFTER KV is ready (so kvClient is available)
        const kvClient = fileProcessor.getKVClient();
        apiServer = new UnifiedAPIServer(vfs, {
            port: config.FUSE_API_PORT,
            host: config.FUSE_API_HOST,
            enableCors: true,
        }, unifiedStateManager, kvClient || undefined, backgroundQueueConcurrency, fastQueueConcurrency, () => fileProcessor.getQueueStatus(), kvManager || undefined, getPluginManagerInstance, () => fileProcessor.getTaskScheduler());

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
                    backgroundConcurrency: backgroundQueueConcurrency,
                    kvClient: kvClient || undefined,
                });

                // Update scheduler URLs from service discovery
                containerPluginScheduler.updateUrlsFromManager();

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

        // Log cache performance summary
        const metrics = performanceMetrics.getMetrics();
        if (metrics.cacheHits.midhash256 || metrics.cacheMisses.midhash256) {
            const hits = metrics.cacheHits.midhash256 || 0;
            const misses = metrics.cacheMisses.midhash256 || 0;
            const total = hits + misses;
            const hitRate = total > 0 ? ((hits / total) * 100).toFixed(1) : '0.0';
            console.log(`[Cache] midhash256 cache: ${hits} hits, ${misses} misses (${hitRate}% hit rate)`);
        }

        // Connect to meta-core for file events via SSE (Architecture V3)
        // Get meta-core URL from leader discovery
        const leaderInfo = kvManager?.getLeaderInfo();
        if (!leaderInfo) {
            console.error('[Startup] ERROR: No leader info available. Cannot connect to meta-core.');
            console.error('[Startup] Make sure meta-core is running and kv-leader.info exists.');
            process.exit(1);
        }
        const metaCoreUrl = leaderInfo.apiUrl;
        console.log(`[Startup] Connecting to meta-core at ${metaCoreUrl}...`);
        eventSubscriber = new EventSubscriber({
            metaCoreUrl: metaCoreUrl,
            pipeline: pipeline,
            requestInitialScan: true, // Request initial scan from meta-core
            reconnectDelayMs: 5000,
        });
        await eventSubscriber.start();
        console.log('[Startup] EventSubscriber connected to meta-core');

    } catch (error) {
        console.error('[Startup] Error during startup:', error);
    }
})();
