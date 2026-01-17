/**
 * Container Plugin Scheduler
 *
 * Handles dispatching tasks to containerized plugins and
 * processing completion callbacks.
 */

import { EventEmitter } from 'events';
import PQueue from 'p-queue';
import { randomUUID } from 'crypto';
import type { ContainerManager } from './ContainerManager.js';
import type {
    ContainerTask,
    ContainerTaskStatus,
    PluginProcessRequest,
    PluginProcessResponse,
    PluginCallbackPayload,
    CallbackStatus,
} from './types.js';
import type { TaskQueueType } from '../plugin-engine/types.js';
import type { IKVClient } from '../kv/IKVClient.js';
import { config } from '../config/EnvConfig.js';

/**
 * Scheduler events
 */
export interface ContainerSchedulerEvents {
    'task:created': { task: ContainerTask };
    'task:dispatched': { task: ContainerTask };
    'task:completed': { task: ContainerTask };
    'task:failed': { task: ContainerTask; error: string };
    'task:timeout': { task: ContainerTask };
    'file:complete': { fileHash: string; filePath: string };
}

/**
 * Pending callback info
 */
interface PendingCallback {
    task: ContainerTask;
    resolve: (result: PluginCallbackPayload) => void;
    reject: (error: Error) => void;
    timeoutHandle: NodeJS.Timeout;
}

/**
 * Gate status for queue control
 */
export interface GateStatus {
    isOpen: boolean;
    fastPending: number;
    fastRunning: number;
    backgroundPending: number;
    backgroundRunning: number;
}

/**
 * Container Plugin Scheduler
 */
export class ContainerPluginScheduler extends EventEmitter {
    private containerManager: ContainerManager;
    private fastQueue: PQueue;
    private backgroundQueue: PQueue;
    private pendingTasks: Map<string, ContainerTask> = new Map();
    private pendingCallbacks: Map<string, PendingCallback> = new Map();
    private fileTasks: Map<string, Set<string>> = new Map(); // fileHash -> taskIds
    private fileCompletedPlugins: Map<string, Set<string>> = new Map(); // fileHash -> completed pluginIds
    private dependencyWaiters: Map<string, Array<() => void>> = new Map(); // "fileHash:pluginId" -> resolve callbacks
    private callbackUrl: string;
    private metaCoreUrl: string;
    private defaultTimeout: number = 60000; // 60 seconds
    private kvClient: IKVClient | null = null;
    private isAcceptingNewTasks: boolean = true; // Gate control for safe mount/unmount

    constructor(
        containerManager: ContainerManager,
        options?: {
            fastConcurrency?: number;
            backgroundConcurrency?: number;
            callbackUrl?: string;
            metaCoreUrl?: string;
            defaultTimeout?: number;
            kvClient?: IKVClient;
        }
    ) {
        super();
        this.containerManager = containerManager;

        this.fastQueue = new PQueue({
            concurrency: options?.fastConcurrency ?? config.FAST_QUEUE_CONCURRENCY,
        });

        this.backgroundQueue = new PQueue({
            concurrency: options?.backgroundConcurrency ?? config.BACKGROUND_QUEUE_CONCURRENCY,
        });

        this.callbackUrl = options?.callbackUrl ?? `${config.CONTAINER_CALLBACK_URL}/api/plugins/callback`;
        this.metaCoreUrl = options?.metaCoreUrl ?? config.CONTAINER_META_CORE_URL;
        this.defaultTimeout = options?.defaultTimeout ?? 60000;
        this.kvClient = options?.kvClient ?? null;
    }

