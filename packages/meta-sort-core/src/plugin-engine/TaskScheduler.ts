/**
 * Task Scheduler
 *
 * Manages plugin task execution across fast and background queues.
 * All plugins run as Docker containers - task execution is delegated to ContainerPluginScheduler.
 */

import { EventEmitter } from 'events';
import PQueue from 'p-queue';
import type {
    PluginTask,
    PluginTaskStatus,
    PluginTaskResult,
    TaskQueueType,
    QueueStatus,
    TaskSchedulerEvent,
    PluginManifest,
    PluginKVStore,
} from './types.js';
import type { PluginManager } from './PluginManager.js';
import type { PerformanceMetrics, PluginTimingStats } from '../metrics/PerformanceMetrics.js';
import type { ContainerPluginScheduler } from '../container-plugins/index.js';
import { KVStore } from './PluginContext.js';

// =============================================================================
// Configuration
// =============================================================================

export interface TaskSchedulerConfig {
    /** Concurrency for fast queue (default: 32) */
    fastQueueConcurrency?: number;
    /** Concurrency for background queue (default: 8) */
    backgroundQueueConcurrency?: number;
    /** Threshold in ms for fast classification (default: 1000) */
    fastThresholdMs?: number;
    /** Minimum samples before using measured timing (default: 10) */
    minSamplesForMeasurement?: number;
}

const DEFAULT_CONFIG: Required<TaskSchedulerConfig> = {
    fastQueueConcurrency: 32,
    backgroundQueueConcurrency: 8,
    fastThresholdMs: 1000,
    minSamplesForMeasurement: 10,
};

// =============================================================================
// Task Scheduler
// =============================================================================

export class TaskScheduler extends EventEmitter {
    private pluginManager: PluginManager;
    private performanceMetrics: PerformanceMetrics;
    private config: Required<TaskSchedulerConfig>;

    // Queues
    private fastQueue: PQueue;
    private backgroundQueue: PQueue;

    // Task tracking
    private pendingTasks: Map<string, PluginTask> = new Map();
    private completedTasks: Set<string> = new Set();
    private fileTasks: Map<string, Set<string>> = new Map(); // fileHash -> taskIds
    private fileKVStores: Map<string, PluginKVStore> = new Map(); // fileHash -> KV store

    // Container plugin support
    private containerPluginScheduler: ContainerPluginScheduler | null = null;

    // Statistics
    private totalTasksCreated: number = 0;
    private totalTasksCompleted: number = 0;
    private totalTasksFailed: number = 0;

    constructor(
        pluginManager: PluginManager,
        performanceMetrics: PerformanceMetrics,
        config: TaskSchedulerConfig = {}
    ) {
        super();
        this.pluginManager = pluginManager;
        this.performanceMetrics = performanceMetrics;
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Initialize fast queue
        this.fastQueue = new PQueue({
            concurrency: this.config.fastQueueConcurrency,
        });

        // Initialize background queue (starts paused)
        this.backgroundQueue = new PQueue({
            concurrency: this.config.backgroundQueueConcurrency,
            autoStart: false,
        });

        // When fast queue becomes idle, start background queue
        this.fastQueue.on('idle', () => {
            this.onFastQueueIdle();
        });
    }

    /**
     * Set the container plugin scheduler (called after initialization)
     */
    setContainerPluginScheduler(scheduler: ContainerPluginScheduler): void {
        this.containerPluginScheduler = scheduler;

        // Forward container scheduler events to this scheduler
        scheduler.on('task:completed', ({ task }) => {
            this.onContainerTaskComplete(task.id, task.fileHash, true);
        });
        scheduler.on('task:failed', ({ task }) => {
            this.onContainerTaskComplete(task.id, task.fileHash, false);
        });
        scheduler.on('file:complete', ({ fileHash, filePath }) => {
            // Container file completion - check if local tasks are also done
            this.checkFileComplete(fileHash);
        });

        console.log('[TaskScheduler] Container plugin scheduler set');
    }

    /**
     * Handle completion of a container plugin task
     */
    private onContainerTaskComplete(taskId: string, fileHash: string, success: boolean): void {
        // Move from pending to completed
        this.pendingTasks.delete(taskId);
        this.completedTasks.add(taskId);

        if (success) {
            this.totalTasksCompleted++;
        } else {
            this.totalTasksFailed++;
        }

        // Schedule dependent tasks
        const task = { id: taskId, fileHash, pluginId: taskId.split(':')[1] } as PluginTask;
        this.scheduleDependentTasks(task);

        // Check if file is complete
        this.checkFileComplete(fileHash);
    }

    // =========================================================================
    // Task Creation
    // =========================================================================

