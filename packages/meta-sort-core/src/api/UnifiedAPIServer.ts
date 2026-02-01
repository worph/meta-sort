/**
 * Unified HTTP API Server using Fastify
 *
 * Consolidates FUSE API, Metrics API, and Duplicates API into a single server.
 * This simplifies deployment and reduces the number of ports needed.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { VirtualFileSystem } from './VirtualFileSystem.js';
import { performanceMetrics } from '../metrics/PerformanceMetrics.js';
import { UnifiedProcessingStateManager } from '../logic/UnifiedProcessingStateManager.js';
import { DuplicateResult } from '../logic/DuplicateFinder.js';
import type { IKVClient } from '../kv/IKVClient.js';
import type { KVManager } from '../kv/KVManager.js';
import type { ExtendedProcessingSnapshot, IKVClientWithPubSub } from '../types/ExtendedInterfaces.js';
import { getErrorMessage } from '../types/ExtendedInterfaces.js';
import { config } from '../config/EnvConfig.js';
import type { PluginManager } from '../plugin-engine/PluginManager.js';
import type { TaskScheduler } from '../plugin-engine/TaskScheduler.js';
import type { ContainerManager, ContainerPluginScheduler, PluginCallbackPayload, GateStatus } from '../container-plugins/index.js';
import type { StreamingPipeline } from '../logic/pipeline/StreamingPipeline.js';

export interface UnifiedAPIServerConfig {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** Enable CORS (default: true) */
  enableCors?: boolean;
}

export class UnifiedAPIServer {
  private app: FastifyInstance;
  private vfs: VirtualFileSystem;
  private unifiedStateManager: UnifiedProcessingStateManager | null = null;
  private getDuplicateResult: (() => DuplicateResult | null) | null = null;
  private kvClient: IKVClient | null = null;
  private kvManager: KVManager | null = null;
  private triggerScanCallback: (() => Promise<void>) | null = null;
  private getQueueStatus: (() => any) | null = null;
  private fastQueueConcurrency: number | undefined = undefined;
  private backgroundQueueConcurrency: number | undefined = undefined;
  private config: Required<UnifiedAPIServerConfig>;
  private getPluginManager: (() => PluginManager | null) | null = null;
  private getTaskScheduler: (() => TaskScheduler | null) | null = null;
  private containerManager: ContainerManager | null = null;
  private containerPluginScheduler: ContainerPluginScheduler | null = null;
  private streamingPipeline: StreamingPipeline | null = null;

  // Cache for total file size (avoid running du on every request)
  private totalSizeCache: { value: number; timestamp: number } | null = null;
  private static TOTAL_SIZE_CACHE_TTL_MS = 30000; // 30 seconds

  constructor(
    vfs: VirtualFileSystem,
    config: UnifiedAPIServerConfig = {},
    unifiedStateManager?: UnifiedProcessingStateManager,
    getDuplicateResult?: () => DuplicateResult | null,
    kvClient?: IKVClient,
    triggerScanCallback?: () => Promise<void>,
    backgroundQueueConcurrency?: number,
    fastQueueConcurrency?: number,
    getQueueStatus?: () => any,
    kvManager?: KVManager,
    getPluginManager?: () => PluginManager | null,
    getTaskScheduler?: () => TaskScheduler | null
  ) {
    this.vfs = vfs;
    this.unifiedStateManager = unifiedStateManager || null;
    this.getDuplicateResult = getDuplicateResult || null;
    this.kvClient = kvClient || null;
    this.kvManager = kvManager || null;
    this.triggerScanCallback = triggerScanCallback || null;
    this.getQueueStatus = getQueueStatus || null;
    this.backgroundQueueConcurrency = backgroundQueueConcurrency;
    this.fastQueueConcurrency = fastQueueConcurrency;
    this.getPluginManager = getPluginManager || null;
    this.getTaskScheduler = getTaskScheduler || null;
    this.config = {
      port: config.port ?? 3000,
      host: config.host ?? 'localhost',
      enableCors: config.enableCors ?? true
    };

    // Initialize Fastify
    this.app = Fastify({
      logger: false,
      bodyLimit: 10 * 1024 * 1024 // 10MB
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup middleware (CORS, static files, etc.)
   */
  private setupMiddleware(): void {
    // CORS
    if (this.config.enableCors) {
      this.app.register(fastifyCors, {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
      });
    }
  }

  /**
   * Get total size of processed files from Redis sizeByte field (cached)
   * This is "eventually correct" - accumulates as files are processed by the file-info plugin
   */
  private async getTotalFileSizeFromRedis(): Promise<number> {
    // Check cache
    const now = Date.now();
    if (this.totalSizeCache && (now - this.totalSizeCache.timestamp) < UnifiedAPIServer.TOTAL_SIZE_CACHE_TTL_MS) {
      return this.totalSizeCache.value;
    }

    // Sum sizeByte from all file entries in Redis
    let totalSize = 0;

    if (!this.kvClient) {
      return 0;
    }

    try {
      // Get all file hash IDs
      const hashIds = await this.kvClient.getAllHashIds();

      // Sum up sizeByte values (batch process for efficiency)
      for (const hashId of hashIds) {
        try {
          const sizeByte = await this.kvClient.getMetadata(hashId, 'sizeByte');
          if (sizeByte !== null && sizeByte !== undefined) {
            const size = typeof sizeByte === 'number' ? sizeByte : parseInt(String(sizeByte), 10);
            if (!isNaN(size) && size > 0) {
              totalSize += size;
            }
          }
        } catch {
          // Skip entries without sizeByte
        }
      }
    } catch (error) {
      console.warn('[API] Failed to calculate total size from Redis:', error);
    }

    // Update cache
    this.totalSizeCache = { value: totalSize, timestamp: now };
    return totalSize;
  }

  /**
   * Setup all API routes
   */
  private setupRoutes(): void {
    // Root health check
    this.app.get('/health', async (request, reply) => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
          fuse: 'ok',
          metrics: 'ok',
          duplicates: 'ok',
          unifiedProcessing: this.unifiedStateManager ? 'ok' : 'unavailable'
        }
      };
    });

    // API health check (for dashboard UI)
    this.app.get('/api/health', async (request, reply) => {
      const redisOk = this.kvClient ? await this.kvClient.health() : false;
      const metrics = performanceMetrics.getMetrics();

      return {
        status: redisOk ? 'ok' : 'degraded',
        redis: redisOk,
        uptime: Math.floor(metrics.uptime / 1000), // in seconds
        version: '1.0.0',
        timestamp: new Date().toISOString()
      };
    });

    // FUSE API routes (under /api/fuse)
    this.setupFuseRoutes();

    // Metrics API routes (under /api/metrics)
    this.setupMetricsRoutes();

    // Duplicates API routes (under /api/duplicates)
    this.setupDuplicatesRoutes();

    // NOTE: Metadata API routes (/api/metadata/*) and KV Browser routes (/api/kv/*)
    // have been moved to meta-core Go API. The editor UI now uses meta-core's endpoints.
    // Only /api/metadata/clear (with rescan) is kept here in setupScanRoutes().

    // Unified processing state routes (under /api/processing)
    if (this.unifiedStateManager) {
      this.setupUnifiedProcessingRoutes();
    }

    // Scan trigger routes (under /api/scan)
    this.setupScanRoutes();

    // Stats routes (under /api/stats) - Redis stats for monitor UI
    if (this.kvClient) {
      this.setupStatsRoutes();
    }

    // Service discovery routes (under /api/services)
    if (this.kvManager) {
      this.setupServicesRoutes();
    }

    // Plugin management routes (under /api/plugins)
    // Always register - routes check for plugin manager at request time
    this.setupPluginRoutes();

    // Container plugin routes (under /api/plugins/containers and /api/plugins/callback)
    this.setupContainerPluginRoutes();

    // Meta-core compatible routes (under /meta/) - for container plugins to write metadata
    if (this.kvClient) {
      this.setupMetaCoreRoutes();
    }

    // File download routes (under /api/file)
    this.setupFileRoutes();

    // NOTE: Mount management routes are now handled by meta-core (Architecture V3)
    // Access mount API at http://meta-core/api/mounts/* or via the nginx proxy
  }

