/**
 * Plugin System
 *
 * Main entry point for the meta-sort container-based plugin system.
 * All plugins run as Docker containers - there is no local plugin execution.
 */

// Types
export type {
    // Manifest types
    ConfigFieldType,
    SchemaFieldType,
    SelectOption,
    ConfigField,
    SchemaField,
    PluginManifest,
    TaskQueueType,
    // State types
    PluginStateEntry,
    PluginState,
    PluginStatus,
    PluginInfo,
    // Context types
    PluginKVStore,
    PluginCache,
    PluginLogger,
    PluginLifecycleContext,
    PluginContext,
    // Plugin interface
    Plugin,
    // Internal types
    LoadedPlugin,
    PluginManagerEvent,
    // Task types
    PluginTaskStatus,
    PluginTaskResult,
    PluginTask,
    QueueStatus,
    TaskSchedulerEvent,
} from './types.js';

// Context implementations (KVStore is still used for local state)
export { KVStore, MetadataNodeKVStore } from './PluginContext.js';

// Dependency resolution utilities
export {
    resolveDependencyOrder,
    canActivate,
    canDeactivate,
} from './PluginExecutor.js';
export type { DependencyResolution } from './PluginExecutor.js';

// Plugin Manager
export { PluginManager, createPluginManager } from './PluginManager.js';
export type { PluginManagerOptions } from './PluginManager.js';

// Task Scheduler
export { TaskScheduler, createTaskScheduler } from './TaskScheduler.js';
export type { TaskSchedulerConfig } from './TaskScheduler.js';
