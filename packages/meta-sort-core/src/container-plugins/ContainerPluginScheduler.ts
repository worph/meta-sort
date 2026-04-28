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
import { type ExtendedContainerTask } from '../types/ExtendedInterfaces.js';
import { config } from '../config/EnvConfig.js';
import { FileSlotGate } from './FileSlotGate.js';

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
 * Per-file holder snapshot exposed via getQueueStatus for the dashboard.
 * Lets operators see which 16 files are tying up cache slots and what plugin
 * each file is currently waiting on (the long-pole per file).
 */
export interface CacheSlotHolder {
    fileHash: string;
    filePath?: string;
    currentPlugin?: string;
    tasksRemaining: number;
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

    // File-level cache slots — see FileSlotGate.ts. Caps the number of files
    // whose bytes are concurrently being touched in each phase, so the WebDAV
    // cache only has to hold N files at a time regardless of plugin fan-out.
    private lightFileGate: FileSlotGate;
    private bgFileGate: FileSlotGate;
    // Per-(file, phase) outstanding task counter — drives slot release.
    private lightTasksPerFile: Map<string, number> = new Map();
    private bgTasksPerFile: Map<string, number> = new Map();
    // Tasks staged while waiting for a slot. Once the gate grants the file a
    // slot we flush the buffered tasks into the underlying PQueue.
    private lightBufferedTasks: Map<string, ContainerTask[]> = new Map();
    private bgBufferedTasks: Map<string, ContainerTask[]> = new Map();
    // Currently-dispatched plugin per file in each phase — used by the
    // dashboard to show "this file is currently waiting on plugin X".
    private lightCurrentPlugin: Map<string, string> = new Map();
    private bgCurrentPlugin: Map<string, string> = new Map();