  /**
   * Setup File download routes
   */
  private setupFileRoutes(): void {
    // Download file by path
    this.app.get<{ Querystring: { path: string } }>('/api/file/download', async (request, reply) => {
      const { path: filePath } = request.query;

      if (!filePath) {
        return reply.status(400).send({ error: 'Missing path parameter' });
      }

      try {
        const fs = await import('fs');
        const pathModule = await import('path');

        // Security: ensure the path is within FILES_PATH
        const filesPath = config.FILES_PATH;
        const absolutePath = pathModule.resolve(filePath);

        if (!absolutePath.startsWith(filesPath)) {
          return reply.status(403).send({ error: 'Access denied - path outside files directory' });
        }

        // Check if file exists
        if (!fs.existsSync(absolutePath)) {
          return reply.status(404).send({ error: 'File not found' });
        }

        // Get file stats
        const stats = fs.statSync(absolutePath);
        if (!stats.isFile()) {
          return reply.status(400).send({ error: 'Path is not a file' });
        }

        // Set headers for download
        const filename = pathModule.basename(absolutePath);
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Length', stats.size);

        // Stream the file
        const stream = fs.createReadStream(absolutePath);
        return reply.send(stream);
      } catch (error) {
        console.error('Error downloading file:', error);
        return reply.status(500).send({
          error: 'Failed to download file',
          details: (error as Error).message
        });
      }
    });
  }

  // NOTE: Mount management routes have been moved to meta-core (Architecture V3)
  // Access the mount API at http://meta-core/api/mounts/*
  // - GET    /api/mounts              - List all mounts
  // - POST   /api/mounts              - Create mount
  // - GET    /api/mounts/:id          - Get mount
  // - DELETE /api/mounts/:id          - Delete mount
  // - POST   /api/mounts/:id/mount    - Request mount
  // - POST   /api/mounts/:id/unmount  - Request unmount
  // - GET    /api/mounts/rclone/remotes - List rclone remotes