    /**
     * Create tasks for all active plugins for a file
     * @param filePath - Absolute path to the file
     * @param fileHash - File identity hash (midhash256)
     * @param kv - KV store for the file (will be shared across all plugins)
     */
    createTasksForFile(filePath: string, fileHash: string, kv?: PluginKVStore): PluginTask[] {
        const tasks: PluginTask[] = [];
        const executionOrder = this.pluginManager.getExecutionOrder();
        const plugins = this.pluginManager.getPlugins();
        const pluginMap = new Map(plugins.map(p => [p.id, p]));

        // Initialize file task tracking
        if (!this.fileTasks.has(fileHash)) {
            this.fileTasks.set(fileHash, new Set());
        }
        const fileTaskIds = this.fileTasks.get(fileHash)!;

        // Store KV for this file (create new if not provided)
        if (!this.fileKVStores.has(fileHash)) {
            this.fileKVStores.set(fileHash, kv || new KVStore());
        }

        for (const pluginId of executionOrder) {
            const plugin = pluginMap.get(pluginId);
            if (!plugin || !plugin.active) continue;

            const taskId = `${fileHash}:${pluginId}`;

            // Skip if task already exists
            if (this.pendingTasks.has(taskId) || this.completedTasks.has(taskId)) {
                continue;
            }

            const timing = this.performanceMetrics.getPluginTiming(pluginId);
            const queue = this.classifyPlugin(pluginId);

            const task: PluginTask = {
                id: taskId,
                fileHash,
                filePath,
                pluginId,
                dependencies: plugin.dependencies || [],
                queue,
                priority: timing?.average || 0,
                estimatedTimeMs: timing?.average || 0,
                status: 'pending',
                createdAt: Date.now(),
            };

            tasks.push(task);
            fileTaskIds.add(taskId);
            this.totalTasksCreated++;

            this.emitEvent({ type: 'task:created', task });
        }

        return tasks;
    }

    /**
     * Create a task for a specific plugin on a single file
     * Used for recompute scenarios where we want to run just one plugin
     * @param pluginId - Plugin to execute
     * @param filePath - Absolute path to the file
     * @param fileHash - File identity hash (midhash256)
     * @param options - Runtime options merged into plugin config (e.g., { forceRecompute: true })
     * @param kvData - Optional initial KV data (flattened metadata from Redis)
     * @returns The created task, or null if plugin not found/not active
     */
    createTaskForPlugin(
        pluginId: string,
        filePath: string,
        fileHash: string,
        options?: Record<string, unknown>,
        kvData?: Record<string, string>
    ): PluginTask | null {
        const plugins = this.pluginManager.getPlugins();
        const plugin = plugins.find(p => p.id === pluginId);

        if (!plugin || !plugin.active) {
            console.warn(`[TaskScheduler] Plugin '${pluginId}' not found or not active`);
            return null;
        }

        // Use a unique task ID for recompute tasks to avoid conflicts
        const taskId = options?.forceRecompute
            ? `${fileHash}:${pluginId}:recompute:${Date.now()}`
            : `${fileHash}:${pluginId}`;

        // Skip if non-recompute task already exists
        if (!options?.forceRecompute && (this.pendingTasks.has(taskId) || this.completedTasks.has(taskId))) {
            return null;
        }

        // Initialize file task tracking if needed
        if (!this.fileTasks.has(fileHash)) {
            this.fileTasks.set(fileHash, new Set());
        }
        const fileTaskIds = this.fileTasks.get(fileHash)!;

        // Initialize or update KV store for this file
        // For recompute, we want to load existing metadata so plugin can see current state
        if (!this.fileKVStores.has(fileHash)) {
            this.fileKVStores.set(fileHash, new KVStore(kvData));
        } else if (kvData) {
            // Update existing KV store with provided data
            const existingKv = this.fileKVStores.get(fileHash)!;
            for (const [key, value] of Object.entries(kvData)) {
                existingKv.set(key, value);
            }
        }

        const timing = this.performanceMetrics.getPluginTiming(pluginId);
        const queue = this.classifyPlugin(pluginId);

        const task: PluginTask = {
            id: taskId,
            fileHash,
            filePath,
            pluginId,
            dependencies: plugin.dependencies || [],
            queue,
            priority: timing?.average || 0,
            estimatedTimeMs: timing?.average || 0,
            status: 'pending',
            createdAt: Date.now(),
            options,
        };

        fileTaskIds.add(taskId);
        this.totalTasksCreated++;
        this.emitEvent({ type: 'task:created', task });

        return task;
    }

