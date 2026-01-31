/**
 * UnifiedProcessingStateManager
 *
 * Tracks files through the complete processing pipeline with 4 states:
 * 1. Discovered: Files discovered in filesystem (not yet processed)
 * 2. Light Processing: Quick metadata extraction + midhash256 computation (~20ms)
 * 3. Hash Processing: SHA-256 computation for compatibility (slow, background)
 * 4. Done: Fully processed files
 *
 * Key change from old system:
 * - midhash256 (fast) is computed in lightProcessing and becomes the permanent file ID
 * - SHA-256 (slow) is computed in hashProcessing as additional metadata
 * - Files become accessible in VFS immediately after lightProcessing completes
 */

import { performanceMetrics } from '../metrics/PerformanceMetrics.js';

export type FileState = 'discovered' | 'lightProcessing' | 'hashProcessing' | 'done';

export interface UnifiedFileState {
  filePath: string;
  state: FileState;
  hash?: string;  // midhash256 (set after lightProcessing)
  virtualPath?: string;
  error?: string;

  // Retry tracking
  retryCount?: number;
  lastRetryAt?: number;

  // Timestamps
  discoveredAt?: number;
  lightProcessingStartedAt?: number;
  lightProcessingCompletedAt?: number;
  hashProcessingStartedAt?: number;
  hashProcessingCompletedAt?: number;

  // Processing times
  lightProcessingTime?: number;
  hashProcessingTime?: number;
  totalProcessingTime?: number;
}

export interface UnifiedProcessingSnapshot {
  discovered: UnifiedFileState[];
  lightProcessing: UnifiedFileState[];
  hashProcessing: UnifiedFileState[];
  done: UnifiedFileState[];

  totalDiscovered: number;
  totalLightProcessing: number;
  totalHashProcessing: number;
  totalDone: number;
  totalFilesInVFS: number;         // Total number of files accessible in the Virtual File System

  /** Files that completed validation but are waiting for fast queue */
  awaitingFastQueue: number;
  /** Files that completed fast queue but are waiting for background queue */
  awaitingBackground: number;

  // Configuration
  fastQueueConcurrency?: number;       // Number of fast queue workers
  backgroundQueueConcurrency?: number; // Number of background queue workers
}

export class UnifiedProcessingStateManager {
  private discovered: Map<string, UnifiedFileState> = new Map();
  private lightProcessing: Map<string, UnifiedFileState> = new Map();
  private hashProcessing: Map<string, UnifiedFileState> = new Map();
  private done: UnifiedFileState[] = [];
  private maxDoneHistory = 100; // Keep last 100 completed files
  private totalProcessedCount = 0; // Track total number of completed files (not limited)

  /**
   * Add a file to discovered state (file discovered)
   */
  addDiscovered(filePath: string): void {
    this.discovered.set(filePath, {
      filePath,
      state: 'discovered',
      discoveredAt: Date.now()
    });
  }

  /**
   * Move file from discovered to light processing
   */
  startLightProcessing(filePath: string): void {
    const discoveredState = this.discovered.get(filePath);
    const existingState = this.lightProcessing.get(filePath);
    this.discovered.delete(filePath);

    this.lightProcessing.set(filePath, {
      filePath,
      state: 'lightProcessing',
      discoveredAt: discoveredState?.discoveredAt || existingState?.discoveredAt,
      lightProcessingStartedAt: Date.now(),
      retryCount: existingState?.retryCount || 0
    });
  }

