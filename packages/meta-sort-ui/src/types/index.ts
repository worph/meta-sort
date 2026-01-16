/**
 * Shared type definitions for meta-sort-ui
 */

export type FileState = 'discovered' | 'lightProcessing' | 'hashProcessing' | 'done';

export interface FileStateInfo {
    filePath: string;
    state: FileState;
    hash?: string;
    error?: string;
    retryCount?: number;
    discoveredAt?: number;
    lightProcessingStartedAt?: number;
    lightProcessingCompletedAt?: number;
    hashProcessingStartedAt?: number;
    hashProcessingCompletedAt?: number;
}

export interface QueueInfo {
    pending: number;
    size: number;
    paused?: boolean;
    running?: number;
    isPaused?: boolean;
}

/** New task queue status for the 3-queue architecture */
export interface TaskQueueStatus {
    running: number;
    pending: number;
    size: number;
    isPaused: boolean;
}

export interface ComputedQueueStats {
    // New 3-queue architecture
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

    // Legacy fields for backwards compatibility
    actualRunningLightWorkers: number;
    actualRunningHashWorkers: number;
    trueHashQueueSize: number;
    hashQueuePaused: boolean;
    lightQueuePaused: boolean;
}

export interface PipelineStats {
    discovered: number;
    validated: number;
    lightProcessed: number;
    hashProcessed: number;
    queues: {
        validation: QueueInfo;
        light: QueueInfo;
        hash: QueueInfo;
    };
}

/** Queue status from the new TaskScheduler */
export interface TaskSchedulerQueueStatus {
    preProcessQueue?: TaskQueueStatus;
    fastQueue?: TaskQueueStatus;
    backgroundQueue?: TaskQueueStatus;
}

export interface ProcessingStatus {
    discovered: FileStateInfo[];
    lightProcessing: FileStateInfo[];
    hashProcessing: FileStateInfo[];
    done: FileStateInfo[];
    /** Files waiting for fast queue (validated but not yet processing) */
    totalDiscovered: number;
    totalLightProcessing: number;
    totalHashProcessing: number;
    totalDone: number;
    /** Total number of failed files */
    totalFailed?: number;
    /** @deprecated Use totalDiscovered instead. Kept for backward compatibility. */
    awaitingFastQueue: number;
    /** Files that completed fast queue but are waiting for background queue */
    awaitingBackground: number;
    watchedFolders: string[];
    fastQueueConcurrency?: number;
    backgroundQueueConcurrency?: number;
    pipeline?: PipelineStats;
    computed?: ComputedQueueStats;
    queueStatus?: TaskSchedulerQueueStatus;
    // New concurrency config
    preProcessConcurrency?: number;
}

export interface FailedFile {
    filePath: string;
    reason: string;
    timestamp: number;
    retryCount: number;
    stage: 'metadata' | 'hash' | 'processing';
}

export interface FailedFilesResponse {
    failedFiles: FailedFile[];
    totalFailed: number;
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

export interface Metrics {
    totalFilesProcessed: number;
    totalFilesDiscovered: number;
    totalFilesFailed: number;
    averageLightProcessingMs: number;
    averageHashProcessingMs: number;
    filesPerSecond: number;
    uptime: number;
    startTime: number;
    lastActivityTime: number;
    memoryUsage?: {
        heapUsed: number;
        heapTotal: number;
        external: number;
        rss: number;
        arrayBuffers: number;
    };
    hashComputationTimes?: Record<string, HashTimingStats>;
    pluginProcessingTimes?: Record<string, PluginTimingStats>;
}

export interface DuplicateGroup {
    key: string;
    files: string[];
}

export interface DuplicateData {
    hashDuplicates: DuplicateGroup[];
    titleDuplicates: DuplicateGroup[];
    stats: {
        hashGroupCount: number;
        hashFileCount: number;
        titleGroupCount: number;
        titleFileCount: number;
    };
    computedAt: number;
    computationTimeMs: number;
    status?: string;
}

export interface RedisStats {
    fileCount: number;
    keyCount: number;
    totalSize: number;
    memoryUsage?: string;
    memoryUsageBytes?: number;
}

export interface QueueItem {
    path: string;
    phase: 'light' | 'hash';
    startTime?: number;
    // StreamingPipeline stages: validation → metadata → hashing
    queue?: 'validation' | 'metadata' | 'hashing';
    plugin?: string;
}

// Plugin types
export interface PluginConfigField {
    type: string;
    description?: string;
    default?: unknown;
    required?: boolean;
}

export interface PluginMetadataField {
    type: string;
    description?: string;
}

export interface PluginInfo {
    id: string;
    name: string;
    version: string;
    description?: string;
    dependencies: string[];
    active: boolean;
    status: 'loaded' | 'error' | 'unloaded';
    error?: string;
    config: Record<string, unknown>;
    configSchema?: Record<string, PluginConfigField>;
    metadataSchema?: Record<string, PluginMetadataField>;
    // Queue assignment from manifest or inferred from timing
    defaultQueue?: 'fast' | 'background';
}

export interface PluginsResponse {
    plugins: PluginInfo[];
    executionOrder: string[];
    activeCount: number;
    totalCount: number;
}

export interface PluginTiming {
    pluginId: string;
    totalCalls: number;
    totalTime: number;
    avgTime: number;
    minTime: number;
    maxTime: number;
}

export interface PluginTimingsResponse {
    timings: PluginTiming[];
    lastReset: number;
}