    /**
     * Create tasks for a specific plugin on multiple files
     * Used for "recompute plugin on all files" feature
     * @param pluginId - Plugin to execute
     * @param files - Array of { filePath, fileHash, kvData? } objects
     * @param options - Runtime options merged into plugin config
     * @returns Array of created tasks
     */
    createTasksForPluginOnFiles(
        pluginId: string,
        files: Array<{ filePath: string; fileHash: string; kvData?: Record<string, string> }>,
        options?: Record<string, unknown>
    ): PluginTask[] {
        const tasks: PluginTask[] = [];

        for (const { filePath, fileHash, kvData } of files) {
            const task = this.createTaskForPlugin(pluginId, filePath, fileHash, options, kvData);
            if (task) {
                tasks.push(task);
            }
        }

        console.log(`[TaskScheduler] Created ${tasks.length} tasks for plugin '${pluginId}'`);
        return tasks;
    }

    /**
     * Enqueue a task for execution
     * All plugins are container-based, so all tasks go to the container scheduler
     */
    enqueueTask(task: PluginTask): void {
        this.pendingTasks.set(task.id, task);
        this.enqueueContainerTask(task);
    }

    /**
     * Enqueue multiple tasks
     */
    enqueueTasks(tasks: PluginTask[]): void {
        for (const task of tasks) {
            this.enqueueTask(task);
        }
    }

    /**
     * Enqueue a task to the container plugin scheduler
     */
    private enqueueContainerTask(task: PluginTask): void {
        if (!this.containerPluginScheduler) {
            console.warn(
                `[TaskScheduler] Container plugin task ${task.id} cannot be scheduled: no container scheduler`
            );
            task.status = 'failed';
            task.result = {
                success: false,
                timeMs: 0,
                error: 'Container plugin scheduler not available',
            };
            this.pendingTasks.delete(task.id);
            this.completedTasks.add(task.id);
            this.totalTasksFailed++;
            return;
        }

        // Create container task and enqueue
        const containerTask = this.containerPluginScheduler.createTask(
            task.pluginId,
            task.fileHash,
            task.filePath,
            task.dependencies,
            task.queue
        );

        // Map the local task ID to the container task ID
        // Update our pending tasks map with the container task ID
        this.pendingTasks.delete(task.id);
        this.pendingTasks.set(containerTask.id, {
            ...task,
            id: containerTask.id, // Use container task ID
        });

        // Update file task tracking
        const fileTaskIds = this.fileTasks.get(task.fileHash);
        if (fileTaskIds) {
            fileTaskIds.delete(task.id);
            fileTaskIds.add(containerTask.id);
        }

        // Enqueue to container scheduler
        this.containerPluginScheduler.enqueueTask(containerTask);
    }

    // =========================================================================
    // Classification
    // =========================================================================

    /**
     * Classify a plugin as fast or background based on timing data and manifest
     */
    classifyPlugin(pluginId: string): TaskQueueType {
        const plugins = this.pluginManager.getPlugins();
        const plugin = plugins.find(p => p.id === pluginId);
        const timing = this.performanceMetrics.getPluginTiming(pluginId);

        // Get manifest default queue (need to access via plugin manager internals)
        // For now, we'll use a workaround - check if plugin has defaultQueue in manifest
        const manifest = this.getPluginManifest(pluginId);
        const defaultQueue = manifest?.defaultQueue || 'fast';

        // If we have enough samples, use measured timing
        if (timing && timing.count >= this.config.minSamplesForMeasurement) {
            return timing.average < this.config.fastThresholdMs ? 'fast' : 'background';
        }

        // Otherwise use manifest default
        return defaultQueue;
    }

    // =========================================================================
    // Task Completion
    // =========================================================================

    private scheduleDependentTasks(completedTask: PluginTask): void {
        // Container scheduler handles dependency resolution
        // This method is kept for compatibility but doesn't need to do anything
    }

    private checkFileComplete(fileHash: string): void {
        const fileTaskIds = this.fileTasks.get(fileHash);
        if (!fileTaskIds) return;

        // Check if all tasks for this file are completed
        let filePath = '';
        for (const taskId of fileTaskIds) {
            if (!this.completedTasks.has(taskId)) {
                return; // Still have pending/running tasks
            }
            // Try to get filePath from any task
            if (!filePath) {
                const task = this.pendingTasks.get(taskId);
                if (task) filePath = task.filePath;
            }
        }

        // All tasks complete
        this.emitEvent({
            type: 'file:complete',
            fileHash,
            filePath,
        });

        // Clean up file tracking
        this.fileTasks.delete(fileHash);
        this.fileKVStores.delete(fileHash);

        // Clean up completed task IDs for this file to prevent memory leak
        for (const taskId of fileTaskIds) {
            this.completedTasks.delete(taskId);
        }
    }

    // =========================================================================
    // Queue Control
    // =========================================================================