  /**
   * Complete light processing and move to hash processing queue
   */
  completeLightProcessing(
    filePath: string,
    hash: string,  // midhash256
    virtualPath?: string,
    error?: string
  ): void {
    const lightState = this.lightProcessing.get(filePath);
    this.lightProcessing.delete(filePath);

    const now = Date.now();
    const lightProcessingTime = lightState?.lightProcessingStartedAt
      ? now - lightState.lightProcessingStartedAt
      : undefined;

    // Record light processing time metric
    if (lightProcessingTime !== undefined && !error) {
      performanceMetrics.recordMetadataProcessing(lightProcessingTime);
    }

    if (error) {
      // If error, mark as done with error
      this.completeHashProcessing(filePath, hash, virtualPath, error);
      return;
    }

    // Move to hash processing queue
    this.hashProcessing.set(filePath, {
      filePath,
      state: 'hashProcessing',
      hash,
      virtualPath,
      discoveredAt: lightState?.discoveredAt,
      lightProcessingStartedAt: lightState?.lightProcessingStartedAt,
      lightProcessingCompletedAt: now,
      lightProcessingTime,
      retryCount: lightState?.retryCount || 0
    });
  }

  /**
   * Start hash processing (SHA-256 computation)
   */
  startHashProcessing(filePath: string): void {
    const hashState = this.hashProcessing.get(filePath);
    if (hashState) {
      hashState.hashProcessingStartedAt = Date.now();
    }
  }

  /**
   * Complete hash processing and move to done
   */
  completeHashProcessing(
    filePath: string,
    hash?: string,
    virtualPath?: string,
    error?: string
  ): void {
    const hashState = this.hashProcessing.get(filePath);
    this.hashProcessing.delete(filePath);

    const now = Date.now();
    const hashProcessingTime = hashState?.hashProcessingStartedAt
      ? now - hashState.hashProcessingStartedAt
      : undefined;

    const totalProcessingTime = hashState?.discoveredAt
      ? now - hashState.discoveredAt
      : undefined;

    // Record hash processing time metric
    if (hashProcessingTime !== undefined && !error) {
      performanceMetrics.recordHashProcessing(hashProcessingTime);
    }

    const doneState: UnifiedFileState = {
      filePath,
      state: 'done',
      hash: hash || hashState?.hash,
      virtualPath: virtualPath || hashState?.virtualPath,
      error,
      discoveredAt: hashState?.discoveredAt,
      lightProcessingStartedAt: hashState?.lightProcessingStartedAt,
      lightProcessingCompletedAt: hashState?.lightProcessingCompletedAt,
      hashProcessingStartedAt: hashState?.hashProcessingStartedAt,
      hashProcessingCompletedAt: now,
      lightProcessingTime: hashState?.lightProcessingTime,
      hashProcessingTime,
      totalProcessingTime
    };

    // Add to done list (most recent first)
    this.done.unshift(doneState);

    // Increment total processed counter (tracks all files, not limited)
    this.totalProcessedCount++;

    // Trim history if needed
    if (this.done.length > this.maxDoneHistory) {
      this.done = this.done.slice(0, this.maxDoneHistory);
    }
  }

  /**
   * Remove a file from all states (e.g., when deleted)
   */
  removeFile(filePath: string): void {
    this.discovered.delete(filePath);
    this.lightProcessing.delete(filePath);
    this.hashProcessing.delete(filePath);
    this.done = this.done.filter(f => f.filePath !== filePath);
  }

