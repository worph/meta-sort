/**
 * Performance metrics tracker for meta-mesh
 * Tracks detailed performance statistics and timing information
 */

export interface MetricEntry {
  timestamp: number;
  value: number;
  label?: string;
}

export interface FailedFileEntry {
  filePath: string;
  reason: string;
  timestamp: number;
  retryCount: number;
  stage: 'metadata' | 'hash' | 'processing';
}

export interface HashTimingStats {
  total: number;
  count: number;
  average: number;
  min: number;
  max: number;
}

export interface PluginTimingStats {
  total: number;
  count: number;
  average: number;
  min: number;
  max: number;
}

export interface PerformanceMetricsData {
  // File processing metrics
  totalFilesProcessed: number;
  averageFileProcessingTime: number;
  minFileProcessingTime: number;
  maxFileProcessingTime: number;
  recentFileProcessingTimes: MetricEntry[];

  // Metadata (light processing) metrics
  totalMetadataProcessed: number;
  averageMetadataProcessingTime: number;
  minMetadataProcessingTime: number;
  maxMetadataProcessingTime: number;

  // Hash processing metrics
  totalHashProcessed: number;
  averageHashProcessingTime: number;
  minHashProcessingTime: number;
  maxHashProcessingTime: number;

  // Per-hash-algorithm timing metrics (excludes cache hits)
  hashComputationTimes: Record<string, HashTimingStats>;

  // Per-plugin timing metrics
  pluginProcessingTimes: Record<string, PluginTimingStats>;

  // VFS update metrics
  totalVFSUpdates: number;
  averageVFSUpdateTime: number;
  lastVFSUpdateTime: number;
  recentVFSUpdateTimes: MetricEntry[];

  // Duplicate detection metrics
  averageDuplicateDetectionTime: number;
  lastDuplicateDetectionTime: number;
  totalDuplicatesFound: number;

  // Virtual structure generation metrics
  averageVirtualStructureTime: number;
  lastVirtualStructureTime: number;

  // Failed files tracking
  failedFiles: FailedFileEntry[];
  totalFailedFiles: number;
  totalMetadataFailures: number;
  totalHashFailures: number;

  // System metrics
  uptime: number;
  startTime: number;
  lastActivityTime: number;

  // Memory and performance
  memoryUsage?: NodeJS.MemoryUsage;

  // Processing rate
  filesPerSecond: number;
  totalProcessingTime: number;

  // Cache metrics
  cacheHits: Record<string, number>;
  cacheMisses: Record<string, number>;
  cacheHitRate: Record<string, number>;
}

export class PerformanceMetrics {
  private startTime: number;
  private lastActivityTime: number;

  // File processing tracking - running statistics
  private recentFileProcessing: MetricEntry[] = [];
  private totalFilesProcessed: number = 0;
  private fileProcessingSum: number = 0;
  private fileProcessingMin: number = Infinity;
  private fileProcessingMax: number = 0;

  // Metadata (light processing) tracking - running statistics
  private totalMetadataProcessed: number = 0;
  private metadataProcessingSum: number = 0;
  private metadataProcessingMin: number = Infinity;
  private metadataProcessingMax: number = 0;

  // Hash processing tracking - running statistics
  private totalHashProcessed: number = 0;
  private hashProcessingSum: number = 0;
  private hashProcessingMin: number = Infinity;
  private hashProcessingMax: number = 0;

  // VFS update tracking - running statistics
  private recentVFSUpdates: MetricEntry[] = [];
  private totalVFSUpdates: number = 0;
  private vfsUpdateSum: number = 0;
  private lastVFSUpdateTime: number = 0;

  // Duplicate detection tracking - running statistics
  private totalDuplicatesFound: number = 0;
  private duplicateDetectionSum: number = 0;
  private duplicateDetectionCount: number = 0;
  private lastDuplicateDetectionTime: number = 0;

  // Virtual structure generation tracking - running statistics
  private virtualStructureSum: number = 0;
  private virtualStructureCount: number = 0;
  private lastVirtualStructureTime: number = 0;

  // Failed files tracking
  private failedFiles: FailedFileEntry[] = [];
  private totalMetadataFailures: number = 0;
  private totalHashFailures: number = 0;

  // Cache metrics tracking
  private cacheHits: Record<string, number> = {};
  private cacheMisses: Record<string, number> = {};

  // Per-hash-algorithm timing tracking (excludes cache hits)
  private hashTimings: Record<string, {
    sum: number;
    count: number;
    min: number;
    max: number;
  }> = {};

  // Per-plugin timing tracking
  private pluginTimings: Record<string, {
    sum: number;
    count: number;
    min: number;
    max: number;
  }> = {};

