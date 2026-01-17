/**
 * Container Plugin System Type Definitions
 *
 * Types for containerized plugins that run in Docker containers
 * and communicate via HTTP APIs.
 */

import type { ConfigField, SchemaField, TaskQueueType } from '../plugin-engine/types.js';

// =============================================================================
// Plugin Configuration (stored in plugins.yml)
// =============================================================================

/**
 * Resource limits for a container plugin
 */
export interface ContainerResourceLimits {
    /** Memory limit (e.g., '512m', '2g') */
    memory?: string;
    /** CPU limit (e.g., 1.0, 2.5) */
    cpus?: number;
}

/**
 * Volume mount configuration
 */
export interface ContainerMount {
    /** Source path (relative to FILES_PATH) */
    source: string;
    /** Target path inside container */
    target: string;
    /** Mount as read-only (default: true) */
    readonly?: boolean;
}

/**
 * Health check configuration
 */
export interface ContainerHealthCheck {
    /** Health check interval (e.g., '30s', '1m') */
    interval?: string;
    /** Health check timeout (e.g., '5s') */
    timeout?: string;
    /** Number of retries before marking unhealthy */
    retries?: number;
}

/**
 * Single container plugin configuration (from plugins.yml)
 */
export interface ContainerPluginConfig {
    /** Whether this plugin is enabled */
    enabled?: boolean;
    /** Docker image name and tag */
    image: string;
    /** Number of container instances to spawn (default: 1) */
    instances?: number;
    /** Resource limits */
    resources?: ContainerResourceLimits;
    /** Plugin configuration values (sent to /configure endpoint) */
    config?: Record<string, unknown>;
    /** Whether plugin needs external network access (default: false) */
    network?: boolean;
    /** Additional volume mounts */
    mounts?: ContainerMount[];
    /** Health check settings */
    healthCheck?: ContainerHealthCheck;
    /** Default queue override (normally from manifest) */
    defaultQueue?: TaskQueueType;
}

/**
 * Root configuration file structure (plugins.yml)
 */
export interface ContainerPluginsConfig {
    /** Config version */
    version?: string;
    /** Plugin configurations keyed by plugin ID */
    plugins: Record<string, ContainerPluginConfig>;
}

// =============================================================================
// Plugin Manifest (returned by plugin container via GET /manifest)
// =============================================================================

/**
 * File filter criteria for plugin
 */
export interface PluginFileFilter {
    /** MIME type patterns (e.g., 'video/*', 'image/jpeg') */
    mimeTypes?: string[];
    /** File extension patterns (e.g., 'mkv', 'mp4') */
    extensions?: string[];
    /** Minimum file size in bytes */
    minSize?: number;
    /** Maximum file size in bytes */
    maxSize?: number;
}

/**
 * UI display hints
 */
export interface PluginUIConfig {
    /** Color for UI display (e.g., '#4CAF50') */
    color?: string;
    /** Icon name (optional) */
    icon?: string;
}

/**
 * Container plugin manifest (from GET /manifest)
 */
export interface ContainerPluginManifest {
    /** Unique plugin identifier */
    id: string;
    /** Human-readable name */
    name: string;
    /** Semantic version */
    version: string;
    /** Description */
    description?: string;
    /** Author or organization */
    author?: string;
    /** Source repository URL */
    repository?: string;

    /** Execution priority (lower = runs earlier, 10-100 range) */
    priority?: number;
    /** Default queue assignment */
    defaultQueue?: TaskQueueType;
    /** Max processing time in milliseconds */
    timeout?: number;

    /** Plugin IDs that must complete before this one */
    dependencies?: string[];

    /** File filter criteria */
    filter?: PluginFileFilter;

    /** Configuration schema (aliased as config for compatibility) */
    config?: Record<string, ConfigField>;
    /** Metadata output schema (aliased as schema for compatibility) */
    schema?: Record<string, SchemaField>;

    /** UI display color */
    color?: string;

    /** UI display hints */
    ui?: PluginUIConfig;
}

// =============================================================================
// Container Plugin Instance (runtime state)
// =============================================================================

/**
 * Container instance status
 */
export type ContainerInstanceStatus = 'starting' | 'healthy' | 'unhealthy' | 'stopped' | 'error';

/**
 * Runtime state of a container plugin instance
 */