    /**
     * Wait for dependency plugins to complete for a file
     */
    private async waitForDependencies(
        fileHash: string,
        dependencies: string[],
        timeoutMs: number = 30000
    ): Promise<void> {
        if (!dependencies || dependencies.length === 0) {
            return;
        }

        const completedPlugins = this.fileCompletedPlugins.get(fileHash) || new Set();
        const pendingDeps = dependencies.filter(dep => !completedPlugins.has(dep));

        if (pendingDeps.length === 0) {
            return; // All dependencies already completed
        }

        // Wait for each pending dependency
        const waitPromises = pendingDeps.map(depPluginId => {
            return new Promise<void>((resolve, reject) => {
                const key = `${fileHash}:${depPluginId}`;

                // Check again in case it completed while we were setting up
                const currentCompleted = this.fileCompletedPlugins.get(fileHash);
                if (currentCompleted?.has(depPluginId)) {
                    resolve();
                    return;
                }

                // Set up timeout
                const timeoutHandle = setTimeout(() => {
                    // Remove waiter on timeout
                    const waiters = this.dependencyWaiters.get(key);
                    if (waiters) {
                        const idx = waiters.indexOf(resolve);
                        if (idx >= 0) waiters.splice(idx, 1);
                    }
                    // Resolve anyway to not block - plugin will get stale metadata but won't hang
                    console.warn(`[ContainerScheduler] Timeout waiting for dependency '${depPluginId}' for file ${fileHash}`);
                    resolve();
                }, timeoutMs);

                // Register waiter
                if (!this.dependencyWaiters.has(key)) {
                    this.dependencyWaiters.set(key, []);
                }
                this.dependencyWaiters.get(key)!.push(() => {
                    clearTimeout(timeoutHandle);
                    resolve();
                });
            });
        });

        await Promise.all(waitPromises);
    }

    /**
     * Mark a plugin as completed for a file and notify waiters
     */
    private markPluginCompleted(fileHash: string, pluginId: string, filePath?: string): void {
        // Track completion
        if (!this.fileCompletedPlugins.has(fileHash)) {
            this.fileCompletedPlugins.set(fileHash, new Set());
        }
        this.fileCompletedPlugins.get(fileHash)!.add(pluginId);

        // Notify waiters
        const key = `${fileHash}:${pluginId}`;
        const waiters = this.dependencyWaiters.get(key);
        if (waiters) {
            for (const resolve of waiters) {
                resolve();
            }
            this.dependencyWaiters.delete(key);
        }

        // Publish to Redis for external subscribers (e.g., meta-stremio)
        this.publishPluginComplete(fileHash, pluginId, filePath || '');
    }

    /**
     * Publish plugin completion event to Redis
     * Channel: meta-sort:plugin:complete
     *
     * External services (like meta-stremio) can subscribe to this channel
     * to be notified when specific plugins complete for a file.
     */
    private async publishPluginComplete(fileHash: string, pluginId: string, filePath: string): Promise<void> {
        if (!this.kvClient) {
            return;
        }

        try {
            const message = JSON.stringify({
                fileHash,
                pluginId,
                filePath,
                timestamp: Date.now()
            });
            await (this.kvClient as any).publish('meta-sort:plugin:complete', message);
        } catch (error) {
            // Silent fail - pub/sub is optional
        }
    }

    /**
     * Create a task for a container plugin
     */
    createTask(
        pluginId: string,
        fileHash: string,
        filePath: string,
        dependencies: string[] = [],
        queue: TaskQueueType = 'fast'
    ): ContainerTask {
        const task: ContainerTask = {
            id: randomUUID(),
            fileHash,
            filePath,
            pluginId,
            dependencies,
            queue,
            status: 'pending',
            createdAt: Date.now(),
        };

        this.pendingTasks.set(task.id, task);

        // Track tasks by file
        if (!this.fileTasks.has(fileHash)) {
            this.fileTasks.set(fileHash, new Set());
        }
        this.fileTasks.get(fileHash)!.add(task.id);

        this.emit('task:created', { task });

        return task;
    }

    /**
     * Enqueue a task for execution
     * Returns false if the gate is closed and the task was rejected
     */
    enqueueTask(task: ContainerTask): boolean {
        if (!this.isAcceptingNewTasks) {
            console.log(`[Gate] Task ${task.id} rejected - gate closed (plugin: ${task.pluginId}, file: ${task.filePath})`);
            // Remove from tracking since it won't be executed
            this.pendingTasks.delete(task.id);
            const fileTasks = this.fileTasks.get(task.fileHash);
            if (fileTasks) {
                fileTasks.delete(task.id);
                if (fileTasks.size === 0) {
                    this.fileTasks.delete(task.fileHash);
                }
            }
            return false;
        }

        const queue = task.queue === 'background' ? this.backgroundQueue : this.fastQueue;

        queue.add(async () => {
            await this.executeTask(task);
        });
        return true;
    }

