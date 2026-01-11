/**
 * ProcessingStateManager
 *
 * Tracks the state of file processing operations:
 * - Pending: Files queued for processing
 * - Processing: Files currently being processed
 * - Processed: Recently completed files
 */

export interface FileProcessingState {
  filePath: string;
  state: 'pending' | 'processing' | 'processed';
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  processingTime?: number;
  error?: string;
  virtualPath?: string;
}

export interface ProcessingStatusSnapshot {
  pending: FileProcessingState[];
  processing: FileProcessingState[];
  processed: FileProcessingState[];
  totalPending: number;
  totalProcessing: number;
  totalProcessed: number;
}

export class ProcessingStateManager {
  private pending: Map<string, FileProcessingState> = new Map();
  private processing: Map<string, FileProcessingState> = new Map();
  private processed: FileProcessingState[] = [];
  private maxProcessedHistory = 100; // Keep last 100 processed files

  /**
   * Add a file to the pending queue
   */
  addPending(filePath: string): void {
    this.pending.set(filePath, {
      filePath,
      state: 'pending',
      queuedAt: Date.now()
    });
  }

  /**
   * Move a file from pending to processing
   */
  startProcessing(filePath: string): void {
    const pendingState = this.pending.get(filePath);
    this.pending.delete(filePath);

    this.processing.set(filePath, {
      filePath,
      state: 'processing',
      queuedAt: pendingState?.queuedAt,
      startedAt: Date.now()
    });
  }

  /**
   * Move a file from processing to processed
   */
  completeProcessing(filePath: string, processingTime: number, error?: string, virtualPath?: string): void {
    const processingState = this.processing.get(filePath);
    this.processing.delete(filePath);

    const completedState: FileProcessingState = {
      filePath,
      state: 'processed',
      queuedAt: processingState?.queuedAt,
      startedAt: processingState?.startedAt,
      completedAt: Date.now(),
      processingTime,
      error,
      virtualPath
    };

    // Add to processed list (most recent first)
    this.processed.unshift(completedState);

    // Trim history if needed
    if (this.processed.length > this.maxProcessedHistory) {
      this.processed = this.processed.slice(0, this.maxProcessedHistory);
    }
  }

  /**
   * Remove a file from all states (e.g., when deleted)
   */
  removeFile(filePath: string): void {
    this.pending.delete(filePath);
    this.processing.delete(filePath);
    this.processed = this.processed.filter(f => f.filePath !== filePath);
  }

  /**
   * Get a snapshot of the current processing state
   */
  getSnapshot(): ProcessingStatusSnapshot {
    return {
      pending: Array.from(this.pending.values()),
      processing: Array.from(this.processing.values()),
      processed: this.processed.slice(0, 50), // Return only last 50 for API
      totalPending: this.pending.size,
      totalProcessing: this.processing.size,
      totalProcessed: this.processed.length
    };
  }

  /**
   * Clear all states (useful for testing or reset)
   */
  clear(): void {
    this.pending.clear();
    this.processing.clear();
    this.processed = [];
  }

  /**
   * Get the total number of files in all states
   */
  getTotalFileCount(): number {
    return this.pending.size + this.processing.size + this.processed.length;
  }
}