    private onFastQueueIdle(): void {
        this.emitEvent({ type: 'queue:fast:idle' });

        // Start background queue if it has pending work
        if (this.backgroundQueue.size > 0 || this.backgroundQueue.pending > 0) {
            console.log('[TaskScheduler] Fast queue idle, starting background queue');
            this.backgroundQueue.start();
            this.emitEvent({ type: 'queue:background:started' });
        }
    }

    // =========================================================================
    // Status & Metrics
    // =========================================================================

    /**
     * Get status of both queues
     */
    getQueueStatus(): { fast: QueueStatus; background: QueueStatus } {
        return {
            fast: this.buildQueueStatus('fast'),
            background: this.buildQueueStatus('background'),
        };
    }

    private buildQueueStatus(queueType: TaskQueueType): QueueStatus {
        const queue = queueType === 'fast' ? this.fastQueue : this.backgroundQueue;

        let pending = 0;
        let ready = 0;
        let running = 0;
        let completed = 0;
        let failed = 0;

        // Count pending tasks for this queue type
        for (const [, task] of this.pendingTasks) {
            if (task.queue === queueType) {
                if (task.status === 'pending') pending++;
                else if (task.status === 'ready') ready++;
                else if (task.status === 'running') running++;
            }
        }

        // Count completed tasks
        for (const taskId of this.completedTasks) {
            const [, pluginId] = taskId.split(':');
            if (this.classifyPlugin(pluginId) === queueType) {
                completed++;
            }
        }

        return {
            pending,
            ready: queue.size, // Tasks in queue waiting to run
            running: queue.pending, // Tasks currently executing
            completed,
            failed, // Would need separate tracking
            isPaused: queue.isPaused,
        };
    }

    /**
     * Get pending tasks for a specific file
     */
    getPendingTasksForFile(fileHash: string): PluginTask[] {
        const tasks: PluginTask[] = [];
        const fileTaskIds = this.fileTasks.get(fileHash);

        if (fileTaskIds) {
            for (const taskId of fileTaskIds) {
                const task = this.pendingTasks.get(taskId);
                if (task) {
                    tasks.push(task);
                }
            }
        }

        return tasks;
    }

    /**
     * Get the KV store for a file
     */
    getFileKVStore(fileHash: string): PluginKVStore | undefined {
        return this.fileKVStores.get(fileHash);
    }

    /**
     * Cancel processing for a file (removes all pending tasks)
     */
    cancelFile(fileHash: string): void {
        const fileTaskIds = this.fileTasks.get(fileHash);
        if (!fileTaskIds) return;

        // Remove pending tasks
        for (const taskId of fileTaskIds) {
            this.pendingTasks.delete(taskId);
        }

        // Clean up file tracking
        this.fileTasks.delete(fileHash);
        this.fileKVStores.delete(fileHash);

        console.log(`[TaskScheduler] Cancelled processing for file ${fileHash}`);
    }

    /**
     * Get scheduler statistics
     */
    getStats(): {
        totalTasksCreated: number;
        totalTasksCompleted: number;
        totalTasksFailed: number;
        pendingTaskCount: number;
        completedTaskCount: number;
        filesInProgress: number;
    } {
        return {
            totalTasksCreated: this.totalTasksCreated,
            totalTasksCompleted: this.totalTasksCompleted,
            totalTasksFailed: this.totalTasksFailed,
            pendingTaskCount: this.pendingTasks.size,
            completedTaskCount: this.completedTasks.size,
            filesInProgress: this.fileTasks.size,
        };
    }

    // =========================================================================
    // Shutdown
    // =========================================================================

    /**
     * Gracefully shutdown the scheduler
     */
    async shutdown(): Promise<void> {
        console.log('[TaskScheduler] Shutting down...');

        // Clear queues
        this.fastQueue.clear();
        this.backgroundQueue.clear();

        // Wait for in-progress tasks to complete
        await Promise.all([
            this.fastQueue.onIdle(),
            this.backgroundQueue.onIdle(),
        ]);

        // Clear tracking
        this.pendingTasks.clear();
        this.completedTasks.clear();
        this.fileTasks.clear();
        this.fileKVStores.clear();

        console.log('[TaskScheduler] Shutdown complete');
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private getPluginManifest(pluginId: string): PluginManifest | undefined {
        // Access manifests from PluginManager
        const manifests = (this.pluginManager as any).manifests as Map<string, PluginManifest>;
        return manifests.get(pluginId);
    }

    private emitEvent(event: TaskSchedulerEvent): void {
        this.emit(event.type, event);
    }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a task scheduler instance
 */
export function createTaskScheduler(
    pluginManager: PluginManager,
    performanceMetrics: PerformanceMetrics,
    config?: TaskSchedulerConfig
): TaskScheduler {
    return new TaskScheduler(pluginManager, performanceMetrics, config);
}
