/**
 * Extended Interfaces
 *
 * Type definitions that extend base interfaces with runtime-specific properties
 * that are not part of the core interface contracts. These extensions provide
 * type safety for implementation-specific features.
 */

import type { HashMeta } from '@metazla/meta-interface';
import type { IKVClient } from '../kv/IKVClient.js';
import type { FileAnalyzerInterface } from '../logic/fileProcessor/FileAnalyzerInterface.js';
import type { ContainerTask } from '../container-plugins/types.js';
import type { UnifiedProcessingSnapshot } from '../logic/UnifiedProcessingStateManager.js';

// =============================================================================
// IKVClient Extensions
// =============================================================================

/**
 * IKVClient with Redis pub/sub capabilities
 *
 * The base IKVClient interface doesn't include pub/sub methods since they're
 * Redis-specific. This extension provides type safety for Redis-based implementations.
 */
export interface IKVClientWithPubSub extends IKVClient {
    /**
     * Publish a message to a Redis channel
     */
    publish(channel: string, message: string): Promise<void>;

    /**
     * Get the underlying Redis client (implementation-specific)
     */
    getRedisClient?(): unknown;
}

/**
 * Type guard to check if a KVClient supports pub/sub
 */
export function hasPublish(client: IKVClient): client is IKVClientWithPubSub {
    return typeof (client as IKVClientWithPubSub).publish === 'function';
}

/**
 * IKVClient with Redis Streams capabilities
 *
 * Redis Streams provide reliable event delivery with persistence,
 * consumer groups, and replay capabilities. Preferred over pub/sub
 * for service-to-service communication.
 */
export interface IKVClientWithStreams extends IKVClient {
    /**
     * Add an entry to a Redis stream
     *
     * @param stream - Stream name (e.g., 'meta-sort:events')
     * @param maxlen - Maximum stream length (approximate, uses ~ for efficiency)
     * @param fields - Object containing field-value pairs to add
     * @returns The ID of the added entry
     */
    xadd(stream: string, maxlen: number, fields: Record<string, string>): Promise<string>;

    /**
     * Get the underlying Redis client (implementation-specific)
     */
    getRedisClient?(): unknown;
}

/**
 * Type guard to check if a KVClient supports Redis Streams
 */
export function hasStreamSupport(client: IKVClient): client is IKVClientWithStreams {
    return typeof (client as IKVClientWithStreams).xadd === 'function';
}

// =============================================================================
// HashMeta Extensions
// =============================================================================

/**
 * Extended HashMeta with runtime fields added during processing
 *
 * These fields are added by the processing pipeline but aren't part of
 * the core HashMeta interface defined in meta-interface.
 */
export interface ExtendedHashMeta extends HashMeta {
    /** File size in bytes (string from plugins, number internally) */
    sizeByte?: string | number;

    /** Current processing status */
    processingStatus?: 'pending' | 'processing' | 'complete' | 'failed';

    /** Source file path */
    filePath?: string;

    /** Last verification timestamp (0 = unverified, used during VFS rebuild) */
    _lastVerified?: number;
}

// =============================================================================
// FileAnalyzerInterface Extensions
// =============================================================================

/**
 * Index manager interface for file CID caching
 */
export interface IndexManager {
    /**
     * Get cached CID for a file based on path, size, and mtime
     */
    getCidForFile(
        path: string,
        size: number,
        mtime: string
    ): { cid_midhash256?: string } | undefined;

    /**
     * Add a file CID to the cache
     */
    addFileCid(
        path: string,
        size: number,
        mtime: string,
        cid: { cid_midhash256: string }
    ): void;
}

/**
 * Extended FileAnalyzerInterface with index manager
 *
 * FileProcessorPiscina exposes an indexManager property for CID caching
 * that isn't part of the base interface.
 */
export interface ExtendedFileAnalyzer extends FileAnalyzerInterface {
    /** Index manager for CID caching */
    indexManager?: IndexManager;
}

// =============================================================================
// ContainerTask Extensions
// =============================================================================

/**
 * Extended ContainerTask with runtime metadata
 *
 * During task dispatch, existing metadata is attached to the task for
 * the plugin to access.
 */
export interface ExtendedContainerTask extends ContainerTask {
    /** Existing metadata at time of dispatch */
    existingMeta?: Record<string, string>;
}

// =============================================================================
// UnifiedProcessingSnapshot Extensions
// =============================================================================

/**
 * Queue status structure from getQueueStatus()
 */
export interface QueueStatus {
    preProcessQueue: {
        size: number;
        pending: number;
        isPaused: boolean;
    };
    fastQueue: {
        size: number;
        pending: number;
        running: number;
        isPaused: boolean;
    };
    backgroundQueue: {
        size: number;
        pending: number;
        running: number;
        isPaused: boolean;
    };
}

/**
 * Computed processing status fields for UI
 */
export interface ComputedProcessingStatus {
    preProcessRunning: number;
    preProcessPending: number;
    preProcessPaused: boolean;

    fastQueueRunning: number;
    fastQueuePending: number;
    fastQueueTotal: number;
    fastQueuePaused: boolean;

    backgroundQueueRunning: number;
    backgroundQueuePending: number;
    backgroundQueueTotal: number;
    backgroundQueuePaused: boolean;

    gateOpen: boolean;
    gateStatus: unknown;
    pipelinePaused: boolean;

    // Legacy compatibility fields
    actualRunningHashWorkers: number;
    actualRunningLightWorkers: number;
    trueHashQueueSize: number;
    hashQueuePaused: boolean;
    lightQueuePaused: boolean;
}

/**
 * Extended processing snapshot with queue status and computed fields
 *
 * The API adds queue status and computed fields to the base snapshot
 * for UI consumption.
 */
export interface ExtendedProcessingSnapshot extends UnifiedProcessingSnapshot {
    /** Queue status from pipeline */
    queueStatus?: QueueStatus;

    /** Computed status fields for UI */
    computed?: ComputedProcessingStatus;

    /** Total number of failed files */
    totalFailed?: number;
}

// =============================================================================
// Error Type Guards
// =============================================================================

/**
 * Type guard for Node.js filesystem errors
 *
 * Use this instead of `(error as any).code` to safely check error codes.
 */
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

/**
 * Get error code if present, undefined otherwise
 */
export function getErrorCode(error: unknown): string | undefined {
    if (isNodeError(error)) {
        return error.code;
    }
    return undefined;
}

/**
 * Get error message safely from unknown error type
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