  /**
   * Get a snapshot of the current processing state
   * @param vfsFileCount - Optional total number of files in the Virtual File System
   * @param fastQueueConcurrency - Number of fast queue workers
   * @param backgroundQueueConcurrency - Number of background queue workers
   */
  getSnapshot(vfsFileCount: number = 0, fastQueueConcurrency?: number, backgroundQueueConcurrency?: number): UnifiedProcessingSnapshot {
    // Limit returned arrays to prevent slow API responses with large queues
    const MAX_ITEMS_PER_STATE = 100;

    // Efficiently extract only the needed items without creating full arrays
    const getDiscoveredSample = (): UnifiedFileState[] => {
      const result: UnifiedFileState[] = [];
      let count = 0;
      for (const item of this.discovered.values()) {
        if (count >= MAX_ITEMS_PER_STATE) break;
        result.push(item);
        count++;
      }
      return result;
    };

    const getLightProcessingSample = (): UnifiedFileState[] => {
      const result: UnifiedFileState[] = [];
      let count = 0;
      for (const item of this.lightProcessing.values()) {
        if (count >= MAX_ITEMS_PER_STATE) break;
        result.push(item);
        count++;
      }
      return result;
    };

    const getHashProcessingSample = (): UnifiedFileState[] => {
      const result: UnifiedFileState[] = [];
      let count = 0;
      for (const item of this.hashProcessing.values()) {
        if (count >= MAX_ITEMS_PER_STATE) break;
        result.push(item);
        count++;
      }
      return result;
    };

    return {
      discovered: getDiscoveredSample(),
      lightProcessing: getLightProcessingSample(),
      hashProcessing: getHashProcessingSample(),
      done: this.done.slice(0, 50), // Return only last 50 for API

      totalDiscovered: this.discovered.size,
      totalLightProcessing: this.lightProcessing.size,
      totalHashProcessing: this.hashProcessing.size,
      totalDone: this.totalProcessedCount, // Total count of all processed files (not limited to history)
      totalFilesInVFS: vfsFileCount, // Total number of files accessible in the Virtual File System

      // Files that completed validation but are waiting for fast queue (set by API layer from queue status)
      awaitingFastQueue: 0,
      // Files that completed fast queue but are waiting for/in background queue
      awaitingBackground: this.hashProcessing.size,

      fastQueueConcurrency,
      backgroundQueueConcurrency
    };
  }

  /**
   * Get the state of a file in any processing queue
   */
  getFileState(filePath: string): UnifiedFileState | undefined {
    return this.discovered.get(filePath) ||
           this.lightProcessing.get(filePath) ||
           this.hashProcessing.get(filePath);
  }

  /**
   * Clear all states (useful for testing or reset)
   */
  clear(): void {
    this.discovered.clear();
    this.lightProcessing.clear();
    this.hashProcessing.clear();
    this.done = [];
    this.totalProcessedCount = 0;
  }

  /**
   * Get the total number of files in all states
   */
  getTotalFileCount(): number {
    return this.discovered.size + this.lightProcessing.size + this.hashProcessing.size + this.done.length;
  }

  /**
   * Retry processing for a file (move back to discovered with incremented retry count)
   */
  retryProcessing(filePath: string): boolean {
    const lightState = this.lightProcessing.get(filePath);
    const hashState = this.hashProcessing.get(filePath);
    const state = lightState || hashState;

    if (!state) {
      return false;
    }

    const retryCount = (state.retryCount || 0) + 1;

    this.lightProcessing.delete(filePath);
    this.hashProcessing.delete(filePath);

    this.discovered.set(filePath, {
      filePath,
      state: 'discovered',
      discoveredAt: state.discoveredAt,
      retryCount,
      lastRetryAt: Date.now()
    });

    return true;
  }

  /**
   * Get the retry count for a file
   */
  getRetryCount(filePath: string): number {
    const lightState = this.lightProcessing.get(filePath);
    const hashState = this.hashProcessing.get(filePath);
    const discoveredState = this.discovered.get(filePath);
    return lightState?.retryCount || hashState?.retryCount || discoveredState?.retryCount || 0;
  }

  /**
   * Get all files currently discovered (not yet processing)
   * Returns the internal Map for direct iteration
   */
  getDiscoveredFiles(): Map<string, UnifiedFileState> {
    return this.discovered;
  }

  /**
   * Get all files currently in light processing
   * Returns the internal Map for direct iteration
   */
  getLightProcessingFiles(): Map<string, UnifiedFileState> {
    return this.lightProcessing;
  }

  /**
   * Get all files currently in hash processing
   * Returns the internal Map for direct iteration
   */
  getHashProcessingFiles(): Map<string, UnifiedFileState> {
    return this.hashProcessing;
  }
}