  // Configuration
  private maxRecentEntries: number = 100;
  private maxFailedFilesHistory: number = 50;

  constructor() {
    this.startTime = Date.now();
    this.lastActivityTime = this.startTime;
  }

  /**
   * Record a file processing event
   */
  recordFileProcessing(filePath: string, timeMs: number): void {
    // Update running statistics
    this.fileProcessingSum += timeMs;
    this.fileProcessingMin = Math.min(this.fileProcessingMin, timeMs);
    this.fileProcessingMax = Math.max(this.fileProcessingMax, timeMs);
    this.totalFilesProcessed++;

    // Keep recent list for display only
    this.recentFileProcessing.push({
      timestamp: Date.now(),
      value: timeMs,
      label: filePath
    });

    if (this.recentFileProcessing.length > this.maxRecentEntries) {
      this.recentFileProcessing.shift();
    }

    this.lastActivityTime = Date.now();
  }

  /**
   * Record a metadata (light processing) event
   */
  recordMetadataProcessing(timeMs: number): void {
    // Update running statistics
    this.metadataProcessingSum += timeMs;
    this.metadataProcessingMin = Math.min(this.metadataProcessingMin, timeMs);
    this.metadataProcessingMax = Math.max(this.metadataProcessingMax, timeMs);
    this.totalMetadataProcessed++;

    this.lastActivityTime = Date.now();
  }

  /**
   * Record a hash processing event
   */
  recordHashProcessing(timeMs: number): void {
    // Update running statistics
    this.hashProcessingSum += timeMs;
    this.hashProcessingMin = Math.min(this.hashProcessingMin, timeMs);
    this.hashProcessingMax = Math.max(this.hashProcessingMax, timeMs);
    this.totalHashProcessed++;

    this.lastActivityTime = Date.now();
  }

  /**
   * Record a VFS update event
   */
  recordVFSUpdate(timeMs: number): void {
    // Update running statistics
    this.vfsUpdateSum += timeMs;
    this.lastVFSUpdateTime = timeMs;
    this.totalVFSUpdates++;

    // Keep recent list for display only
    this.recentVFSUpdates.push({
      timestamp: Date.now(),
      value: timeMs
    });

    if (this.recentVFSUpdates.length > this.maxRecentEntries) {
      this.recentVFSUpdates.shift();
    }

    this.lastActivityTime = Date.now();
  }

  /**
   * Record a duplicate detection event
   */
  recordDuplicateDetection(timeMs: number, duplicatesFound: number): void {
    // Update running statistics
    this.duplicateDetectionSum += timeMs;
    this.duplicateDetectionCount++;
    this.lastDuplicateDetectionTime = timeMs;
    this.totalDuplicatesFound += duplicatesFound;

    this.lastActivityTime = Date.now();
  }

  /**
   * Record a virtual structure generation event
   */
  recordVirtualStructureGeneration(timeMs: number): void {
    // Update running statistics
    this.virtualStructureSum += timeMs;
    this.virtualStructureCount++;
    this.lastVirtualStructureTime = timeMs;

    this.lastActivityTime = Date.now();
  }

  /**
   * Record a cache hit event
   */
  recordCacheHit(cacheType: string): void {
    if (!this.cacheHits[cacheType]) {
      this.cacheHits[cacheType] = 0;
    }
    this.cacheHits[cacheType]++;
    this.lastActivityTime = Date.now();
  }

  /**
   * Record a cache miss event
   */
  recordCacheMiss(cacheType: string): void {
    if (!this.cacheMisses[cacheType]) {
      this.cacheMisses[cacheType] = 0;
    }
    this.cacheMisses[cacheType]++;
    this.lastActivityTime = Date.now();
  }

  /**
   * Record hash computation time for a specific algorithm (excludes cache hits)
   * @param hashAlgorithm - Hash algorithm name (e.g., 'cid_sha2-256', 'cid_midhash256')
   * @param timeMs - Time taken to compute the hash in milliseconds
   */
  recordHashComputation(hashAlgorithm: string, timeMs: number): void {
    if (!this.hashTimings[hashAlgorithm]) {
      this.hashTimings[hashAlgorithm] = {
        sum: 0,
        count: 0,
        min: Infinity,
        max: 0
      };
    }

    const stats = this.hashTimings[hashAlgorithm];
    stats.sum += timeMs;
    stats.count++;
    stats.min = Math.min(stats.min, timeMs);
    stats.max = Math.max(stats.max, timeMs);

    this.lastActivityTime = Date.now();
  }

