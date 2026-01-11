/**
 * HashProcessingStateManager
 *
 * Tracks the state of background hash computation operations:
 * - Pending: Files queued for hash computation
 * - Computing: Files currently having hashes computed
 * - Complete: Recently completed hash computations
 */

export type HashStatus = 'pending' | 'computing' | 'complete' | 'error';

export interface HashProcessingState {
  filePath: string;
  tempId?: string;
  hashStatus: HashStatus;
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  processingTime?: number;
  hash?: string;
  error?: string;
  virtualPath?: string;
}

export interface HashProcessingStatusSnapshot {
  pending: HashProcessingState[];
  computing: HashProcessingState[];
  complete: HashProcessingState[];
  totalPending: number;
  totalComputing: number;
  totalComplete: number;
}

export class HashProcessingStateManager {
  private pending: Map<string, HashProcessingState> = new Map();
  private computing: Map<string, HashProcessingState> = new Map();
  private complete: HashProcessingState[] = [];
  private maxCompleteHistory = 100; // Keep last 100 completed hashes

  /**
   * Add a file to the pending hash queue
   */
  addPending(filePath: string, tempId?: string, virtualPath?: string): void {
    this.pending.set(filePath, {
      filePath,
      tempId,
      virtualPath,
      hashStatus: 'pending',
      queuedAt: Date.now()
    });
  }

  /**
   * Move a file from pending to computing
   */
  startComputing(filePath: string): void {
    const pendingState = this.pending.get(filePath);
    this.pending.delete(filePath);

    this.computing.set(filePath, {
      filePath,
      tempId: pendingState?.tempId,
      virtualPath: pendingState?.virtualPath,
      hashStatus: 'computing',
      queuedAt: pendingState?.queuedAt,
      startedAt: Date.now()
    });
  }

  /**
   * Move a file from computing to complete
   */
  completeComputing(
    filePath: string,
    processingTime: number,
    hash?: string,
    error?: string,
    virtualPath?: string
  ): void {
    const computingState = this.computing.get(filePath);
    this.computing.delete(filePath);

    const completedState: HashProcessingState = {
      filePath,
      tempId: computingState?.tempId,
      virtualPath: virtualPath || computingState?.virtualPath,
      hashStatus: error ? 'error' : 'complete',
      queuedAt: computingState?.queuedAt,
      startedAt: computingState?.startedAt,
      completedAt: Date.now(),
      processingTime,
      hash,
      error
    };

    // Add to complete list (most recent first)
    this.complete.unshift(completedState);

    // Trim history if needed
    if (this.complete.length > this.maxCompleteHistory) {
      this.complete = this.complete.slice(0, this.maxCompleteHistory);
    }
  }

  /**
   * Remove a file from all states (e.g., when deleted)
   */
  removeFile(filePath: string): void {
    this.pending.delete(filePath);
    this.computing.delete(filePath);
    this.complete = this.complete.filter(f => f.filePath !== filePath);
  }

  /**
   * Get a snapshot of the current hash processing state
   */
  getSnapshot(): HashProcessingStatusSnapshot {
    return {
      pending: Array.from(this.pending.values()),
      computing: Array.from(this.computing.values()),
      complete: this.complete.slice(0, 50), // Return only last 50 for API
      totalPending: this.pending.size,
      totalComputing: this.computing.size,
      totalComplete: this.complete.length
    };
  }

  /**
   * Clear all states (useful for testing or reset)
   */
  clear(): void {
    this.pending.clear();
    this.computing.clear();
    this.complete = [];
  }

  /**
   * Get the total number of files in all states
   */
  getTotalFileCount(): number {
    return this.pending.size + this.computing.size + this.complete.length;
  }
}
