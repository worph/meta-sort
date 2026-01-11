/**
 * Plugin System Type Definitions
 *
 * This module defines all types for the meta-sort plugin system.
 */

// =============================================================================
// Plugin Manifest Types
// =============================================================================

/**
 * Configuration field type in manifest
 */
export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'select';

/**
 * Schema field type for editor UI
 */
export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'text' | 'array' | 'json' | 'cid' | 'languageString';

/**
 * Select option for config/schema fields
 */
export interface SelectOption {
    value: string;
    label: string;
}

/**
 * Configuration field definition in manifest
 */
export interface ConfigField {
    type: ConfigFieldType;
    label?: string;
    required?: boolean;
    default?: unknown;
    secret?: boolean;
    options?: SelectOption[];
}

/**
 * Metadata schema field definition (for editor UI)
 */
export interface SchemaField {
    /** Display label */
    label: string;
    /** Field type for form control */
    type?: SchemaFieldType;
    /** Read-only field (not editable) */
    readonly?: boolean;
    /** Whether field is indexed (has {n} pattern) */
    indexed?: boolean;
    /** Options for select type */
    options?: SelectOption[];
    /** Hint text shown below field */
    hint?: string;
    /** URL template for clickable values (use {value} as placeholder) */
    link?: string;
    /** Pattern for JSON type to aggregate matching keys */
    pattern?: string;
    /** Minimum value for number type */
    min?: number;
    /** Maximum value for number type */
    max?: number;
    /** Placeholder text */
    placeholder?: string;
}

/**
 * Task queue type for plugin classification
 */
export type TaskQueueType = 'fast' | 'background';

/**
 * Plugin manifest (parsed from manifest.yml)
 */
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    /** Plugin author */
    author?: string;
    /** Display priority (lower = higher priority) */
    priority?: number;
    /** Color for UI display */
    color?: string;
    dependencies?: string[];
    config?: Record<string, ConfigField>;
    schema?: Record<string, SchemaField>;
    /**
     * Default queue for this plugin.
     * - 'fast': High concurrency queue for quick operations (<1s)
     * - 'background': Low concurrency queue for slow operations (>=1s)
     * Default: 'fast'
     */
    defaultQueue?: TaskQueueType;
}

// =============================================================================
// Plugin State Types
// =============================================================================

/**
 * Plugin state entry (stored in plugins.json)
 */
export interface PluginStateEntry {
    active: boolean;
    config: Record<string, unknown>;
}

/**
 * Complete plugin state file structure
 */
export interface PluginState {
    plugins: Record<string, PluginStateEntry>;
}

/**
 * Plugin status
 */
export type PluginStatus = 'loaded' | 'error' | 'unloaded';

/**
 * Plugin info (runtime representation)
 */
export interface PluginInfo {
    id: string;
    name: string;
    version: string;
    description?: string;
    /** Display priority (lower = higher priority) */
    priority?: number;
    /** Color for UI display */
    color?: string;
    dependencies: string[];
    active: boolean;
    config: Record<string, unknown>;
    configSchema?: Record<string, ConfigField>;
    metadataSchema?: Record<string, SchemaField>;
    status: PluginStatus;
    error?: string;
    /** True if this is a containerized plugin */
    isContainer?: boolean;
}

// =============================================================================
// Plugin Context Types (injected into plugins)
// =============================================================================

/**
 * Key-value store for file metadata
 */
export interface PluginKVStore {
    /**
     * Get a value by key
     * @param key Path-style key, e.g., "video/codec" or "audio/0/language"
     */
    get(key: string): string | undefined;

    /**
     * Set a value. Only string values are supported.
     * @param key Path-style key
     * @param value String value
     */
    set(key: string, value: string): void;

    /**
     * Delete a key
     */
    delete(key: string): void;

    /**
     * Get all keys, optionally filtered by prefix
     * @param prefix Optional prefix filter, e.g., "audio/"
     */
    keys(prefix?: string): string[];

    /**
     * Get all key-value pairs, optionally filtered by prefix
     */
    entries(prefix?: string): Array<[string, string]>;

    /**
     * Add a value to a set (for RecordSet fields like genres, tags).
     * Optional - only available with MetadataNodeKVStore.
     */
    add?(key: string, value: string): void;

    /**
     * Get the full object at a path (for inspecting nested structures).
     * Optional - only available with MetadataNodeKVStore.
     */
    getObject?(key: string): any;
}

/**
 * Cache utilities for persistent plugin storage
 */
export interface PluginCache {
    /**
     * Get full path for a cache file
     * @param filename Relative filename within cache directory
     */
    getPath(filename: string): string;

    /**
     * Read and parse a JSON cache file
     * @returns Parsed data or null if not found
     */
    readJson<T>(filename: string): Promise<T | null>;

    /**
     * Write data as JSON to cache file
     */
    writeJson(filename: string, data: unknown): Promise<void>;

    /**
     * Check if a cache file exists
     */
    exists(filename: string): Promise<boolean>;

    /**
     * Delete a cache file
     */
    delete(filename: string): Promise<void>;

    /**
     * Clear all files in the plugin's cache directory
     */
    clear(): Promise<void>;
}

/**
 * Logger interface for plugins
 */