  /**
   * Setup FUSE API routes
   */
  private setupFuseRoutes(): void {
    // Health check
    this.app.get('/api/fuse/health', async (request, reply) => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString()
      };
    });

    // VFS statistics
    this.app.get('/api/fuse/stats', async (request, reply) => {
      return this.vfs.getStats();
    });

    // Database statistics (KV)
    this.app.get('/api/fuse/db-stats', async (request, reply) => {
      if (!this.kvClient) {
        return reply.status(503).send({
          error: 'KV client not available'
        });
      }

      try {
        // Count files in database with /file/ prefix
        const fileCount = await this.kvClient.countKeysWithPrefix('/file/');
        return {
          fileCount,
          source: 'KV'
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to retrieve database stats',
          details: error.message
        });
      }
    });

    // List directory contents
    this.app.post<{ Body: { path: string } }>('/api/fuse/readdir', async (request, reply) => {
      const { path } = request.body;

      if (typeof path !== 'string') {
        return reply.status(400).send({
          error: 'Missing or invalid "path" parameter'
        });
      }

      const entries = this.vfs.readdir(path);

      if (entries === null) {
        return reply.status(404).send({ error: 'Directory not found' });
      }

      return { entries };
    });

    // Get file attributes
    this.app.post<{ Body: { path: string } }>('/api/fuse/getattr', async (request, reply) => {
      const { path } = request.body;

      if (typeof path !== 'string') {
        return reply.status(400).send({
          error: 'Missing or invalid "path" parameter'
        });
      }

      const attrs = this.vfs.getattr(path);

      if (attrs === null) {
        return reply.status(404).send({ error: 'Path not found' });
      }

      return attrs;
    });

    // Check if path exists
    this.app.post<{ Body: { path: string } }>('/api/fuse/exists', async (request, reply) => {
      const { path } = request.body;

      if (typeof path !== 'string') {
        return reply.status(400).send({
          error: 'Missing or invalid "path" parameter'
        });
      }

      const exists = this.vfs.exists(path);
      return { exists };
    });

    // Read file
    this.app.post<{ Body: { path: string } }>('/api/fuse/read', async (request, reply) => {
      const { path } = request.body;

      if (typeof path !== 'string') {
        return reply.status(400).send({
          error: 'Missing or invalid "path" parameter'
        });
      }

      const result = this.vfs.read(path);

      if (result === null) {
        return reply.status(404).send({ error: 'File not found' });
      }

      // Convert Buffer to base64 for JSON serialization
      const response: any = {
        sourcePath: result.sourcePath,
        size: result.size
      };

      if (result.content !== null) {
        response.content = result.content.toString('base64');
        response.contentEncoding = 'base64';
      }

      return response;
    });

    // Get file metadata
    this.app.post<{ Body: { path: string } }>('/api/fuse/metadata', async (request, reply) => {
      const { path } = request.body;

      if (typeof path !== 'string') {
        return reply.status(400).send({
          error: 'Missing or invalid "path" parameter'
        });
      }

      const metadata = this.vfs.getMetadata(path);

      if (metadata === null) {
        return reply.status(404).send({ error: 'Metadata not found' });
      }

      return metadata;
    });

    // Get complete VFS tree
    this.app.get('/api/fuse/tree', async (request, reply) => {
      return this.vfs.getTree();
    });

    // Get all file paths
    this.app.get('/api/fuse/files', async (request, reply) => {
      const files = this.vfs.getAllFiles();
      return { files };
    });

    // Get all source file paths (for Stremio addon validation)
    this.app.get('/api/fuse/source-paths', async (request, reply) => {
      const files = this.vfs.getAllFiles();
      const sourcePaths: string[] = [];

      for (const file of files) {
        // Skip virtual metadata files (.meta, .nfo, .xml)
        if (file.endsWith('.meta') || file.endsWith('.nfo') || file.endsWith('.xml')) {
          continue;
        }

        const result = this.vfs.read(file);
        if (result && result.sourcePath) {
          sourcePaths.push(result.sourcePath);
        }
      }

      return { sourcePaths, count: sourcePaths.length };
    });

    // Get all directory paths
    this.app.get('/api/fuse/directories', async (request, reply) => {
      const directories = this.vfs.getAllDirectories();
      return { directories };
    });

    // Refresh VFS
    this.app.post('/api/fuse/refresh', async (request, reply) => {
      await this.vfs.refresh();
      return { status: 'ok' };
    });
  }

  /**
   * Setup Metrics API routes
   */
  private setupMetricsRoutes(): void {
    // Get performance metrics
    this.app.get('/api/metrics', async (request, reply) => {
      return performanceMetrics.getMetrics();
    });
  }

  /**
   * Setup Duplicates API routes
   */
  private setupDuplicatesRoutes(): void {
    // Get duplicate files (from stored duplicate data)
    this.app.get('/api/duplicates', async (request, reply) => {
      try {
        // Get stored duplicate result from WatchedFileProcessor
        const duplicateResult = this.getDuplicateResult ? this.getDuplicateResult() : null;

        if (!duplicateResult) {
          // No duplicates found yet (processing hasn't completed)
          return {
            hashDuplicates: [],
            titleDuplicates: [],
            stats: {
              hashGroupCount: 0,
              hashFileCount: 0,
              titleGroupCount: 0,
              titleFileCount: 0
            }
          };
        }

        return {
          hashDuplicates: duplicateResult.hashDuplicates,
          titleDuplicates: duplicateResult.titleDuplicates,
          stats: {
            hashGroupCount: duplicateResult.hashDuplicates.length,
            hashFileCount: duplicateResult.hashDuplicates.reduce((sum, g) => sum + g.files.length, 0),
            titleGroupCount: duplicateResult.titleDuplicates.length,
            titleFileCount: duplicateResult.titleDuplicates.reduce((sum, g) => sum + g.files.length, 0)
          }
        };
      } catch (error) {
        console.error('Error retrieving duplicates:', error);
        return reply.status(500).send({
          error: 'Failed to retrieve duplicates',
          details: (error as Error).message
        });
      }
    });

    // Refresh duplicates (trigger re-computation)
    this.app.post('/api/duplicates/refresh', async (request, reply) => {
      // Currently just acknowledges the request
      // The duplicate detection runs automatically during processing
      return {
        status: 'ok',
        message: 'Duplicate refresh triggered'
      };
    });
  }

  // NOTE: setupMetadataRoutes() and setupKVBrowserRoutes() have been removed.
  // The metadata editor API (/api/metadata/*) and KV browser API (/api/kv/*)
  // are now implemented in meta-core Go API.
  // Only /api/metadata/clear (with rescan trigger) is kept in setupScanRoutes().

  /**
   * REMOVED - Metadata API routes moved to meta-core Go API
   * The following routes are now handled by meta-core:
   * - GET /api/metadata/hash-ids
   * - GET /api/metadata/list
   * - GET /api/metadata/:hashId
   * - PUT /api/metadata/:hashId
   * - DELETE /api/metadata/:hashId
   * - GET /api/metadata/:hashId/property
   * - PUT /api/metadata/:hashId/property
   * - POST /api/metadata/search
   * - POST /api/metadata/batch
   * - POST /api/metadata/clear (without rescan - see setupScanRoutes for clear+rescan)
   *
   * REMOVED - KV Browser API routes moved to meta-core Go API
   * The following routes are now handled by meta-core:
   * - GET /api/kv/info
   * - GET /api/kv/keys
   * - GET /api/kv/key/:key
   */

  /**
   * Setup Unified Processing State API routes (4-state pipeline)
   */
  private setupUnifiedProcessingRoutes(): void {
    if (!this.unifiedStateManager) {
      return;
    }

    // Get active processing queue (files currently being processed)
    this.app.get('/api/processing/queue', async (request, reply) => {
      const items: Array<{ path: string; phase: 'light' | 'hash'; startTime?: number; plugin?: string }> = [];

      // Get running tasks from TaskScheduler (container plugin tasks)
      const taskScheduler = this.getTaskScheduler?.();
      const runningTasks = taskScheduler?.getRunningTasks() || [];

      // Add running plugin tasks - map queue type to phase
      // 'fast' queue = 'light' phase, 'background' queue = 'hash' phase
      for (const task of runningTasks) {
        items.push({
          path: task.filePath,
          phase: task.queue === 'background' ? 'hash' : 'light',
          startTime: task.startTime,
          plugin: task.pluginId
        });
      }

      // Get files in light processing (midhash256 computation - no plugin yet)
      const lightProcessing = this.unifiedStateManager!.getLightProcessingFiles();
      for (const [filePath, info] of lightProcessing) {
        // Only add if not already in plugin tasks
        if (!runningTasks.some(t => t.filePath === filePath)) {
          items.push({
            path: filePath,
            phase: 'light',
            startTime: info.lightProcessingStartedAt
          });
        }
      }

      // Get files in hash processing (waiting for or running background tasks)
      const hashProcessing = this.unifiedStateManager!.getHashProcessingFiles();
      for (const [filePath, info] of hashProcessing) {
        // Only add if not already in plugin tasks
        if (!runningTasks.some(t => t.filePath === filePath)) {
          items.push({
            path: filePath,
            phase: 'hash',
            startTime: info.hashProcessingStartedAt
          });
        }
      }

      return { items };
    });

    // Get unified processing status snapshot (4 tabs: pending, lightProcessing, hashProcessing, done)
    this.app.get('/api/processing/status', async (request, reply) => {
      // Get snapshot from state manager
      // Note: VFS-related features have been moved to meta-fuse
      // totalDone now uses state manager's count of fully processed files
      const snapshot = this.unifiedStateManager!.getSnapshot(0, this.fastQueueConcurrency, this.backgroundQueueConcurrency) as ExtendedProcessingSnapshot;

      // Add queue status if available
      if (this.getQueueStatus) {
        const queueStatus = this.getQueueStatus();
        snapshot.queueStatus = queueStatus;

        // Add calculated fields that the UI needs (make API self-describing)
        // Pipeline: validation (preProcess) → lightProcessing (fast) → hashProcessing (background)
        const preProcessRunning = queueStatus.preProcessQueue?.pending || 0;
        const preProcessPending = queueStatus.preProcessQueue?.size || 0;
        const fastQueueRunning = queueStatus.fastQueue?.running || 0;
        const fastQueuePending = queueStatus.fastQueue?.pending || 0;
        const backgroundQueueRunning = queueStatus.backgroundQueue?.running || 0;
        const backgroundQueuePending = queueStatus.backgroundQueue?.pending || 0;

        // "Discovered" now represents files waiting for fast queue (validated but not yet processing)
        // This merges the old "discovered" and "awaitingFastQueue" concepts
        snapshot.totalDiscovered = fastQueuePending;
        snapshot.awaitingFastQueue = fastQueuePending; // Keep for backward compatibility

        // Fix awaitingBackground: subtract files currently being processed by background workers
        // hashProcessing.size includes both waiting AND running files
        snapshot.awaitingBackground = Math.max(0, snapshot.awaitingBackground - backgroundQueueRunning);

        // Get gate status if container scheduler is available
        const gateStatus = this.containerPluginScheduler?.getGateStatus();

        snapshot.computed = {
          // Pre-process queue (validation - quick extension checks)
          preProcessRunning,
          preProcessPending,
          preProcessPaused: queueStatus.preProcessQueue?.isPaused || false,

          // Fast plugin queue (plugins with <1s avg execution)
          fastQueueRunning,
          fastQueuePending,
          fastQueueTotal: fastQueueRunning + fastQueuePending + (queueStatus.fastQueue?.size || 0),
          fastQueuePaused: queueStatus.fastQueue?.isPaused || false,

          // Background plugin queue (plugins with >=1s avg execution, e.g., full-hash, tmdb)
          backgroundQueueRunning,
          backgroundQueuePending,
          backgroundQueueTotal: backgroundQueueRunning + backgroundQueuePending + (queueStatus.backgroundQueue?.size || 0),
          backgroundQueuePaused: queueStatus.backgroundQueue?.isPaused || false,

          // Gate control status (for safe mount/unmount operations)
          gateOpen: gateStatus?.isOpen ?? true,
          gateStatus: gateStatus ?? null,
          pipelinePaused: this.streamingPipeline?.isPaused() ?? false,

          // Legacy compatibility fields (UI may still reference these)
          actualRunningHashWorkers: backgroundQueueRunning,
          actualRunningLightWorkers: preProcessRunning + fastQueueRunning,
          trueHashQueueSize: backgroundQueuePending,
          hashQueuePaused: queueStatus.backgroundQueue?.isPaused || false,
          lightQueuePaused: queueStatus.preProcessQueue?.isPaused || false
        };
      }

      // Add failed files count from metrics
      const metrics = performanceMetrics.getMetrics();
      snapshot.totalFailed = metrics.totalFailedFiles || 0;

      return snapshot;
    });

    // Get failed files list
    this.app.get('/api/processing/failed', async (request, reply) => {
      const metrics = performanceMetrics.getMetrics();
      return {
        failedFiles: metrics.failedFiles || [],
        totalFailed: metrics.totalFailedFiles || 0
      };
    });

    // Retry a failed file
    this.app.post<{ Body: { filePath: string } }>('/api/processing/retry', async (request, reply) => {
      const { filePath } = request.body;

      if (!filePath) {
        return reply.status(400).send({ error: 'filePath is required' });
      }

      try {
        // Add file back to discovered state for reprocessing
        this.unifiedStateManager!.addDiscovered(filePath);

        // Trigger scan callback if available to pick up the file
        if (this.triggerScanCallback) {
          // Don't await - just trigger async
          this.triggerScanCallback().catch(err => console.warn('[API] Scan trigger failed during retry:', getErrorMessage(err)));
        }

        return { status: 'ok', message: `File ${filePath} queued for retry` };
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    });

    // Retry all failed files
    this.app.post('/api/processing/retry-all', async (request, reply) => {
      const metrics = performanceMetrics.getMetrics();
      const failedFiles = metrics.failedFiles || [];

      let queued = 0;
      for (const file of failedFiles) {
        this.unifiedStateManager!.addDiscovered(file.filePath);
        queued++;
      }

      // Trigger scan callback if available
      if (this.triggerScanCallback) {
        this.triggerScanCallback().catch(err => console.warn('[API] Scan trigger failed during retry-all:', getErrorMessage(err)));
      }

      return { status: 'ok', message: `${queued} files queued for retry` };
    });

    // POST /api/processing/stop - Stop all processing
    // Pauses pipeline queues and closes container plugin gate
    // Running tasks will complete, but no new tasks will start
    this.app.post('/api/processing/stop', async (request, reply) => {
      // Pause the streaming pipeline (stops new files from being processed)
      if (this.streamingPipeline) {
        this.streamingPipeline.pause();
      }

      // Close the container plugin gate (stops new plugin tasks)
      if (this.containerPluginScheduler) {
        this.containerPluginScheduler.setGate(false);
      }

      const gateStatus = this.containerPluginScheduler?.getGateStatus() ?? null;
      const pipelinePaused = this.streamingPipeline?.isPaused() ?? false;

      console.log('[API] Processing stopped - pipeline paused, gate closed');

      return {
        status: 'ok',
        message: 'Processing stopped - pipeline paused, gate closed',
        gateStatus,
        pipelinePaused
      };
    });

    // POST /api/processing/start - Resume all processing
    // Resumes pipeline queues and opens container plugin gate
    this.app.post('/api/processing/start', async (request, reply) => {
      // Resume the streaming pipeline
      if (this.streamingPipeline) {
        this.streamingPipeline.resume();
      }

      // Open the container plugin gate
      if (this.containerPluginScheduler) {
        this.containerPluginScheduler.setGate(true);
      }

      const gateStatus = this.containerPluginScheduler?.getGateStatus() ?? null;
      const pipelinePaused = this.streamingPipeline?.isPaused() ?? false;

      console.log('[API] Processing started - pipeline resumed, gate opened');

      return {
        status: 'ok',
        message: 'Processing started - pipeline resumed, gate opened',
        gateStatus,
        pipelinePaused
      };
    });

    // POST /api/processing/wait-empty - Wait for queues to drain
    // Optional query param: timeout (ms, default 60000)
    this.app.post<{ Querystring: { timeout?: string } }>('/api/processing/wait-empty', async (request, reply) => {
      if (!this.containerPluginScheduler) {
        return reply.status(503).send({
          status: 'error',
          message: 'Container plugin scheduler not available'
        });
      }

      const timeoutMs = parseInt(request.query.timeout || '60000', 10);
      const success = await this.containerPluginScheduler.waitForEmpty(timeoutMs);
      const gateStatus = this.containerPluginScheduler.getGateStatus();

      return {
        status: success ? 'ok' : 'timeout',
        message: success ? 'Queues are empty' : `Timeout after ${timeoutMs}ms`,
        gateStatus
      };
    });
  }


  /**
   * Setup Stats API routes (Redis stats for monitor UI)
   */
  private setupStatsRoutes(): void {
    if (!this.kvClient) {
      return;
    }

    // Get Redis/KV stats (for monitor UI)
    this.app.get('/api/stats', async (request, reply) => {
      try {
        const hashIds = await this.kvClient!.getAllHashIds();
        const redis = (this.kvClient as IKVClientWithPubSub).getRedisClient?.() as { info: (section: string) => Promise<string> } | undefined;

        let memoryUsage = 'N/A';
        let memoryUsageBytes = 0;
        if (redis) {
          try {
            const info = await redis.info('memory');
            const match = info.match(/used_memory_human:(\S+)/);
            const bytesMatch = info.match(/used_memory:(\d+)/);
            if (match) {
              memoryUsage = match[1];
            }
            if (bytesMatch) {
              memoryUsageBytes = parseInt(bytesMatch[1], 10);
            }
          } catch {
            // Ignore memory info errors
          }
        }

        // Get total size from Redis sizeByte (eventually correct as files are processed)
        const totalSize = await this.getTotalFileSizeFromRedis();

        return {
          fileCount: hashIds.length,
          keyCount: hashIds.length,
          totalSize,
          memoryUsage,
          memoryUsageBytes
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to get stats',
          details: error.message
        });
      }
    });
  }

  /**
   * Setup Scan Trigger API routes
   */
  private setupScanRoutes(): void {
    // Trigger manual scan
    this.app.post('/api/scan/trigger', async (request, reply) => {
      if (!this.triggerScanCallback) {
        return reply.status(503).send({
          status: 'error',
          message: 'Scan trigger not available'
        });
      }

      try {
        console.log('Manual scan triggered via API');
        // Don't await - trigger and return immediately
        this.triggerScanCallback().catch(error => {
          console.error('Error during triggered scan:', error);
        });

        return {
          status: 'ok',
          message: 'Scan triggered successfully'
        };
      } catch (error: any) {
        console.error('Error triggering scan:', error);
        return reply.status(500).send({
          status: 'error',
          message: 'Failed to trigger scan',
          details: error.message
        });
      }
    });

    // Clear all metadata and trigger rescan
    this.app.post('/api/metadata/clear', async (request, reply) => {
      if (!this.kvClient) {
        return reply.status(503).send({
          status: 'error',
          message: 'KV client not available'
        });
      }

      try {
        console.log('Clearing all metadata via API');

        // Get all file keys and delete them
        const hashIds = await this.kvClient.getAllHashIds();
        let deletedCount = 0;

        for (const hashId of hashIds) {
          try {
            await this.kvClient.delete(`/file/${hashId}`);
            deletedCount++;
          } catch (err) {
            console.warn(`Failed to delete key /file/${hashId}:`, err);
          }
        }

        // Also delete the index key
        try {
          await this.kvClient.delete('/file/__index__');
        } catch (err) {
          // Index might not exist
        }

        console.log(`Cleared ${deletedCount} file metadata entries`);

        // Trigger rescan if callback is available
        if (this.triggerScanCallback) {
          console.log('Triggering rescan after metadata clear');
          this.triggerScanCallback().catch(error => {
            console.error('Error during post-clear rescan:', error);
          });
        }

        return {
          status: 'ok',
          message: `Cleared ${deletedCount} files`,
          deletedCount,
          rescanTriggered: !!this.triggerScanCallback
        };
      } catch (error: any) {
        console.error('Error clearing metadata:', error);
        return reply.status(500).send({
          status: 'error',
          message: 'Failed to clear metadata',
          details: error.message
        });
      }
    });
  }

  /**
   * Setup Services Discovery API routes
   * Returns list of discovered services for dashboard navigation
   */
  private setupServicesRoutes(): void {
    if (!this.kvManager) {
      return;
    }

    // Get discovered services (for inter-service navigation)
    this.app.get('/api/services', async (request, reply) => {
      const services: Array<{
        name: string;
        url: string;
        api: string;
        status: string;
      }> = [];

      try {
        const serviceDiscovery = this.kvManager!.getServiceDiscovery();
        if (serviceDiscovery) {
          const allServices = await serviceDiscovery.discoverAllServices();

          for (const svc of allServices) {
            services.push({
              name: svc.name || 'Unknown',
              url: svc.baseUrl || '',
              api: svc.baseUrl || '',
              status: svc.status || 'unknown',
            });
          }
        }
      } catch (error: any) {
        console.error('[Services API] Error discovering services:', error);
      }

      // Get leader info
      const leaderInfo = this.kvManager!.getLeaderInfo();

      return {
        services,
        current: 'meta-sort',
        leader: leaderInfo ? {
          hostname: leaderInfo.hostname,
          baseUrl: leaderInfo.baseUrl,
          apiUrl: leaderInfo.apiUrl,
          redisUrl: leaderInfo.redisUrl,
          webdavUrl: leaderInfo.webdavUrl,
        } : null,
      };
    });
  }

  /**
   * Setup Plugin Management API routes
   */
  private setupPluginRoutes(): void {
    // Get all plugins with their status, config, and schema
    this.app.get('/api/plugins', async (request, reply) => {
      const pluginManager = this.getPluginManager?.();
      if (!pluginManager) {
        return reply.status(503).send({
          error: 'Plugin manager not yet initialized',
          message: 'Plugins are loaded on first file processing'
        });
      }

      try {
        const plugins = pluginManager.getPlugins();
        const executionOrder = pluginManager.getExecutionOrder();

        return {
          plugins: plugins.map(p => ({
            id: p.id,
            name: p.name,
            version: p.version,
            description: p.description,
            priority: p.priority,
            color: p.color,
            dependencies: p.dependencies,
            active: p.active,
            status: p.status,
            error: p.error,
            config: p.config,
            configSchema: p.configSchema,
            metadataSchema: p.metadataSchema
          })),
          executionOrder,
          activeCount: plugins.filter(p => p.active).length,
          totalCount: plugins.length
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to get plugins',
          details: error.message
        });
      }
    });

    // Get plugin timings from performance metrics
    this.app.get('/api/plugins/timings', async (request, reply) => {
      try {
        const metrics = performanceMetrics.getMetrics();
        const pluginTimings = metrics.pluginProcessingTimes || {};

        // Convert to array format with stats
        const timings = Object.entries(pluginTimings).map(([pluginId, data]: [string, any]) => ({
          pluginId,
          totalCalls: data.count || 0,
          totalTime: data.total || 0,
          avgTime: data.count > 0 ? Math.round(data.total / data.count) : 0,
          minTime: data.min || 0,
          maxTime: data.max || 0
        }));

        return {
          timings,
          lastReset: metrics.startTime
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to get plugin timings',
          details: error.message
        });
      }
    });

    // Activate a plugin
    this.app.post<{ Params: { pluginId: string } }>('/api/plugins/:pluginId/activate', async (request, reply) => {
      const pluginManager = this.getPluginManager?.();
      if (!pluginManager) {
        return reply.status(503).send({ error: 'Plugin manager not yet initialized' });
      }

      const { pluginId } = request.params;

      try {
        await pluginManager.activate(pluginId);
        return {
          status: 'ok',
          message: `Plugin ${pluginId} activated successfully`,
          executionOrder: pluginManager.getExecutionOrder()
        };
      } catch (error: any) {
        return reply.status(400).send({
          error: 'Failed to activate plugin',
          details: error.message
        });
      }
    });

    // Deactivate a plugin
    this.app.post<{ Params: { pluginId: string } }>('/api/plugins/:pluginId/deactivate', async (request, reply) => {
      const pluginManager = this.getPluginManager?.();
      if (!pluginManager) {
        return reply.status(503).send({ error: 'Plugin manager not yet initialized' });
      }

      const { pluginId } = request.params;

      try {
        await pluginManager.deactivate(pluginId);
        return {
          status: 'ok',
          message: `Plugin ${pluginId} deactivated successfully`,
          executionOrder: pluginManager.getExecutionOrder()
        };
      } catch (error: any) {
        return reply.status(400).send({
          error: 'Failed to deactivate plugin',
          details: error.message
        });
      }
    });

    // Update plugin configuration
    this.app.put<{
      Params: { pluginId: string };
      Body: Record<string, unknown>
    }>('/api/plugins/:pluginId/config', async (request, reply) => {
      const pluginManager = this.getPluginManager?.();
      if (!pluginManager) {
        return reply.status(503).send({ error: 'Plugin manager not yet initialized' });
      }

      const { pluginId } = request.params;
      const newConfig = request.body;

      try {
        await pluginManager.updateConfig(pluginId, newConfig);
        const plugins = pluginManager.getPlugins();
        const plugin = plugins.find(p => p.id === pluginId);

        return {
          status: 'ok',
          message: `Plugin ${pluginId} configuration updated`,
          config: plugin?.config
        };
      } catch (error: any) {
        return reply.status(400).send({
          error: 'Failed to update plugin config',
          details: error.message
        });
      }
    });

    // Clear plugin cache for a specific plugin
    this.app.post<{ Params: { pluginId: string } }>('/api/plugins/:pluginId/clear-cache', async (request, reply) => {
      const pluginManager = this.getPluginManager?.();
      if (!pluginManager) {
        return reply.status(503).send({ error: 'Plugin manager not yet initialized' });
      }

      const { pluginId } = request.params;

      // Container plugins don't have local caches
      return {
        status: 'ok',
        message: `Cache clear not applicable for container plugin ${pluginId}`
      };
    });

    // Clear all plugin caches
    this.app.post('/api/plugins/clear-cache', async (request, reply) => {
      try {
        const fs = await import('fs/promises');
        const fsSync = await import('fs');
        const path = await import('path');

        const cacheDir = path.join(config.CACHE_FOLDER_PATH, 'plugin-cache');

        let deletedFiles = 0;
        let deletedDirs = 0;

        // Clear plugin cache directory
        if (fsSync.existsSync(cacheDir)) {
          const entries = await fs.readdir(cacheDir, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(cacheDir, entry.name);
            try {
              if (entry.isDirectory()) {
                await fs.rm(entryPath, { recursive: true, force: true });
                deletedDirs++;
              } else {
                await fs.unlink(entryPath);
                deletedFiles++;
              }
            } catch (err) {
              console.warn(`Failed to delete ${entryPath}:`, err);
            }
          }
        }

        console.log(`Cleared plugin cache: ${deletedDirs} directories, ${deletedFiles} files`);

        return {
          status: 'ok',
          message: `Cleared plugin cache`,
          deletedDirs,
          deletedFiles
        };
      } catch (error: any) {
        console.error('Error clearing plugin cache:', error);
        return reply.status(500).send({
          status: 'error',
          message: 'Failed to clear plugin cache',
          details: error.message
        });
      }
    });

    // Rescan plugins (reload from container manager)
    this.app.post('/api/plugins/rescan', async (request, reply) => {
      const pluginManager = this.getPluginManager?.();
      if (!pluginManager) {
        return reply.status(503).send({ error: 'Plugin manager not yet initialized' });
      }

      try {
        // Reload container plugins from container manager
        await pluginManager.loadContainerPlugins();
        const plugins = pluginManager.getPlugins();
        return {
          status: 'ok',
          message: 'Plugin rescan complete',
          pluginCount: plugins.length
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to rescan plugins',
          details: error.message
        });
      }
    });

    // Recompute plugin on all files (runs plugin with forceRecompute flag)
    this.app.post<{ Params: { pluginId: string } }>('/api/plugins/:pluginId/recompute', async (request, reply) => {
      const pluginManager = this.getPluginManager?.();
      if (!pluginManager) {
        return reply.status(503).send({ error: 'Plugin manager not yet initialized' });
      }

      const taskScheduler = this.getTaskScheduler?.();
      if (!taskScheduler) {
        return reply.status(503).send({ error: 'Task scheduler not yet initialized' });
      }

      if (!this.kvClient) {
        return reply.status(503).send({ error: 'KV client not available' });
      }

      const { pluginId } = request.params;

      // Verify plugin exists and is active
      const plugins = pluginManager.getPlugins();
      const plugin = plugins.find(p => p.id === pluginId);

      if (!plugin) {
        return reply.status(404).send({ error: `Plugin '${pluginId}' not found` });
      }

      if (!plugin.active) {
        return reply.status(400).send({ error: `Plugin '${pluginId}' is not active` });
      }

      try {
        // Get all files from KV
        const hashIds = await this.kvClient.getAllHashIds();
        console.log(`[Recompute] Starting recompute for plugin '${pluginId}' on ${hashIds.length} files`);

        // Prepare file data with metadata for TaskScheduler
        const files: Array<{ filePath: string; fileHash: string; kvData?: Record<string, string> }> = [];

        for (const hashId of hashIds) {
          const metadata = await this.kvClient.getMetadataFlat(hashId);
          if (metadata && metadata.filePath) {
            // Convert nested metadata to flat key-value pairs for KVStore
            const kvData: Record<string, string> = {};
            const flattenObj = (obj: any, prefix = '') => {
              for (const [key, value] of Object.entries(obj)) {
                const fullKey = prefix ? `${prefix}/${key}` : key;
                if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                  flattenObj(value, fullKey);
                } else if (value !== undefined && value !== null) {
                  kvData[fullKey] = String(value);
                }
              }
            };
            flattenObj(metadata);

            files.push({
              fileHash: hashId,
              filePath: metadata.filePath,
              kvData
            });
          }
        }

        // Create and enqueue tasks with forceRecompute option
        const tasks = taskScheduler.createTasksForPluginOnFiles(
          pluginId,
          files,
          { forceRecompute: true }
        );

        // Enqueue all tasks
        taskScheduler.enqueueTasks(tasks);

        console.log(`[Recompute] Queued ${tasks.length} tasks for plugin '${pluginId}'`);

        return {
          status: 'ok',
          message: `Recompute triggered for plugin '${pluginId}'`,
          filesQueued: tasks.length,
          totalFiles: hashIds.length
        };
      } catch (error: any) {
        console.error(`[Recompute] Error triggering recompute for plugin '${pluginId}':`, error);
        return reply.status(500).send({
          error: 'Failed to trigger recompute',
          details: error.message
        });
      }
    });
  }

  /**
   * Setup Container Plugin API routes
   * Handles container plugin management and task callbacks
   */
  private setupContainerPluginRoutes(): void {
    // Callback endpoint for container plugins to report task completion
    this.app.post<{
      Body: PluginCallbackPayload
    }>('/api/plugins/callback', async (request, reply) => {
      if (!this.containerPluginScheduler) {
        return reply.status(503).send({
          error: 'Container plugin scheduler not initialized'
        });
      }

      const payload = request.body;

      if (!payload || !payload.taskId) {
        return reply.status(400).send({
          error: 'Invalid callback payload: missing taskId'
        });
      }

      try {
        const handled = this.containerPluginScheduler.handleCallback(payload);

        if (!handled) {
          return reply.status(404).send({
            error: 'Unknown task ID',
            taskId: payload.taskId
          });
        }

        return {
          status: 'ok',
          taskId: payload.taskId
        };
      } catch (error: any) {
        console.error('[ContainerPluginCallback] Error handling callback:', error);
        return reply.status(500).send({
          error: 'Failed to handle callback',
          details: error.message
        });
      }
    });

    // List container plugin status
    this.app.get('/api/plugins/containers', async (request, reply) => {
      if (!this.containerManager) {
        return reply.status(503).send({
          error: 'Container manager not initialized',
          message: 'Container plugins are disabled or not yet initialized'
        });
      }

      try {
        const status = this.containerManager.getStatus();
        const queueStatus = this.containerPluginScheduler?.getQueueStatus();

        return {
          initialized: status.initialized,
          pluginCount: status.plugins.length,
          plugins: status.plugins.map(p => ({
            id: p.pluginId,
            instanceCount: p.instances,
            healthyCount: p.healthyInstances,
            enabled: p.enabled,
            image: p.image
          })),
          queue: queueStatus || null
        };
      } catch (error: any) {
        console.error('[ContainerPlugins] Error getting status:', error);
        return reply.status(500).send({
          error: 'Failed to get container plugin status',
          details: error.message
        });
      }
    });

    // Get container plugin manifest
    this.app.get<{
      Params: { pluginId: string }
    }>('/api/plugins/containers/:pluginId/manifest', async (request, reply) => {
      if (!this.containerManager) {
        return reply.status(503).send({ error: 'Container manager not initialized' });
      }

      const { pluginId } = request.params;

      try {
        const manifest = this.containerManager.getPluginManifest(pluginId);

        if (!manifest) {
          return reply.status(404).send({
            error: `Container plugin '${pluginId}' not found`
          });
        }

        return manifest;
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to get plugin manifest',
          details: error.message
        });
      }
    });

    // Restart a container plugin instance
    this.app.post<{
      Params: { pluginId: string };
      Querystring: { instance?: string }
    }>('/api/plugins/containers/:pluginId/restart', async (request, reply) => {
      if (!this.containerManager) {
        return reply.status(503).send({ error: 'Container manager not initialized' });
      }

      const { pluginId } = request.params;

      try {
        // Restart all instances of the plugin
        await this.containerManager.restartPlugin(pluginId);
        return {
          status: 'ok',
          message: `Plugin '${pluginId}' restarted`
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to restart container plugin',
          details: error.message
        });
      }
    });

    // Stop a container plugin (not supported - use restart instead)
    this.app.post<{
      Params: { pluginId: string }
    }>('/api/plugins/containers/:pluginId/stop', async (request, reply) => {
      return reply.status(501).send({
        error: 'Stop operation not supported',
        message: 'Use restart to reload plugin instances'
      });
    });

    // Start a container plugin (not supported - plugins auto-start)
    this.app.post<{
      Params: { pluginId: string }
    }>('/api/plugins/containers/:pluginId/start', async (request, reply) => {
      return reply.status(501).send({
        error: 'Start operation not supported',
        message: 'Plugins are started automatically during initialization. Use restart to reload.'
      });
    });

    // Get container logs (not implemented)
    this.app.get<{
      Params: { pluginId: string };
      Querystring: { instance?: string; tail?: string }
    }>('/api/plugins/containers/:pluginId/logs', async (request, reply) => {
      return reply.status(501).send({
        error: 'Log retrieval not implemented',
        message: 'Use docker logs command directly for container logs'
      });
    });

    // Add new container plugin
    this.app.post<{
      Body: {
        pluginId: string;
        image: string;
        instances?: number;
        resources?: { memory?: string; cpus?: number };
        config?: Record<string, unknown>;
        network?: boolean;
        defaultQueue?: 'fast' | 'background';
      }
    }>('/api/plugins/containers', async (request, reply) => {
      if (!this.containerManager) {
        return reply.status(503).send({ error: 'Container manager not initialized' });
      }

      const { pluginId, image, instances, resources, config: pluginConfig, network, defaultQueue } = request.body;

      if (!pluginId) {
        return reply.status(400).send({ error: 'pluginId is required' });
      }

      if (!image) {
        return reply.status(400).send({ error: 'image is required' });
      }

      try {
        await this.containerManager.addPlugin(pluginId, image, {
          instances,
          resources,
          config: pluginConfig,
          network,
          defaultQueue,
        });

        return {
          success: true,
          message: `Plugin '${pluginId}' added successfully`
        };
      } catch (error: any) {
        return reply.status(400).send({
          error: 'Failed to add plugin',
          details: error.message
        });
      }
    });

    // Remove container plugin
    this.app.delete<{
      Params: { pluginId: string }
    }>('/api/plugins/containers/:pluginId', async (request, reply) => {
      if (!this.containerManager) {
        return reply.status(503).send({ error: 'Container manager not initialized' });
      }

      const { pluginId } = request.params;

      try {
        await this.containerManager.removePlugin(pluginId);
        return {
          success: true,
          message: `Plugin '${pluginId}' removed successfully`
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to remove plugin',
          details: error.message
        });
      }
    });

    // Update container plugin
    this.app.put<{
      Params: { pluginId: string };
      Body: {
        image?: string;
        instances?: number;
        resources?: { memory?: string; cpus?: number };
        config?: Record<string, unknown>;
        network?: boolean;
        defaultQueue?: 'fast' | 'background';
      }
    }>('/api/plugins/containers/:pluginId', async (request, reply) => {
      if (!this.containerManager) {
        return reply.status(503).send({ error: 'Container manager not initialized' });
      }

      const { pluginId } = request.params;
      const updates = request.body;

      if (!updates || Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: 'No updates provided' });
      }

      try {
        await this.containerManager.updatePluginConfig(pluginId, updates);
        return {
          success: true,
          message: `Plugin '${pluginId}' updated successfully`
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to update plugin',
          details: error.message
        });
      }
    });

    // Restart all container plugins
    this.app.post('/api/plugins/containers/restart-all', async (request, reply) => {
      if (!this.containerManager) {
        return reply.status(503).send({ error: 'Container manager not initialized' });
      }

      try {
        await this.containerManager.restartAllPlugins();
        return {
          success: true,
          message: 'All plugins restarted successfully'
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to restart plugins',
          details: error.message
        });
      }
    });
  }

  /**
   * Setup meta-core compatible API routes
   * These routes allow container plugins to write metadata directly to Redis
   * Matches the meta-core Go sidecar API for compatibility
   */
  private setupMetaCoreRoutes(): void {
    if (!this.kvClient) {
      return;
    }

    // GET /meta/{hash} - Get all metadata for a file
    this.app.get<{
      Params: { hash: string }
    }>('/meta/:hash', async (request, reply) => {
      const { hash } = request.params;

      try {
        const metadata = await this.kvClient!.getMetadataFlat(hash);
        return { metadata: metadata || {} };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to get metadata',
          details: error.message
        });
      }
    });

    // GET /meta/{hash}/{key} - Get single property (supports nested keys with slashes)
    this.app.get<{
      Params: { hash: string; '*': string }
    }>('/meta/:hash/*', async (request, reply) => {
      const { hash } = request.params;
      const key = request.params['*'];

      if (!key) {
        return reply.status(400).send({ error: 'Missing key' });
      }

      try {
        const metadata = await this.kvClient!.getMetadataFlat(hash);
        if (!metadata) {
          return reply.status(404).send({ error: 'Hash not found' });
        }

        const value = metadata[key];
        if (value === undefined) {
          return reply.status(404).send({ error: 'Property not found' });
        }

        return { value };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to get property',
          details: error.message
        });
      }
    });

    // PUT /meta/{hash}/{key} - Set single property
    this.app.put<{
      Params: { hash: string; '*': string };
      Body: { value: string }
    }>('/meta/:hash/*', async (request, reply) => {
      const { hash } = request.params;
      const key = request.params['*'];
      const { value } = request.body || {};

      if (!key) {
        return reply.status(400).send({ error: 'Missing key' });
      }

      if (value === undefined) {
        return reply.status(400).send({ error: 'Missing value in body' });
      }

      try {
        // Get existing metadata and merge
        const existing = await this.kvClient!.getMetadataFlat(hash) || {};
        existing[key] = String(value);
        await this.kvClient!.setMetadataFlat(hash, existing);

        return { status: 'ok' };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to set property',
          details: error.message
        });
      }
    });

    // DELETE /meta/{hash}/{key} - Delete single property
    this.app.delete<{
      Params: { hash: string; '*': string }
    }>('/meta/:hash/*', async (request, reply) => {
      const { hash } = request.params;
      const key = request.params['*'];

      if (!key) {
        return reply.status(400).send({ error: 'Missing key' });
      }

      try {
        const existing = await this.kvClient!.getMetadataFlat(hash);
        if (!existing) {
          return { status: 'ok' }; // Nothing to delete
        }

        delete existing[key];
        await this.kvClient!.setMetadataFlat(hash, existing);

        return { status: 'ok' };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to delete property',
          details: error.message
        });
      }
    });

    // PATCH /meta/{hash} - Merge metadata (partial update)
    this.app.patch<{
      Params: { hash: string };
      Body: Record<string, string>
    }>('/meta/:hash', async (request, reply) => {
      const { hash } = request.params;
      const newMetadata = request.body;

      if (!newMetadata || typeof newMetadata !== 'object') {
        return reply.status(400).send({ error: 'Body must be an object with key-value pairs' });
      }

      try {
        // Get existing metadata and merge
        const existing = await this.kvClient!.getMetadataFlat(hash) || {};
        const merged = { ...existing, ...newMetadata };
        await this.kvClient!.setMetadataFlat(hash, merged);

        return { status: 'ok' };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to merge metadata',
          details: error.message
        });
      }
    });

    // POST /meta/{hash}/_add/{key} - Add value to a set field (comma-separated)
    this.app.post<{
      Params: { hash: string; key: string };
      Body: { value: string }
    }>('/meta/:hash/_add/:key', async (request, reply) => {
      const { hash, key } = request.params;
      const { value } = request.body || {};

      if (!value) {
        return reply.status(400).send({ error: 'Missing value in body' });
      }

      try {
        const existing = await this.kvClient!.getMetadataFlat(hash) || {};
        const currentValue = existing[key] || '';

        // Parse existing as comma-separated set
        const values = new Set(currentValue ? currentValue.split(',').map(v => v.trim()) : []);
        values.add(String(value));

        existing[key] = Array.from(values).join(',');
        await this.kvClient!.setMetadataFlat(hash, existing);

        return { status: 'ok' };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to add to set',
          details: error.message
        });
      }
    });

    // Health check for meta-core compatibility
    this.app.get('/meta-health', async () => {
      return { status: 'ok', service: 'meta-sort-kv' };
    });

    // POST /file/cid - Compute CID for a file (for poster/backdrop hashing)
    this.app.post<{ Body: { path: string } }>('/file/cid', async (request, reply) => {
      const { path: relativePath } = request.body;

      if (!relativePath) {
        reply.status(400);
        return { error: 'Bad Request', message: 'path is required' };
      }

      // Construct full path
      const fullPath = `${config.FILES_PATH}/${relativePath}`;

      // Security check: ensure path is within FILES_PATH
      const path = await import('path');
      const absFilesPath = path.resolve(config.FILES_PATH);
      const absFullPath = path.resolve(fullPath);
      if (!absFullPath.startsWith(absFilesPath)) {
        reply.status(400);
        return { error: 'Bad Request', message: 'path must be within files directory' };
      }

      try {
        const fs = await import('fs/promises');
        const crypto = await import('crypto');

        // Check if file exists
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          reply.status(400);
          return { error: 'Bad Request', message: 'path is a directory, not a file' };
        }

        // Read file and compute SHA-256
        const fileBuffer = await fs.readFile(fullPath);
        const hashBytes = crypto.createHash('sha256').update(fileBuffer).digest();

        // Build CIDv1 with raw codec (0x55) and sha256 multihash
        // CIDv1 format: version (0x01) + codec (0x55) + multihash
        // Multihash format: hash-code (0x12) + length (0x20) + hash
        const cidBytes = Buffer.concat([
          Buffer.from([0x01]),       // CIDv1
          Buffer.from([0x55]),       // raw codec
          Buffer.from([0x12]),       // sha256 code
          Buffer.from([0x20]),       // 32 bytes
          hashBytes
        ]);

        // Encode as base32lower with 'b' prefix (multibase)
        // Note: Node's base32 encoding uses uppercase, so we lowercase it
        const base32Chars = 'abcdefghijklmnopqrstuvwxyz234567';
        let cid = 'b';
        let bits = 0;
        let value = 0;
        for (const byte of cidBytes) {
          value = (value << 8) | byte;
          bits += 8;
          while (bits >= 5) {
            bits -= 5;
            cid += base32Chars[(value >> bits) & 0x1f];
          }
        }
        if (bits > 0) {
          cid += base32Chars[(value << (5 - bits)) & 0x1f];
        }

        return {
          cid,
          path: relativePath,
          size: stats.size
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reply.status(404);
          return { error: 'Not Found', message: 'file not found' };
        }
        reply.status(500);
        return { error: 'Internal Server Error', message: (error as Error).message };
      }
    });

    console.log('[UnifiedAPIServer] Meta-core compatible routes registered at /meta/*');
    console.log('[UnifiedAPIServer] File CID endpoint registered at POST /file/cid');
  }

  /**
   * Set container plugin manager and scheduler (called after initialization)
   */
  public setContainerPluginManager(
    containerManager: ContainerManager,
    scheduler: ContainerPluginScheduler
  ): void {
    this.containerManager = containerManager;
    this.containerPluginScheduler = scheduler;
    console.log('[UnifiedAPIServer] Container plugin manager and scheduler set');
  }

  /**
   * Set streaming pipeline (for pause/resume control)
   */
  public setStreamingPipeline(pipeline: StreamingPipeline): void {
    this.streamingPipeline = pipeline;
    console.log('[UnifiedAPIServer] Streaming pipeline set');
  }

  /**
   * Start the HTTP server
   */
  public async start(): Promise<void> {
    try {
      await this.app.listen({
        port: this.config.port,
        host: this.config.host
      });
      console.log(`Unified API Server listening on http://${this.config.host}:${this.config.port}`);
      console.log(`  - FUSE API: http://${this.config.host}:${this.config.port}/api/fuse/*`);
      console.log(`  - Metrics API: http://${this.config.host}:${this.config.port}/api/metrics`);
      console.log(`  - Duplicates API: http://${this.config.host}:${this.config.port}/api/duplicates`);
      if (this.kvClient) {
        console.log(`  - Metadata API: http://${this.config.host}:${this.config.port}/api/metadata/* (GET/PUT/DELETE/POST)`);
        console.log(`  - KV Browser API: http://${this.config.host}:${this.config.port}/api/kv/* (GET)`);
      }
      if (this.unifiedStateManager) {
        console.log(`  - Unified Processing API (4 states): http://${this.config.host}:${this.config.port}/api/processing/status`);
      }
      console.log(`  - Scan API: http://${this.config.host}:${this.config.port}/api/scan/trigger (POST)`);
    } catch (error) {
      console.error('Error starting Unified API Server:', error);
      throw error;
    }
  }

  /**
   * Stop the HTTP server
   */
  public async stop(): Promise<void> {
    try {
      await this.app.close();
      console.log('Unified API Server stopped');
    } catch (error) {
      console.error('Error stopping Unified API Server:', error);
      throw error;
    }
  }

  /**
   * Get the Fastify instance (for testing or advanced usage)
   */
  public getApp(): FastifyInstance {
    return this.app;
  }

  /**
   * Helper method to get a nested property value from an object
   * Supports dot notation: "video.codec", "audio.0.language"
   */
  private getNestedProperty(obj: any, path: string): any {
    if (!obj || !path) return undefined;

    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[key];
    }

    return current;
  }
}
