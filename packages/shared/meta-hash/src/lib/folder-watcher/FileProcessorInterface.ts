/**
 * Interface for file processing implementations used by FolderWatcher.
 *
 * Provides hooks for different stages of the file processing pipeline:
 * 1. markPending() - File discovered, waiting in queue
 * 2. queueFile() - File starts processing (optional pre-processing phase)
 * 3. processFile() - Main processing phase
 * 4. finalize() - After all files processed (optional)
 */
export interface FileProcessorInterface {
    /** Optional initialization before processing starts */
    initialize?(): Promise<void>;

    /**
     * Main file processing method.
     * @param current - Current file index in the queue
     * @param queueSize - Total number of files to process
     * @param nfoFilePath - Path to the file being processed
     */
    processFile(current: number, queueSize: number, nfoFilePath: string): Promise<void>;

    /**
     * Determines if a file should be processed.
     * @param filePath - Path to the file to check
     * @returns true if the file should be processed
     */
    canProcessFile(filePath: string): Promise<boolean>;

    /** Optional callback when a file is deleted */
    deleteFile?(filePath: string): Promise<void>;

    /** Optional callback after all files have been processed */
    finalize?(): Promise<void>;

    /**
     * Optional callback when a file is discovered and marked as pending.
     * Called BEFORE the file enters the processing queue.
     * Useful for tracking/monitoring pending files.
     * @param filePath - Path to the file being marked as pending
     */
    markPending?(filePath: string): void;

    /**
     * Optional callback when a file begins processing.
     * Called WITHIN the queue (respects concurrency limits).
     * Can be used for quick/light pre-processing before main processing.
     * @param filePath - Path to the file being queued
     */
    queueFile?(filePath: string): Promise<void>;
}