  /**
   * Record plugin processing time
   * @param pluginName - Name of the plugin
   * @param timeMs - Time taken by the plugin in milliseconds
   */
  recordPluginProcessing(pluginName: string, timeMs: number): void {
    if (!this.pluginTimings[pluginName]) {
      this.pluginTimings[pluginName] = {
        sum: 0,
        count: 0,
        min: Infinity,
        max: 0
      };
    }

    const stats = this.pluginTimings[pluginName];
    stats.sum += timeMs;
    stats.count++;
    stats.min = Math.min(stats.min, timeMs);
    stats.max = Math.max(stats.max, timeMs);

    this.lastActivityTime = Date.now();
  }

  /**
   * Record a failed file processing event
   */
  recordFailedFile(filePath: string, reason: string, retryCount: number, stage: 'metadata' | 'hash' | 'processing'): void {
    const failedEntry: FailedFileEntry = {
      filePath,
      reason,
      timestamp: Date.now(),
      retryCount,
      stage
    };

    // Add to failed files list (most recent first)
    this.failedFiles.unshift(failedEntry);

    // Trim history if needed
    if (this.failedFiles.length > this.maxFailedFilesHistory) {
      this.failedFiles = this.failedFiles.slice(0, this.maxFailedFilesHistory);
    }

    // Update failure counters
    if (stage === 'metadata') {
      this.totalMetadataFailures++;
    } else {
      this.totalHashFailures++;
    }

    this.lastActivityTime = Date.now();
  }

  /**
   * Get all metrics data - O(1) complexity using cached running statistics
   */
  getMetrics(): PerformanceMetricsData & {
    // UI compatibility aliases
    totalFilesDiscovered: number;
    totalFilesFailed: number;
    averageLightProcessingMs: number;
    averageHashProcessingMs: number;
  } {
    const now = Date.now();
    const uptime = now - this.startTime;
    const totalFailedFiles = this.totalMetadataFailures + this.totalHashFailures;
    const avgMetadata = this.totalMetadataProcessed > 0
      ? this.metadataProcessingSum / this.totalMetadataProcessed
      : 0;
    const avgHash = this.totalHashProcessed > 0
      ? this.hashProcessingSum / this.totalHashProcessed
      : 0;

    return {
      // File processing metrics - O(1) from running statistics
      totalFilesProcessed: this.totalFilesProcessed,

      // UI compatibility aliases
      totalFilesDiscovered: this.totalFilesProcessed + totalFailedFiles,
      totalFilesFailed: totalFailedFiles,
      averageLightProcessingMs: avgMetadata,
      averageHashProcessingMs: avgHash,
      averageFileProcessingTime: this.totalFilesProcessed > 0
        ? this.fileProcessingSum / this.totalFilesProcessed
        : 0,
      minFileProcessingTime: this.fileProcessingMin === Infinity ? 0 : this.fileProcessingMin,
      maxFileProcessingTime: this.fileProcessingMax,
      recentFileProcessingTimes: this.recentFileProcessing.slice(-20), // Last 20 files

      // Metadata (light processing) metrics - O(1) from running statistics
      totalMetadataProcessed: this.totalMetadataProcessed,
      averageMetadataProcessingTime: this.totalMetadataProcessed > 0
        ? this.metadataProcessingSum / this.totalMetadataProcessed
        : 0,
      minMetadataProcessingTime: this.metadataProcessingMin === Infinity ? 0 : this.metadataProcessingMin,
      maxMetadataProcessingTime: this.metadataProcessingMax,

      // Hash processing metrics - O(1) from running statistics
      totalHashProcessed: this.totalHashProcessed,
      averageHashProcessingTime: this.totalHashProcessed > 0
        ? this.hashProcessingSum / this.totalHashProcessed
        : 0,
      minHashProcessingTime: this.hashProcessingMin === Infinity ? 0 : this.hashProcessingMin,
      maxHashProcessingTime: this.hashProcessingMax,

      // Per-hash-algorithm timing metrics (excludes cache hits)
      hashComputationTimes: Object.keys(this.hashTimings).reduce((acc, hashAlgorithm) => {
        const stats = this.hashTimings[hashAlgorithm];
        acc[hashAlgorithm] = {
          total: stats.sum,
          count: stats.count,
          average: stats.count > 0 ? stats.sum / stats.count : 0,
          min: stats.min === Infinity ? 0 : stats.min,
          max: stats.max
        };
        return acc;
      }, {} as Record<string, HashTimingStats>),

      // Per-plugin timing metrics
      pluginProcessingTimes: Object.keys(this.pluginTimings).reduce((acc, pluginName) => {
        const stats = this.pluginTimings[pluginName];
        acc[pluginName] = {
          total: stats.sum,
          count: stats.count,
          average: stats.count > 0 ? stats.sum / stats.count : 0,
          min: stats.min === Infinity ? 0 : stats.min,
          max: stats.max
        };
        return acc;
      }, {} as Record<string, PluginTimingStats>),

      // VFS update metrics - O(1) from running statistics
      totalVFSUpdates: this.totalVFSUpdates,
      averageVFSUpdateTime: this.totalVFSUpdates > 0
        ? this.vfsUpdateSum / this.totalVFSUpdates
        : 0,
      lastVFSUpdateTime: this.lastVFSUpdateTime,
      recentVFSUpdateTimes: this.recentVFSUpdates.slice(-10), // Last 10 updates

      // Duplicate detection metrics - O(1) from running statistics
      averageDuplicateDetectionTime: this.duplicateDetectionCount > 0
        ? this.duplicateDetectionSum / this.duplicateDetectionCount
        : 0,
      lastDuplicateDetectionTime: this.lastDuplicateDetectionTime,
      totalDuplicatesFound: this.totalDuplicatesFound,

      // Virtual structure generation metrics - O(1) from running statistics
      averageVirtualStructureTime: this.virtualStructureCount > 0
        ? this.virtualStructureSum / this.virtualStructureCount
        : 0,
      lastVirtualStructureTime: this.lastVirtualStructureTime,

      // Failed files tracking
      failedFiles: this.failedFiles,
      totalFailedFiles: this.totalMetadataFailures + this.totalHashFailures,
      totalMetadataFailures: this.totalMetadataFailures,
      totalHashFailures: this.totalHashFailures,

      // System metrics
      uptime: uptime,
      startTime: this.startTime,
      lastActivityTime: this.lastActivityTime,

      // Memory usage
      memoryUsage: process.memoryUsage(),

      // Processing rate
      filesPerSecond: uptime > 0 ? (this.totalFilesProcessed / (uptime / 1000)) : 0,
      totalProcessingTime: this.fileProcessingSum,

      // Cache metrics
      cacheHits: { ...this.cacheHits },
      cacheMisses: { ...this.cacheMisses },
      cacheHitRate: Object.keys(this.cacheHits).reduce((acc, key) => {
        const hits = this.cacheHits[key] || 0;
        const misses = this.cacheMisses[key] || 0;
        const total = hits + misses;
        acc[key] = total > 0 ? (hits / total) * 100 : 0;
        return acc;
      }, {} as Record<string, number>)
    };
  }