export interface ContainerPluginInstance {
    /** Plugin ID */
    pluginId: string;
    /** Docker container ID */
    containerId: string;
    /** Container name (e.g., 'meta-plugin-ffmpeg-0') */
    containerName: string;
    /** HTTP base URL (e.g., 'http://meta-plugin-ffmpeg-0:8080') */
    baseUrl: string;
    /** Instance index (0, 1, 2, ...) */
    instanceIndex: number;
    /** Current status */
    status: ContainerInstanceStatus;
    /** Cached manifest from container */
    manifest?: ContainerPluginManifest;
    /** Last successful health check timestamp */
    lastHealthCheck?: number;
    /** Last error message */
    lastError?: string;
    /** Number of tasks processed */
    tasksProcessed: number;
    /** Number of failed tasks */
    tasksFailed: number;
}

// =============================================================================
// Plugin HTTP API Types
// =============================================================================

/**
 * Health check response from GET /health
 */
export interface PluginHealthResponse {
    status: 'healthy' | 'unhealthy';
    ready: boolean;
    version: string;
    message?: string;
}

/**
 * Configure request body for POST /configure
 */
export interface PluginConfigureRequest {
    config: Record<string, unknown>;
}

/**
 * Configure response from POST /configure
 */
export interface PluginConfigureResponse {
    success: boolean;
    error?: string;
}

/**
 * Process request body for POST /process
 */
export interface PluginProcessRequest {
    /** Unique task identifier */
    taskId: string;
    /** Content identifier (midhash256) */
    cid: string;
    /** Absolute path to file in container */
    filePath: string;
    /** Callback URL for completion notification */
    callbackUrl: string;
    /** meta-core API base URL */
    metaCoreUrl: string;
    /** Current metadata (flat key-value map) */
    existingMeta: Record<string, string>;
}

/**
 * Process response from POST /process (immediate)
 */
export interface PluginProcessResponse {
    status: 'accepted' | 'rejected';
    taskId: string;
    error?: string;
}

/**
 * Callback status
 */
export type CallbackStatus = 'completed' | 'failed' | 'skipped';

/**
 * Callback payload sent by plugin to meta-sort
 */
export interface PluginCallbackPayload {
    /** Task identifier */
    taskId: string;
    /** Plugin ID */
    pluginId: string;
    /** Content identifier */
    cid: string;
    /** Task status */
    status: CallbackStatus;
    /** Processing duration in milliseconds */
    duration: number;
    /** Error message (if status is 'failed') */
    error?: string;
    /** Skip reason (if status is 'skipped') */
    reason?: string;
}

// =============================================================================
// Container Manager Types
// =============================================================================

/**
 * Options for spawning a container
 */
export interface ContainerSpawnOptions {
    /** Docker image */
    image: string;
    /** Container name */
    name: string;
    /** Environment variables */
    env?: Record<string, string>;
    /** Resource limits */
    resources?: ContainerResourceLimits;
    /** Volume mounts (bind mounts only - files accessed via WebDAV) */
    mounts?: Array<{
        source: string;
        target: string;
        readonly?: boolean;
    }>;
    /** Docker network to join */
    network?: string;
    /** Labels for the container */
    labels?: Record<string, string>;
    /** Stack name for grouping containers in Docker Desktop (adds compose labels) */
    stackName?: string;
    /** Service name for compose grouping (usually the plugin ID) */
    serviceName?: string;
}

/**
 * Container manager status
 */
export interface ContainerManagerStatus {
    /** Whether manager is initialized */
    initialized: boolean;
    /** Total number of plugin types */
    pluginCount: number;
    /** Total running containers */
    runningContainers: number;
    /** Healthy containers */
    healthyContainers: number;
    /** Per-plugin status */
    plugins: Array<{
        pluginId: string;
        enabled: boolean;
        image: string;
        instances: number;
        healthyInstances: number;
        manifest?: ContainerPluginManifest;
    }>;
}

// =============================================================================
// Container Task Types
// =============================================================================

/**
 * Container task status
 */
export type ContainerTaskStatus = 'pending' | 'waiting' | 'dispatched' | 'processing' | 'completed' | 'failed' | 'timeout';

/**
 * Container plugin task
 */
export interface ContainerTask {
    /** Unique task ID (UUID) */
    id: string;
    /** File hash (midhash256) */
    fileHash: string;
    /** File path */
    filePath: string;
    /** Target plugin ID */
    pluginId: string;
    /** Plugin dependencies */
    dependencies: string[];
    /** Task queue */
    queue: TaskQueueType;
    /** Task status */
    status: ContainerTaskStatus;
    /** Timestamp when created */
    createdAt: number;
    /** Timestamp when dispatched to container */
    dispatchedAt?: number;
    /** Timestamp when completed */
    completedAt?: number;
    /** Container instance that processed this task */
    instanceName?: string;
    /** Processing duration in ms */
    duration?: number;
    /** Error message if failed */
    error?: string;
}