    /**
     * Execute a task (dispatch to container)
     */
    private async executeTask(task: ContainerTask): Promise<void> {
        // Wait for dependencies to complete first
        if (task.dependencies && task.dependencies.length > 0) {
            task.status = 'waiting';
            await this.waitForDependencies(task.fileHash, task.dependencies);
        }

        const instance = this.containerManager.getHealthyInstance(task.pluginId);

        if (!instance) {
            task.status = 'failed';
            task.error = `No healthy instance available for plugin '${task.pluginId}'`;
            this.emit('task:failed', { task, error: task.error });
            this.checkFileCompletion(task.fileHash);
            return;
        }

        task.status = 'dispatched';
        task.dispatchedAt = Date.now();
        task.instanceName = instance.containerName;

        this.emit('task:dispatched', { task });

        try {
            // Fetch fresh metadata after dependencies complete
            // This ensures we get metadata written by dependency plugins
            const existingMeta = await this.fetchExistingMetadata(task.fileHash);

            // Build process request
            const request: PluginProcessRequest = {
                taskId: task.id,
                cid: task.fileHash,
                filePath: task.filePath,
                callbackUrl: this.callbackUrl,
                metaCoreUrl: this.metaCoreUrl,
                existingMeta,
            };

            // Dispatch to container
            const response = await this.dispatchToContainer(instance.baseUrl, request);

            if (response.status !== 'accepted') {
                throw new Error(response.error || 'Task rejected by plugin');
            }

            // Wait for callback with timeout
            const manifest = instance.manifest;
            const timeout = manifest?.timeout ?? this.defaultTimeout;

            await this.waitForCallback(task, timeout);

        } catch (error) {
            task.status = 'failed';
            task.error = error instanceof Error ? error.message : String(error);
            task.completedAt = Date.now();

            if (task.dispatchedAt) {
                task.duration = task.completedAt - task.dispatchedAt;
            }

            this.containerManager.recordTaskCompletion(
                task.pluginId,
                task.instanceName!,
                false
            );

            this.emit('task:failed', { task, error: task.error });
        }

        this.checkFileCompletion(task.fileHash);
    }