export interface PluginLogger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/**
 * Context passed to plugin lifecycle hooks
 */
export interface PluginLifecycleContext {
    /** Plugin configuration from plugins.json */
    config: Record<string, unknown>;
    /** Absolute path to plugin's cache directory */
    cacheDir: string;
    /** Scoped logger */
    log: PluginLogger;
}

/**
 * Context passed to plugin process function
 */
export interface PluginContext extends PluginLifecycleContext {
    /** Key-value storage for the current file's metadata */
    kv: PluginKVStore;
    /** Absolute path to the file being processed */
    filePath: string;
    /** Cache utilities for persistent storage */
    cache: PluginCache;
    /**
     * Direct access to MetadataNode for plugins that need it.
     * Use this for compatibility with existing libraries that expect MetadataNode.
     * Only available when using MetadataNodeKVStore.
     */
    metadata?: any;
}

// =============================================================================
// Plugin Interface
// =============================================================================

/**
 * Plugin interface that all plugins must implement
 */
export interface Plugin {
    /**
     * Called once when the plugin is loaded at startup.
     * Use for one-time initialization.
     */
    onLoad?(ctx: PluginLifecycleContext): Promise<void>;

    /**
     * Called when the plugin is activated.
     * Triggered at startup (if previously active) or from dashboard.
     */
    onActivate?(ctx: PluginLifecycleContext): Promise<void>;

    /**
     * Called when the plugin is deactivated from the dashboard.
     * Use for cleanup, releasing resources.
     */
    onDeactivate?(ctx: PluginLifecycleContext): Promise<void>;

    /**
     * Called when the plugin is unloaded at shutdown.
     */
    onUnload?(ctx: PluginLifecycleContext): Promise<void>;

    /**
     * Process a single file. Called for each file in the library.
     * Must be implemented by all plugins.
     */
    process(ctx: PluginContext): Promise<void>;
}

// =============================================================================
// Plugin Manager Types
// =============================================================================

/**
 * Loaded plugin internal representation
 */
export interface LoadedPlugin {
    manifest: PluginManifest;
    instance: Plugin;
    status: PluginStatus;
    error?: string;
    pluginDir: string;
}

/**
 * Processing result for a single file
 */
export interface ProcessingResult {
    success: boolean;
    timings: Record<string, number>;
    errors: Array<{ pluginId: string; error: string }>;
}

/**
 * Plugin manager events
 */
export type PluginManagerEvent =
    | { type: 'plugin:activated'; pluginId: string }
    | { type: 'plugin:deactivated'; pluginId: string }
    | { type: 'plugin:config-changed'; pluginId: string; config: Record<string, unknown> }
    | { type: 'plugin:error'; pluginId: string; error: Error };

// =============================================================================
// Plugin Task Types (for TaskScheduler)
// =============================================================================

/**
 * Status of a plugin task
 */
export type PluginTaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed';

/**
 * Result of a plugin task execution
 */
export interface PluginTaskResult {
    success: boolean;
    timeMs: number;
    /** KV updates to apply (key-value pairs) */
    kvUpdates?: Record<string, string>;
    error?: string;
}

/**
 * Plugin task representing a single plugin execution for a file
 */
export interface PluginTask {
    /** Unique task ID: `${fileHash}:${pluginId}` */
    id: string;
    /** File identity hash (midhash256) */
    fileHash: string;
    /** Absolute path to the file */
    filePath: string;
    /** Plugin to execute */
    pluginId: string;
    /** Plugin IDs this task depends on */
    dependencies: string[];
    /** Target queue (from classification) */
    queue: TaskQueueType;
    /** Priority based on avg execution time (lower = higher priority) */
    priority: number;
    /** Estimated execution time in ms (from performanceMetrics) */
    estimatedTimeMs: number;
    /** Current task status */
    status: PluginTaskStatus;
    /** Timestamp when task was created */
    createdAt: number;
    /** Timestamp when task started executing */
    startedAt?: number;
    /** Timestamp when task completed */
    completedAt?: number;
    /** Execution result */
    result?: PluginTaskResult;
    /** Runtime options merged into plugin config (e.g., forceRecompute) */
    options?: Record<string, unknown>;
}

/**
 * Queue status information
 */
export interface QueueStatus {
    /** Number of tasks pending (waiting for dependencies) */
    pending: number;
    /** Number of tasks ready (in queue, waiting for worker) */
    ready: number;
    /** Number of tasks currently running */
    running: number;
    /** Number of tasks completed */
    completed: number;
    /** Number of tasks failed */
    failed: number;
    /** Whether the queue is currently paused */
    isPaused: boolean;
}

/**
 * Task scheduler events
 */
export type TaskSchedulerEvent =
    | { type: 'task:created'; task: PluginTask }
    | { type: 'task:ready'; task: PluginTask }
    | { type: 'task:started'; task: PluginTask }
    | { type: 'task:complete'; task: PluginTask }
    | { type: 'task:failed'; task: PluginTask; error: string }
    | { type: 'file:complete'; fileHash: string; filePath: string }
    | { type: 'queue:fast:idle' }
    | { type: 'queue:background:started' }
    | { type: 'queue:background:paused' };
