/**
 * Unified HTTP API Server using Fastify
 *
 * Consolidates FUSE API, Metrics API, and Duplicates API into a single server.
 * This simplifies deployment and reduces the number of ports needed.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { execSync } from 'child_process';
import { VirtualFileSystem } from './VirtualFileSystem.js';
import { performanceMetrics } from '../metrics/PerformanceMetrics.js';
import { UnifiedProcessingStateManager } from '../logic/UnifiedProcessingStateManager.js';
import { DuplicateResult } from '../logic/DuplicateFinder.js';
import type { IKVClient } from '../kv/IKVClient.js';
import type { KVManager } from '../kv/KVManager.js';
import { config } from '../config/EnvConfig.js';
import type { PluginManager } from '../plugin-engine/PluginManager.js';
import type { TaskScheduler } from '../plugin-engine/TaskScheduler.js';
import type { ContainerManager, ContainerPluginScheduler, PluginCallbackPayload } from '../container-plugins/index.js';

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
   * Get total size of watch folders using du command (cached)
   */
  private getTotalWatchFolderSize(): number {
    // Check cache
    const now = Date.now();
    if (this.totalSizeCache && (now - this.totalSizeCache.timestamp) < UnifiedAPIServer.TOTAL_SIZE_CACHE_TTL_MS) {
      return this.totalSizeCache.value;
    }

    // Calculate total size using du -sb on each watch folder
    let totalSize = 0;
    const watchFolders = config.WATCH_FOLDER_LIST?.split(',').map(f => f.trim()).filter(f => f) || [];

    for (const folder of watchFolders) {
      try {
        // du -sb gives total bytes for directory
        const output = execSync(`du -sb "${folder}" 2>/dev/null || echo "0"`, {
          encoding: 'utf8',
          timeout: 10000 // 10s timeout per folder
        });
        const bytes = parseInt(output.split('\t')[0], 10);
        if (!isNaN(bytes)) {
          totalSize += bytes;
        }
      } catch (error) {
        // Skip folders that fail (permission issues, doesn't exist, etc.)
        console.warn(`Failed to get size for folder ${folder}:`, error);
      }
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

    // Metadata API routes (under /api/metadata) - Nested key architecture
    if (this.kvClient) {
      this.setupMetadataRoutes();
    }

    // KV Browser API routes (under /api/kv) - For editor UI
    if (this.kvClient) {
      this.setupKVBrowserRoutes();
    }

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

  /**
   * Setup Metadata API routes (nested key architecture)
   * Provides access to file metadata stored in KV using the nested key structure
   */
  private setupMetadataRoutes(): void {
    if (!this.kvClient) {
      return;
    }

    // Get all hash IDs (all files in KV)
    this.app.get('/api/metadata/hash-ids', async (request, reply) => {
      try {
        const hashIds = await this.kvClient!.getAllHashIds();
        return {
          hashIds,
          count: hashIds.length
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to retrieve hash IDs',
          details: error.message
        });
      }
    });

    // List all files with metadata (for Files view)
    this.app.get<{
      Querystring: { limit?: string; offset?: string }
    }>('/api/metadata/list', async (request, reply) => {
      const limit = parseInt(request.query.limit || '100', 10);
      const offset = parseInt(request.query.offset || '0', 10);

      try {
        const allHashIds = await this.kvClient!.getAllHashIds();
        const paginatedIds = allHashIds.slice(offset, offset + limit);

        const files = await Promise.all(
          paginatedIds.map(async (hashId) => {
            const metadata = await this.kvClient!.getMetadataFlat(hashId);
            if (!metadata) return null;

            // Extract fields for Files view
            return {
              hashId,
              filename: metadata.fileName || metadata.filename || 'Unknown',
              path: metadata.filePath || metadata.path || '',
              size: metadata.fileSize || metadata.size || 0,
              mimeType: metadata.mimeType,
              mediaType: metadata.videoType === 'tvshow' || metadata.videoType === 'movie' ? 'video' : metadata.mediaType,
              duration: metadata.fileinfo?.streamdetails?.video?.[0]?.durationinseconds || metadata.duration,
              resolution: metadata.fileinfo?.streamdetails?.video?.[0]?.width && metadata.fileinfo?.streamdetails?.video?.[0]?.height
                ? `${metadata.fileinfo.streamdetails.video[0].width}x${metadata.fileinfo.streamdetails.video[0].height}`
                : metadata.resolution,
              codec: metadata.fileinfo?.streamdetails?.video?.[0]?.codec || metadata.codec,
              createdAt: metadata.createdAt,
              processedAt: metadata.processedAt || metadata.mtime
            };
          })
        );

        return {
          files: files.filter(f => f !== null),
          total: allHashIds.length,
          limit,
          offset
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to list files',
          details: error.message
        });
      }
    });

    // Get complete metadata for a file by hash ID
    this.app.get<{ Params: { hashId: string } }>('/api/metadata/:hashId', async (request, reply) => {
      const { hashId } = request.params;

      if (!hashId) {
        return reply.status(400).send({
          error: 'Missing hash ID parameter'
        });
      }

      try {
        const metadata = await this.kvClient!.getMetadataFlat(hashId);

        if (!metadata) {
          return reply.status(404).send({
            error: 'Metadata not found for hash ID',
            hashId
          });
        }

        return metadata;
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to retrieve metadata',
          details: error.message
        });
      }
    });

    // Get a specific property for a file by hash ID and property path
    this.app.get<{
      Params: { hashId: string };
      Querystring: { property: string }
    }>('/api/metadata/:hashId/property', async (request, reply) => {
      const { hashId } = request.params;
      const { property } = request.query;

      if (!hashId || !property) {
        return reply.status(400).send({
          error: 'Missing hash ID or property parameter'
        });
      }

      try {
        const key = `/file/${hashId}/${property}`;
        const value = await this.kvClient!.getProperty(key);

        if (value === null) {
          return reply.status(404).send({
            error: 'Property not found',
            hashId,
            property
          });
        }

        return {
          hashId,
          property,
          value
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to retrieve property',
          details: error.message
        });
      }
    });

    // Get all properties matching a specific property path across all files
    // Example: /api/metadata/query?property=video/codec to get all video codecs
    this.app.get<{
      Querystring: { property: string }
    }>('/api/metadata/query', async (request, reply) => {
      const { property } = request.query;

      if (!property) {
        return reply.status(400).send({
          error: 'Missing property parameter'
        });
      }

      try {
        // Get all hash IDs
        const hashIds = await this.kvClient!.getAllHashIds();

        // Query each file for the specified property
        const results: Array<{ hashId: string; value: string }> = [];

        for (const hashId of hashIds) {
          const key = `/file/${hashId}/${property}`;
          const value = await this.kvClient!.getProperty(key);

          if (value !== null) {
            results.push({ hashId, value });
          }
        }

        return {
          property,
          count: results.length,
          results
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to query property',
          details: error.message
        });
      }
    });

    // Update complete metadata for a file by hash ID
    this.app.put<{
      Params: { hashId: string };
      Body: any
    }>('/api/metadata/:hashId', async (request, reply) => {
      const { hashId } = request.params;
      const metadata = request.body;

      if (!hashId) {
        return reply.status(400).send({
          error: 'Missing hash ID parameter'
        });
      }

      if (!metadata || typeof metadata !== 'object') {
        return reply.status(400).send({
          error: 'Invalid metadata: must be an object'
        });
      }

      try {
        // Store the updated metadata (excludes internal processing status)
        await this.kvClient!.setMetadataFlat(hashId, metadata, ['processingStatus']);

        return {
          status: 'ok',
          hashId,
          message: 'Metadata updated successfully'
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to update metadata',
          details: error.message
        });
      }
    });

    // Update a specific property for a file by hash ID
    this.app.put<{
      Params: { hashId: string };
      Body: { property: string; value: string }
    }>('/api/metadata/:hashId/property', async (request, reply) => {
      const { hashId } = request.params;
      const { property, value } = request.body;

      if (!hashId || !property) {
        return reply.status(400).send({
          error: 'Missing hash ID or property parameter'
        });
      }

      if (value === undefined || value === null) {
        return reply.status(400).send({
          error: 'Missing value parameter'
        });
      }

      try {
        const key = `/file/${hashId}/${property}`;
        await this.kvClient!.setProperty(key, String(value));

        return {
          status: 'ok',
          hashId,
          property,
          value,
          message: 'Property updated successfully'
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to update property',
          details: error.message
        });
      }
    });

    // Search for files by various criteria
    this.app.post<{
      Body: {
        query?: string;        // Search in title, filename, originaltitle
        hashId?: string;       // Exact hash ID match
        property?: string;     // Search by specific property
        propertyValue?: string; // Value to match for property search
        limit?: number;
      }
    }>('/api/metadata/search', async (request, reply) => {
      const { query, hashId, property, propertyValue, limit = 100 } = request.body;

      try {
        // If hashId is provided, do exact match
        if (hashId) {
          const metadata = await this.kvClient!.getMetadataFlat(hashId);
          if (metadata) {
            return {
              results: [{ hashId, metadata }],
              count: 1
            };
          }
          return { results: [], count: 0 };
        }

        // Get all hash IDs
        const hashIds = await this.kvClient!.getAllHashIds();
        const results: Array<{ hashId: string; metadata: any }> = [];

        // Search through files
        for (const id of hashIds) {
          if (results.length >= limit) break;

          const metadata = await this.kvClient!.getMetadataFlat(id);
          if (!metadata) continue;

          let matches = false;

          // Property search
          if (property && propertyValue !== undefined) {
            const value = this.getNestedProperty(metadata, property);
            if (value && String(value).toLowerCase().includes(String(propertyValue).toLowerCase())) {
              matches = true;
            }
          }

          // General query search (searches title, filename, originaltitle, filepath, and hashId)
          if (query && !property) {
            const searchFields = ['title', 'fileName', 'originaltitle', 'showtitle', 'filePath'];
            const queryLower = query.toLowerCase();

            // Check if query matches hashId
            if (id.toLowerCase().includes(queryLower)) {
              matches = true;
            }

            // Check other fields
            if (!matches) {
              for (const field of searchFields) {
                const value = this.getNestedProperty(metadata, field);
                if (value && String(value).toLowerCase().includes(queryLower)) {
                  matches = true;
                  break;
                }
              }
            }
          }

          if (matches || (!query && !property)) {
            results.push({ hashId: id, metadata });
          }
        }

        return {
          results,
          count: results.length,
          total: hashIds.length
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to search metadata',
          details: error.message
        });
      }
    });

    // Batch update multiple files
    this.app.post<{
      Body: {
        updates: Array<{
          hashId: string;
          metadata?: any;        // Complete metadata update
          properties?: Record<string, string>; // Property updates
        }>
      }
    }>('/api/metadata/batch', async (request, reply) => {
      const { updates } = request.body;

      if (!updates || !Array.isArray(updates)) {
        return reply.status(400).send({
          error: 'Invalid updates: must be an array'
        });
      }

      try {
        const results: Array<{ hashId: string; status: string; error?: string }> = [];

        for (const update of updates) {
          const { hashId, metadata, properties } = update;

          if (!hashId) {
            results.push({
              hashId: 'unknown',
              status: 'error',
              error: 'Missing hash ID'
            });
            continue;
          }

          try {
            // Update complete metadata
            if (metadata) {
              await this.kvClient!.setMetadataFlat(hashId, metadata, ['processingStatus']);
            }

            // Update individual properties
            if (properties) {
              for (const [property, value] of Object.entries(properties)) {
                const key = `/file/${hashId}/${property}`;
                await this.kvClient!.setProperty(key, String(value));
              }
            }

            results.push({
              hashId,
              status: 'ok'
            });
          } catch (error: any) {
            results.push({
              hashId,
              status: 'error',
              error: error.message
            });
          }
        }

        const successCount = results.filter(r => r.status === 'ok').length;
        const errorCount = results.filter(r => r.status === 'error').length;

        return {
          status: 'completed',
          total: results.length,
          success: successCount,
          errors: errorCount,
          results
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to batch update metadata',
          details: error.message
        });
      }
    });

    // Delete metadata for a file by hash ID
    this.app.delete<{ Params: { hashId: string } }>('/api/metadata/:hashId', async (request, reply) => {
      const { hashId } = request.params;

      if (!hashId) {
        return reply.status(400).send({
          error: 'Missing hash ID parameter'
        });
      }

      try {
        const deletedCount = await this.kvClient!.deleteMetadataFlat(hashId);

        return {
          status: 'ok',
          hashId,
          deletedKeys: deletedCount
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to delete metadata',
          details: error.message
        });
      }
    });
  }

  /**
   * Setup KV Browser API routes (for editor UI)
   * Provides raw access to browse Redis keys and values
   */
  private setupKVBrowserRoutes(): void {
    if (!this.kvClient) {
      return;
    }

    // Get KV database info
    this.app.get('/api/kv/info', async (request, reply) => {
      try {
        const hashIds = await this.kvClient!.getAllHashIds();
        const redis = (this.kvClient as any).getRedisClient?.();

        let memoryUsage = 'N/A';
        if (redis) {
          try {
            const info = await redis.info('memory');
            const match = info.match(/used_memory_human:(\S+)/);
            if (match) {
              memoryUsage = match[1];
            }
          } catch {
            // Ignore memory info errors
          }
        }

        // Get total size of watch folders (cached, uses du command)
        const totalSize = this.getTotalWatchFolderSize();

        return {
          prefix: 'file:',
          fileCount: hashIds.length,
          keyCount: hashIds.length,
          totalSize,
          memoryUsage
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to get KV info',
          details: error.message
        });
      }
    });

    // List keys with cursor pagination
    this.app.get<{
      Querystring: { cursor?: string; count?: string }
    }>('/api/kv/keys', async (request, reply) => {
      const cursor = request.query.cursor || '0';
      const count = parseInt(request.query.count || '50', 10);

      try {
        const allHashIds = await this.kvClient!.getAllHashIds();

        // Simple offset-based pagination using cursor as offset
        const offset = parseInt(cursor, 10) || 0;
        const keys = allHashIds.slice(offset, offset + count).map(id => `file:${id}`);
        const nextOffset = offset + keys.length;
        const hasMore = nextOffset < allHashIds.length;

        return {
          keys,
          cursor: hasMore ? String(nextOffset) : '0',
          hasMore
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to list keys',
          details: error.message
        });
      }
    });

    // Get value for a specific key
    this.app.get<{
      Params: { key: string }
    }>('/api/kv/key/:key', async (request, reply) => {
      const { key } = request.params;

      if (!key) {
        return reply.status(400).send({
          error: 'Missing key parameter'
        });
      }

      try {
        // Extract hash ID from key (format: file:{hashId})
        const hashIdMatch = key.match(/^file:(.+)$/);
        if (!hashIdMatch) {
          return reply.status(400).send({
            error: 'Invalid key format. Expected: file:{hashId}'
          });
        }

        const hashId = hashIdMatch[1];
        const metadata = await this.kvClient!.getMetadataFlat(hashId);

        if (!metadata) {
          return reply.status(404).send({
            error: 'Key not found',
            key
          });
        }

        return {
          key,
          type: 'hash',
          value: metadata
        };
      } catch (error: any) {
        return reply.status(500).send({
          error: 'Failed to get key value',
          details: error.message
        });
      }
    });
  }

  /**
   * Setup Unified Processing State API routes (4-state pipeline)
   */
  private setupUnifiedProcessingRoutes(): void {
    if (!this.unifiedStateManager) {
      return;
    }

    // Get active processing queue (files currently being processed)
    this.app.get('/api/processing/queue', async (request, reply) => {
      const items: Array<{ path: string; phase: 'light' | 'hash'; startTime?: number }> = [];

      // Get files in light processing
      const lightProcessing = this.unifiedStateManager!.getLightProcessingFiles();
      for (const [filePath, info] of lightProcessing) {
        items.push({
          path: filePath,
          phase: 'light',
          startTime: info.lightProcessingStartedAt
        });
      }

      // Get files in hash processing
      const hashProcessing = this.unifiedStateManager!.getHashProcessingFiles();
      for (const [filePath, info] of hashProcessing) {
        items.push({
          path: filePath,
          phase: 'hash',
          startTime: info.hashProcessingStartedAt
        });
      }

      return { items };
    });

    // Get unified processing status snapshot (4 tabs: pending, lightProcessing, hashProcessing, done)
    this.app.get('/api/processing/status', async (request, reply) => {
      // Get ALL file paths currently in VFS (most accurate count)
      const allVfsFiles = this.vfs.getAllFiles();

      // Count only actual media files (not virtual metadata files like .meta, .nfo)
      const mediaFiles = allVfsFiles.filter(f => {
        return !f.endsWith('.meta') && !f.endsWith('.nfo') && !f.endsWith('.xml');
      });
      const actualMediaFileCount = mediaFiles.length;

      // Count files with completed hash computation
      const filesWithHash = this.vfs.countFilesWithHash();

      // Get snapshot with actual VFS counts
      const snapshot = this.unifiedStateManager!.getSnapshot(actualMediaFileCount, this.fastQueueConcurrency, this.backgroundQueueConcurrency);

      // Override totalDone with actual count of files with hashes in VFS
      // (not just current session, but ALL files in VFS with completed hash)
      snapshot.totalDone = filesWithHash;

      // Add queue status if available
      if (this.getQueueStatus) {
        const queueStatus = this.getQueueStatus();
        (snapshot as any).queueStatus = queueStatus;

        // Add calculated fields that the UI needs (make API self-describing)
        // Pipeline: validation (preProcess) → lightProcessing (fast) → hashProcessing (background)
        const preProcessRunning = queueStatus.preProcessQueue?.pending || 0;
        const preProcessPending = queueStatus.preProcessQueue?.size || 0;
        const fastQueueRunning = queueStatus.fastQueue?.running || 0;
        const fastQueuePending = queueStatus.fastQueue?.pending || 0;
        const backgroundQueueRunning = queueStatus.backgroundQueue?.running || 0;
        const backgroundQueuePending = queueStatus.backgroundQueue?.pending || 0;

        (snapshot as any).computed = {
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

          // Legacy compatibility fields (UI may still reference these)
          actualRunningHashWorkers: backgroundQueueRunning,
          actualRunningLightWorkers: preProcessRunning + fastQueueRunning,
          trueHashQueueSize: backgroundQueuePending,
          hashQueuePaused: queueStatus.backgroundQueue?.isPaused || false,
          lightQueuePaused: queueStatus.preProcessQueue?.isPaused || false
        };
      }

      return snapshot;
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
        const redis = (this.kvClient as any).getRedisClient?.();

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

        // Get total size of watch folders (cached, uses du command)
        const totalSize = this.getTotalWatchFolderSize();

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
        capabilities: string[];
        version: string;
      }> = [];

      try {
        const serviceDiscovery = this.kvManager!.getServiceDiscovery();
        if (serviceDiscovery) {
          const allServices = await serviceDiscovery.discoverAllServices();

          for (const svc of allServices) {
            // Build dashboard URL from API URL
            const apiUrl = svc.api || '';
            const dashboardPath = svc.endpoints?.dashboard || '/';

            services.push({
              name: svc.name || 'Unknown',
              url: apiUrl + dashboardPath,
              api: apiUrl,
              status: svc.status || 'unknown',
              capabilities: svc.capabilities || [],
              version: svc.version || '',
            });
          }
        }
      } catch (error: any) {
        console.error('[Services API] Error discovering services:', error);
      }

      // Get leader info
      const leaderInfo = this.kvManager!.getLeaderInfo();
      const isLeader = this.kvManager!.isLeader();

      return {
        services,
        current: 'meta-sort',
        leader: leaderInfo ? {
          host: leaderInfo.host,
          api: leaderInfo.api,
          http: leaderInfo.http,
        } : null,
        isLeader,
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

    // Clear plugin cache
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