    /**
     * Dispatch task to container plugin
     */
    private async dispatchToContainer(
        baseUrl: string,
        request: PluginProcessRequest
    ): Promise<PluginProcessResponse> {
        const response = await fetch(`${baseUrl}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(10000), // 10s timeout for dispatch
        });

        if (!response.ok) {
            throw new Error(`Plugin returned ${response.status}: ${await response.text()}`);
        }

        return response.json() as Promise<PluginProcessResponse>;
    }

    /**
     * Wait for callback from container
     */
    private waitForCallback(task: ContainerTask, timeoutMs: number): Promise<PluginCallbackPayload> {
        return new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                this.pendingCallbacks.delete(task.id);
                task.status = 'timeout';
                task.completedAt = Date.now();
                if (task.dispatchedAt) {
                    task.duration = task.completedAt - task.dispatchedAt;
                }
                this.emit('task:timeout', { task });
                reject(new Error(`Task timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingCallbacks.set(task.id, {
                task,
                resolve,
                reject,
                timeoutHandle,
            });
        });
    }

    /**
     * Handle callback from container plugin
     */
    handleCallback(payload: PluginCallbackPayload): boolean {
        const pending = this.pendingCallbacks.get(payload.taskId);

        if (!pending) {
            console.warn(
                `[ContainerScheduler] Received callback for unknown task: ${payload.taskId}`
            );
            return false;
        }

        // Clear timeout
        clearTimeout(pending.timeoutHandle);
        this.pendingCallbacks.delete(payload.taskId);

        const task = pending.task;
        task.completedAt = Date.now();
        task.duration = payload.duration;

        if (payload.status === 'completed') {
            task.status = 'completed';

            this.containerManager.recordTaskCompletion(
                task.pluginId,
                task.instanceName!,
                true
            );

            // Mark plugin as completed for dependency tracking
            this.markPluginCompleted(task.fileHash, task.pluginId, task.filePath);

            this.emit('task:completed', { task });
            pending.resolve(payload);

        } else if (payload.status === 'failed') {
            task.status = 'failed';
            task.error = payload.error;

            this.containerManager.recordTaskCompletion(
                task.pluginId,
                task.instanceName!,
                false
            );

            // Still mark as completed for dependency purposes (don't block other plugins)
            this.markPluginCompleted(task.fileHash, task.pluginId, task.filePath);

            this.emit('task:failed', { task, error: payload.error || 'Unknown error' });
            pending.reject(new Error(payload.error || 'Task failed'));

        } else if (payload.status === 'skipped') {
            task.status = 'completed'; // Treat skipped as completed
            task.error = payload.reason;

            this.containerManager.recordTaskCompletion(
                task.pluginId,
                task.instanceName!,
                true
            );

            // Mark plugin as completed for dependency tracking
            this.markPluginCompleted(task.fileHash, task.pluginId, task.filePath);

            this.emit('task:completed', { task });
            pending.resolve(payload);
        }

        return true;
    }

    /**
     * Check if all tasks for a file are complete
     */
    private checkFileCompletion(fileHash: string): void {
        const taskIds = this.fileTasks.get(fileHash);
        if (!taskIds) return;

        let allComplete = true;
        let filePath: string | undefined;

        for (const taskId of taskIds) {
            const task = this.pendingTasks.get(taskId);
            if (!task) continue;

            filePath = task.filePath;

            if (
                task.status !== 'completed' &&
                task.status !== 'failed' &&
                task.status !== 'timeout'
            ) {
                allComplete = false;
                break;
            }
        }

        if (allComplete && filePath) {
            // Clean up task tracking
            for (const taskId of taskIds) {
                this.pendingTasks.delete(taskId);
            }
            this.fileTasks.delete(fileHash);

            // Clean up dependency tracking
            this.fileCompletedPlugins.delete(fileHash);
            // Clean up any stale dependency waiters for this file
            for (const key of this.dependencyWaiters.keys()) {
                if (key.startsWith(`${fileHash}:`)) {
                    this.dependencyWaiters.delete(key);
                }
            }

            this.emit('file:complete', { fileHash, filePath });
        }
    }

    /**
     * Fetch existing metadata for a file
     */
    private async fetchExistingMetadata(fileHash: string): Promise<Record<string, string>> {
        try {
            const response = await fetch(`${this.metaCoreUrl}/meta/${fileHash}`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
                return {};
            }

            const data = await response.json() as { metadata?: Record<string, string> };
            return data.metadata || {};
        } catch {
            return {};
        }
    }

    /**
     * Get queue status
     */
    getQueueStatus(): {
        fast: { pending: number; running: number };
        background: { pending: number; running: number };
        pendingTasks: number;
        pendingCallbacks: number;
    } {
        return {
            fast: {
                pending: this.fastQueue.pending,
                running: this.fastQueue.pending - this.fastQueue.size,
            },
            background: {
                pending: this.backgroundQueue.pending,
                running: this.backgroundQueue.pending - this.backgroundQueue.size,
            },
            pendingTasks: this.pendingTasks.size,
            pendingCallbacks: this.pendingCallbacks.size,
        };
    }

    /**
     * Set the gate state (open/closed)
     * When closed, new tasks will be rejected but existing tasks will complete
     */
    setGate(accepting: boolean): void {
        const wasAccepting = this.isAcceptingNewTasks;
        this.isAcceptingNewTasks = accepting;
        if (wasAccepting !== accepting) {
            console.log(`[Gate] Gate ${accepting ? 'opened' : 'closed'} - ${accepting ? 'accepting' : 'rejecting'} new tasks`);
        }
    }

    /**
     * Check if the gate is open (accepting new tasks)
     */
    isGateOpen(): boolean {
        return this.isAcceptingNewTasks;
    }

    /**
     * Get detailed gate status including queue counts
     */
    getGateStatus(): GateStatus {
        const queueStatus = this.getQueueStatus();
        return {
            isOpen: this.isAcceptingNewTasks,
            fastPending: queueStatus.fast.pending,
            fastRunning: queueStatus.fast.running,
            backgroundPending: queueStatus.background.pending,
            backgroundRunning: queueStatus.background.running,
        };
    }

    /**
     * Wait for both queues to drain (all tasks completed)
     * Useful for safe unmount operations
     * @param timeoutMs Maximum time to wait (default: 60000ms)
     * @returns true if queues are empty, false if timeout
     */
    async waitForEmpty(timeoutMs: number = 60000): Promise<boolean> {
        const start = Date.now();
        const pollInterval = 500;

        while (Date.now() - start < timeoutMs) {
            const status = this.getGateStatus();
            const totalActive = status.fastPending + status.fastRunning +
                               status.backgroundPending + status.backgroundRunning;

            if (totalActive === 0) {
                console.log(`[Gate] Queues drained after ${Date.now() - start}ms`);
                return true;
            }

            await new Promise(r => setTimeout(r, pollInterval));
        }

        console.log(`[Gate] Timeout waiting for queues to drain (${timeoutMs}ms)`);
        return false;
    }

    /**
     * Get pending tasks for a file
     */
    getPendingTasksForFile(fileHash: string): ContainerTask[] {
        const taskIds = this.fileTasks.get(fileHash);
        if (!taskIds) return [];

        return Array.from(taskIds)
            .map(id => this.pendingTasks.get(id))
            .filter((t): t is ContainerTask => t !== undefined);
    }

    /**
     * Cancel all tasks for a file
     */
    cancelFile(fileHash: string): void {
        const taskIds = this.fileTasks.get(fileHash);
        if (!taskIds) return;

        for (const taskId of taskIds) {
            const pending = this.pendingCallbacks.get(taskId);
            if (pending) {
                clearTimeout(pending.timeoutHandle);
                pending.reject(new Error('Task cancelled'));
                this.pendingCallbacks.delete(taskId);
            }
            this.pendingTasks.delete(taskId);
        }

        this.fileTasks.delete(fileHash);
    }

    /**
     * Clear all queues
     */
    clear(): void {
        this.fastQueue.clear();
        this.backgroundQueue.clear();

        for (const pending of this.pendingCallbacks.values()) {
            clearTimeout(pending.timeoutHandle);
            pending.reject(new Error('Scheduler cleared'));
        }

        this.pendingCallbacks.clear();
        this.pendingTasks.clear();
        this.fileTasks.clear();
        this.fileCompletedPlugins.clear();
        this.dependencyWaiters.clear();
    }

    /**
     * Pause queues
     */
    /**
     * Get currently running tasks (status === 'dispatched')
     * Returns array of { taskId, pluginId, fileHash, filePath, queue, startTime }
     */
    getRunningTasks(): Array<{
        taskId: string;
        pluginId: string;
        fileHash: string;
        filePath: string;
        queue: TaskQueueType;
        startTime?: number;
    }> {
        const running: Array<{
            taskId: string;
            pluginId: string;
            fileHash: string;
            filePath: string;
            queue: TaskQueueType;
            startTime?: number;
        }> = [];

        for (const [taskId, task] of this.pendingTasks) {
            if (task.status === 'dispatched') {
                running.push({
                    taskId,
                    pluginId: task.pluginId,
                    fileHash: task.fileHash,
                    filePath: task.filePath,
                    queue: task.queue,
                    startTime: task.dispatchedAt,
                });
            }
        }

        return running;
    }

    pause(): void {
        this.fastQueue.pause();
        this.backgroundQueue.pause();
    }

    /**
     * Resume queues
     */
    resume(): void {
        this.fastQueue.start();
        this.backgroundQueue.start();
    }

    /**
     * Dispatch tasks to all enabled plugins for a file
     * This creates and enqueues tasks for all plugins that should process this file
     */
    async dispatchAllPlugins(
        fileHash: string,
        filePath: string,
        existingMeta: Record<string, string>
    ): Promise<void> {
        const status = this.containerManager.getStatus();

        if (!status.initialized || status.pluginCount === 0) {
            return; // No plugins available
        }

        console.log(`[ContainerScheduler] Dispatching tasks for ${fileHash} to ${status.pluginCount} plugins`);

        // Get plugin info and dispatch tasks
        for (const pluginStatus of status.plugins) {
            if (!pluginStatus.enabled || pluginStatus.healthyInstances === 0) {
                continue; // Skip disabled or unhealthy plugins
            }

            const manifest = this.containerManager.getPluginManifest(pluginStatus.pluginId);
            const queue: TaskQueueType = manifest?.defaultQueue || 'fast';
            const dependencies = manifest?.dependencies || [];

            // Create and enqueue task
            const task = this.createTask(
                pluginStatus.pluginId,
                fileHash,
                filePath,
                dependencies,
                queue
            );

            // Store existing metadata in task for dispatch
            (task as any).existingMeta = existingMeta;

            this.enqueueTask(task);
        }
    }
}

/**
 * Create a container plugin scheduler
 */
export function createContainerPluginScheduler(
    containerManager: ContainerManager,
    options?: {
        fastConcurrency?: number;
        backgroundConcurrency?: number;
        callbackUrl?: string;
        metaCoreUrl?: string;
        kvClient?: IKVClient;
    }
): ContainerPluginScheduler {
    return new ContainerPluginScheduler(containerManager, options);
}