  /**
   * Get timing stats for a specific plugin
   * @param pluginId - Plugin identifier
   * @returns Plugin timing stats or null if no data
   */
  getPluginTiming(pluginId: string): PluginTimingStats | null {
    const stats = this.pluginTimings[pluginId];
    if (!stats || stats.count === 0) {
      return null;
    }
    return {
      total: stats.sum,
      count: stats.count,
      average: stats.sum / stats.count,
      min: stats.min === Infinity ? 0 : stats.min,
      max: stats.max
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    // Reset file processing metrics
    this.recentFileProcessing = [];
    this.totalFilesProcessed = 0;
    this.fileProcessingSum = 0;
    this.fileProcessingMin = Infinity;
    this.fileProcessingMax = 0;

    // Reset metadata processing metrics
    this.totalMetadataProcessed = 0;
    this.metadataProcessingSum = 0;
    this.metadataProcessingMin = Infinity;
    this.metadataProcessingMax = 0;

    // Reset hash processing metrics
    this.totalHashProcessed = 0;
    this.hashProcessingSum = 0;
    this.hashProcessingMin = Infinity;
    this.hashProcessingMax = 0;

    // Reset VFS update metrics
    this.recentVFSUpdates = [];
    this.totalVFSUpdates = 0;
    this.vfsUpdateSum = 0;
    this.lastVFSUpdateTime = 0;

    // Reset duplicate detection metrics
    this.totalDuplicatesFound = 0;
    this.duplicateDetectionSum = 0;
    this.duplicateDetectionCount = 0;
    this.lastDuplicateDetectionTime = 0;

    // Reset virtual structure generation metrics
    this.virtualStructureSum = 0;
    this.virtualStructureCount = 0;
    this.lastVirtualStructureTime = 0;

    // Reset failed files tracking
    this.failedFiles = [];
    this.totalMetadataFailures = 0;
    this.totalHashFailures = 0;

    // Reset cache metrics
    this.cacheHits = {};
    this.cacheMisses = {};

    // Reset hash computation timing
    this.hashTimings = {};

    // Reset plugin processing timing
    this.pluginTimings = {};

    this.startTime = Date.now();
    this.lastActivityTime = this.startTime;
  }
}

// Global singleton instance
export const performanceMetrics = new PerformanceMetrics();