    constructor(
        containerManager: ContainerManager,
        options?: {
            fastConcurrency?: number;
            backgroundConcurrency?: number;
            lightFileSlots?: number;
            bgFileSlots?: number;
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

        // Background queue starts paused - only runs when fast queue is idle
        // Default to same concurrency as fast queue if not specified
        this.backgroundQueue = new PQueue({
            concurrency: options?.backgroundConcurrency ?? config.FAST_QUEUE_CONCURRENCY,
            autoStart: false,
        });

        this.lightFileGate = new FileSlotGate(options?.lightFileSlots ?? config.FILE_LIGHT_SLOTS);
        this.bgFileGate = new FileSlotGate(options?.bgFileSlots ?? config.FILE_BG_SLOTS);

        // When fast queue becomes idle, start background queue
        this.fastQueue.on('idle', () => {
            this.onFastQueueIdle();
        });

        // Initialize with env vars as fallback (will be updated from ContainerManager after discovery)
        this.callbackUrl = options?.callbackUrl ?? `${config.CONTAINER_CALLBACK_URL}/api/plugins/callback`;
        this.metaCoreUrl = options?.metaCoreUrl ?? config.CONTAINER_META_CORE_URL;
        this.defaultTimeout = options?.defaultTimeout ?? 60000;
        this.kvClient = options?.kvClient ?? null;
    }

    /**
     * Update URLs from ContainerManager after service discovery
     * Call this after ContainerManager.initialize() completes
     */
    updateUrlsFromManager(): void {
        const managerCallbackUrl = this.containerManager.getCallbackUrl();
        const managerMetaCoreUrl = this.containerManager.getMetaCoreUrl();

        if (managerCallbackUrl) {
            this.callbackUrl = managerCallbackUrl;
            console.log(`[ContainerPluginScheduler] Updated callback URL: ${this.callbackUrl}`);
        }

        if (managerMetaCoreUrl) {
            this.metaCoreUrl = managerMetaCoreUrl;
            console.log(`[ContainerPluginScheduler] Updated meta-core URL: ${this.metaCoreUrl}`);
        }
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
     * Note: Event publishing to meta-fuse is handled by meta-core (file:events stream)
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
     *
     * Tasks pass through the per-phase FileSlotGate before reaching PQueue:
     *   - If the file already holds a slot in this phase, the task goes
     *     straight to PQueue.
     *   - Otherwise the task is buffered, and the file's first task triggers
     *     a slot acquire. When the slot is granted, all buffered tasks for
     *     that file are flushed into PQueue.
     *
     * This caps concurrent files per phase (and therefore concurrent file
     * fetches against CORN/SMB) at the gate's capacity, regardless of how
     * many plugin tasks each file fans out to.
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

        // If adding to fast queue, pause background queue (fast takes priority)
        if (task.queue === 'fast' && !this.backgroundQueue.isPaused) {
            console.log('[ContainerScheduler] Fast task added, pausing background queue');
            this.backgroundQueue.pause();
        }

        const counterMap = task.queue === 'fast' ? this.lightTasksPerFile : this.bgTasksPerFile;
        const bufferMap = task.queue === 'fast' ? this.lightBufferedTasks : this.bgBufferedTasks;
        const gate = task.queue === 'fast' ? this.lightFileGate : this.bgFileGate;

        // Increment the per-file counter for this phase eagerly. Decrement
        // happens in the executeTask finally clause.
        counterMap.set(task.fileHash, (counterMap.get(task.fileHash) ?? 0) + 1);

        if (gate.holds(task.fileHash)) {
            // File already has a slot — dispatch immediately.
            this.dispatchToPQueue(task);
            return true;
        }

        // File doesn't hold a slot. Buffer the task. If this is the first
        // buffered task for the file, trigger gate.acquire and flush on grant.
        const existingBuffer = bufferMap.get(task.fileHash);
        if (existingBuffer) {
            existingBuffer.push(task);
            return true;
        }

        bufferMap.set(task.fileHash, [task]);
        gate.acquire(task.fileHash).then(() => {
            const buffered = bufferMap.get(task.fileHash) ?? [];
            bufferMap.delete(task.fileHash);
            for (const t of buffered) {
                this.dispatchToPQueue(t);
            }
            // Edge case: if every buffered task got cancelled by clear() before
            // the slot was granted, release immediately so the slot doesn't
            // leak.
            if (buffered.length === 0 && (counterMap.get(task.fileHash) ?? 0) === 0) {
                gate.release(task.fileHash);
            }
        });
        return true;
    }

    /**
     * Dispatch a task into the underlying PQueue and release its file's gate
     * slot when the file's last task in that phase finishes.
     */
    private dispatchToPQueue(task: ContainerTask): void {
        const queue = task.queue === 'background' ? this.backgroundQueue : this.fastQueue;
        queue.add(async () => {
            try {
                await this.executeTask(task);
            } finally {
                this.onTaskFinished(task);
            }
        });
    }

    /**
     * Bookkeeping after a task leaves PQueue (success, failure, or thrown).
     * Decrements the per-(file, phase) task counter and releases the gate
     * slot when the counter hits zero.
     */
    private onTaskFinished(task: ContainerTask): void {
        const counterMap = task.queue === 'fast' ? this.lightTasksPerFile : this.bgTasksPerFile;
        const currentMap = task.queue === 'fast' ? this.lightCurrentPlugin : this.bgCurrentPlugin;
        const gate = task.queue === 'fast' ? this.lightFileGate : this.bgFileGate;

        const remaining = (counterMap.get(task.fileHash) ?? 1) - 1;
        if (remaining <= 0) {
            counterMap.delete(task.fileHash);
            currentMap.delete(task.fileHash);
            gate.release(task.fileHash);
        } else {
            counterMap.set(task.fileHash, remaining);
            // Clear current-plugin only if it points at this completed task.
            if (currentMap.get(task.fileHash) === task.pluginId) {
                currentMap.delete(task.fileHash);
            }
        }
    }

    /**
     * Called when fast queue becomes idle - start background queue if it has work
     */
    private onFastQueueIdle(): void {
        console.log(`[ContainerScheduler] onFastQueueIdle: bgQueue.size=${this.backgroundQueue.size}, bgQueue.pending=${this.backgroundQueue.pending}, bgQueue.isPaused=${this.backgroundQueue.isPaused}`);
        if (this.backgroundQueue.size > 0 || this.backgroundQueue.pending > 0) {
            console.log('[ContainerScheduler] Fast queue idle, starting background queue');
            this.backgroundQueue.start();
        }
    }

    /**
     * Execute a task (dispatch to container)
     */
    private async executeTask(task: ContainerTask): Promise<void> {
        console.log(`[ContainerScheduler] executeTask: ${task.pluginId} for ${task.fileHash} (queue: ${task.queue})`);

        // Wait for dependencies to complete first
        if (task.dependencies && task.dependencies.length > 0) {
            task.status = 'waiting';
            await this.waitForDependencies(task.fileHash, task.dependencies);
        }

        const instance = this.containerManager.getHealthyInstance(task.pluginId);
        console.log(`[ContainerScheduler] getHealthyInstance(${task.pluginId}): ${instance ? instance.containerName : 'null'}`);

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

        // Record which plugin is currently running for this file (per phase)
        // so the dashboard can show the long-pole plugin per held cache slot.
        const currentMap = task.queue === 'fast' ? this.lightCurrentPlugin : this.bgCurrentPlugin;
        currentMap.set(task.fileHash, task.pluginId);

        this.emit('task:dispatched', { task });

        try {
            // Fetch fresh metadata after dependencies complete
            // This ensures we get metadata written by dependency plugins
            console.log(`[ContainerScheduler] Fetching metadata for ${task.fileHash}...`);
            const existingMeta = await this.fetchExistingMetadata(task.fileHash);
            console.log(`[ContainerScheduler] Dispatching to ${instance.baseUrl}/process for ${task.pluginId}`);

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
            console.log(`[ContainerScheduler] dispatchToContainer result for ${task.pluginId}: ${response.status}`);

            if (response.status !== 'accepted') {
                throw new Error(response.error || 'Task rejected by plugin');
            }

            // Wait for callback with timeout
            const manifest = instance.manifest;
            const timeout = manifest?.timeout ?? this.defaultTimeout;

            await this.waitForCallback(task, timeout);

        } catch (error) {
            console.error(`[ContainerScheduler] Task ${task.pluginId} failed:`, error);
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
     *
     * Note: Multiple files may share the same fileHash (e.g., duplicate files).
     * When this happens, we need to emit file:complete for EACH unique filePath.
     */
    private checkFileCompletion(fileHash: string): void {
        const taskIds = this.fileTasks.get(fileHash);
        if (!taskIds) {
            return;
        }

        let allComplete = true;
        const uniqueFilePaths = new Set<string>();

        for (const taskId of taskIds) {
            const task = this.pendingTasks.get(taskId);
            if (!task) {
                continue;
            }

            // Collect all unique filePaths that share this hash
            uniqueFilePaths.add(task.filePath);

            if (
                task.status !== 'completed' &&
                task.status !== 'failed' &&
                task.status !== 'timeout'
            ) {
                allComplete = false;
                break;
            }
        }

        if (allComplete && uniqueFilePaths.size > 0) {
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

            // Emit file:complete for EACH unique filePath (handles duplicate files with same hash)
            for (const filePath of uniqueFilePaths) {
                this.emit('file:complete', { fileHash, filePath });
            }
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
     * PQueue: .pending = running + waiting, .size = waiting only
     */
    getQueueStatus(): {
        fast: { pending: number; running: number; waiting: number };
        background: { pending: number; running: number; waiting: number };
        pendingTasks: number;
        pendingCallbacks: number;
        // File-level counts (what users care about)
        files: {
            fastRunning: number;      // unique files with fast tasks running
            fastWaiting: number;      // unique files with fast tasks waiting
            backgroundRunning: number; // unique files with background tasks running
            backgroundWaiting: number; // unique files with background tasks waiting
        };
        // Per-phase cache-slot view — bounded by FileSlotGate. This is the
        // metric operators actually care about: how many distinct files are
        // tying up the WebDAV cache right now, and which plugin is the
        // long-pole on each. `paused` reflects the underlying PQueue state so
        // the UI can distinguish "16 files reserved but bg PQueue paused"
        // from "16 files actively dispatching".
        cacheSlots: {
            fast: { capacity: number; inUse: number; waiting: number; paused: boolean; holders: CacheSlotHolder[] };
            background: { capacity: number; inUse: number; waiting: number; paused: boolean; holders: CacheSlotHolder[] };
        };
    } {
        // Count pending callbacks by queue type
        // These are tasks dispatched to containers awaiting completion - the real "running" count
        let fastCallbacks = 0;
        let backgroundCallbacks = 0;
        const fastRunningFiles = new Set<string>();
        const backgroundRunningFiles = new Set<string>();

        for (const callback of this.pendingCallbacks.values()) {
            if (callback.task.queue === 'fast') {
                fastCallbacks++;
                fastRunningFiles.add(callback.task.fileHash);
            } else {
                backgroundCallbacks++;
                backgroundRunningFiles.add(callback.task.fileHash);
            }
        }

        // Count unique files with waiting tasks
        const fastWaitingFiles = new Set<string>();
        const backgroundWaitingFiles = new Set<string>();

        for (const task of this.pendingTasks.values()) {
            if (task.status === 'pending') {
                if (task.queue === 'fast') {
                    // Only count as waiting if not already running
                    if (!fastRunningFiles.has(task.fileHash)) {
                        fastWaitingFiles.add(task.fileHash);
                    }
                } else {
                    if (!backgroundRunningFiles.has(task.fileHash)) {
                        backgroundWaitingFiles.add(task.fileHash);
                    }
                }
            }
        }

        // PQueue .size = waiting in queue, .pending = running + waiting
        // But PQueue "running" is just dispatching HTTP requests - actual running is callbacks
        return {
            fast: {
                pending: this.fastQueue.size + fastCallbacks, // waiting + running in containers
                running: fastCallbacks, // tasks running in containers
                waiting: this.fastQueue.size,
            },
            background: {
                pending: this.backgroundQueue.size + backgroundCallbacks, // waiting + running in containers
                running: backgroundCallbacks, // tasks running in containers
                waiting: this.backgroundQueue.size,
            },
            pendingTasks: this.pendingTasks.size,
            pendingCallbacks: this.pendingCallbacks.size,
            files: {
                fastRunning: fastRunningFiles.size,
                fastWaiting: fastWaitingFiles.size,
                backgroundRunning: backgroundRunningFiles.size,
                backgroundWaiting: backgroundWaitingFiles.size,
            },
            cacheSlots: {
                fast: this.snapshotCacheSlot('fast'),
                background: this.snapshotCacheSlot('background'),
            },
        };
    }

    /**
     * Build the per-phase cache-slot snapshot for the queue status payload.
     * `currentPlugin` is the plugin currently dispatched against the file
     * (the long-pole) — falls back to undefined if no task is mid-dispatch.
     * `tasksRemaining` is the count of light/bg tasks still outstanding for
     * the file in this phase, which is what holds the slot open.
     */
    private snapshotCacheSlot(
        phase: TaskQueueType
    ): { capacity: number; inUse: number; waiting: number; paused: boolean; holders: CacheSlotHolder[] } {
        const gate = phase === 'fast' ? this.lightFileGate : this.bgFileGate;
        const counterMap = phase === 'fast' ? this.lightTasksPerFile : this.bgTasksPerFile;
        const currentMap = phase === 'fast' ? this.lightCurrentPlugin : this.bgCurrentPlugin;
        const queue = phase === 'fast' ? this.fastQueue : this.backgroundQueue;

        const holders: CacheSlotHolder[] = gate.getHolders().map((fileHash) => {
            // Find any task for this file in this phase to recover filePath
            // (one filePath is enough for the UI; duplicates collapse).
            let filePath: string | undefined;
            const taskIds = this.fileTasks.get(fileHash);
            if (taskIds) {
                for (const tid of taskIds) {
                    const t = this.pendingTasks.get(tid);
                    if (t && t.queue === phase) {
                        filePath = t.filePath;
                        break;
                    }
                }
            }
            return {
                fileHash,
                filePath,
                currentPlugin: currentMap.get(fileHash),
                tasksRemaining: counterMap.get(fileHash) ?? 0,
            };
        });

        return {
            capacity: gate.capacity,
            inUse: gate.inUse(),
            waiting: gate.waiting(),
            paused: queue.isPaused,
            holders,
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

        // Drop file-slot-gate state. Tasks that were buffered or holding
        // slots are no longer interesting once we've cleared the queues; a
        // fresh scheduler state implies fresh gate state.
        this.lightTasksPerFile.clear();
        this.bgTasksPerFile.clear();
        this.lightBufferedTasks.clear();
        this.bgBufferedTasks.clear();
        this.lightCurrentPlugin.clear();
        this.bgCurrentPlugin.clear();
        for (const fileHash of this.lightFileGate.getHolders()) {
            this.lightFileGate.release(fileHash);
        }
        for (const fileHash of this.bgFileGate.getHolders()) {
            this.bgFileGate.release(fileHash);
        }
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
     * Note: Background queue only starts if fast queue is idle (fast queue has priority)
     */
    resume(): void {
        this.fastQueue.start();
        // Only start background if fast queue is empty
        if (this.fastQueue.size === 0 && this.fastQueue.pending === 0) {
            this.backgroundQueue.start();
        }
        // Otherwise, background will start when fast queue idle event fires
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
            (task as ExtendedContainerTask).existingMeta = existingMeta;

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
