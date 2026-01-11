import dotenv from 'dotenv';
dotenv.config();

export interface PollingPathConfig {
    path: string;
    intervalMs: number;
}

interface EnvConfig {
    /** Comma-separated list of folders to watch for changes.(mandatory) */
    WATCH_FOLDER_LIST: string;

    /** Path to the index file within the NFO CID library. */
    INDEX_FOLDER_PATH: string;

    /** Interval in milliseconds to update/check for changes. (default 30000) */
    UPDATE_INTERVAL_MS: number;

    /** Interval in milliseconds for polling watch folders. Set to 0 to disable polling. (default 0) */
    WATCH_FOLDER_POOLING_INTERVAL_MS: number;

    /** CHMOD for new folder format (default 0o777) */
    CHMOD_FOR_NEW_FOLDER: number;

    /** Path to the cache folder. */
    CACHE_FOLDER_PATH: string;

    /** jellyfin */
    JELLYFIN_ENDPOINT: string;
    JELLYFIN_API_KEY: string;

    /** FUSE API server port (default 3000) */
    FUSE_API_PORT: number;

    /** FUSE API server host (default 'localhost') */
    FUSE_API_HOST: string;

    /** Comma-separated list of metadata formats to generate in virtual filesystem (default 'meta'). Options: 'meta' (.meta YAML files), 'jellyfin' (.nfo XML files). Example: 'meta,jellyfin' or 'jellyfin' or '' (no metadata files) */
    METADATA_FORMATS: string[];

    /** Maximum number of worker threads for Piscina worker pool AND max concurrent file processing (default: CPU count) */
    MAX_WORKER_THREADS?: number;

    /** JSON array of polling path configurations. Example: '[{"path": "/data/watch/smb/downloads", "intervalMs": 60000}]' (optional) */
    POLLING_PATHS?: PollingPathConfig[];

    // ========================================================================
    // KV Storage Configuration (NEW)
    // ========================================================================

    /** Path to META_CORE_VOLUME - infrastructure volume for KV DB, locks, services (default '/meta-core') */
    META_CORE_PATH: string;

    /** Path to FILES_VOLUME - shared media volume (default '/files') */
    FILES_PATH: string;

    /** Service name for leader election and service discovery (default 'meta-sort') */
    SERVICE_NAME: string;

    /** Service version (default '1.0.0') */
    SERVICE_VERSION: string;

    /** Redis port (default 6379) */
    REDIS_PORT: number;

    /** Direct Redis URL (skip leader election if provided) */
    REDIS_URL?: string;

    /** Base URL for service discovery (e.g., 'http://localhost:3000' or 'http://meta-sort:80') */
    BASE_URL?: string;

    /**
     * Hostname to advertise in lock file for other services to connect.
     * Use Docker service name (e.g., 'meta-sort-dev') for stable DNS resolution.
     * If not set, auto-detects local IP (may be unstable across container restarts).
     */
    ADVERTISE_HOST?: string;

    // ========================================================================
    // TaskScheduler Configuration (Plugin Queue System)
    // ========================================================================

    /** Concurrency for fast plugin queue (plugins with <1s avg execution time). Default: 32 */
    FAST_QUEUE_CONCURRENCY: number;

    /** Concurrency for background plugin queue (plugins with >=1s avg execution time). Default: 8 */
    BACKGROUND_QUEUE_CONCURRENCY: number;

    /** Threshold in ms to classify plugin as fast vs background. Default: 1000 */
    FAST_THRESHOLD_MS: number;

    /** Minimum samples before using measured timing for classification. Default: 10 */
    MIN_SAMPLES_FOR_MEASUREMENT: number;

    // ========================================================================
    // Container Plugins Configuration
    // All plugins run as Docker containers for isolation and flexibility
    // ========================================================================

    /** Path to container plugins config file (default: '/app/plugins.yml') */
    CONTAINER_PLUGINS_CONFIG: string;

    /** Docker socket path (default: '/var/run/docker.sock') */
    DOCKER_SOCKET_PATH: string;

    /** Callback URL for container plugins (default: 'http://meta-sort:8180') */
    CONTAINER_CALLBACK_URL: string;

    /** meta-core URL for container plugins (default: 'http://meta-sort:9000') */
    CONTAINER_META_CORE_URL: string;

    /** Docker network for plugin containers (default: 'meta-network') */
    CONTAINER_NETWORK: string;

    /**
     * Plugin file mounts - maps subpaths to host paths for /files in plugin containers.
     * Format: "subpath:host_path,subpath2:host_path2"
     * Example: "watch:/data/media,test:/app/test/media"
     * Results in /files/watch and /files/test mounted in plugin containers (read-only).
     */
    PLUGIN_FILE_MOUNTS?: string;

    /** Host path for plugin cache folder - each plugin gets its own subdirectory at /cache (optional, dev only) */
    PLUGIN_CACHE_FOLDER?: string;

    /**
     * Host path for plugin output folders - each plugin gets /files/plugin/<id> mount (READ-WRITE)
     * Plugins decide whether to use this folder - we always mount it if this env is set
     */
    PLUGIN_OUTPUT_FOLDER?: string;

    /** Docker Compose project name for grouping containers in Docker Desktop (optional). When set, plugin containers appear grouped as a stack. */
    PLUGIN_STACK_NAME?: string;
}

// Parse POLLING_PATHS from JSON string
function parsePollingPaths(): PollingPathConfig[] | undefined {
    if (!process.env.POLLING_PATHS) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(process.env.POLLING_PATHS);
        if (!Array.isArray(parsed)) {
            console.error('POLLING_PATHS must be a JSON array');
            return undefined;
        }

        // Validate structure
        const valid = parsed.every(item =>
            item && typeof item === 'object' &&
            typeof item.path === 'string' &&
            typeof item.intervalMs === 'number'
        );

        if (!valid) {
            console.error('POLLING_PATHS entries must have {path: string, intervalMs: number}');
            return undefined;
        }

        return parsed as PollingPathConfig[];
    } catch (error) {
        console.error('Failed to parse POLLING_PATHS:', error);
        return undefined;
    }
}

export const config: EnvConfig = {
    WATCH_FOLDER_LIST: process.env.WATCH_FOLDER_LIST,
    INDEX_FOLDER_PATH: process.env.INDEX_FOLDER_PATH || '/data/cache/hash',//default /data/cache/hash
    UPDATE_INTERVAL_MS: parseInt(process.env.UPDATE_INTERVAL_MS || "30000", 10),//default 30000
    WATCH_FOLDER_POOLING_INTERVAL_MS: parseInt(process.env.WATCH_FOLDER_POOLING_INTERVAL_MS || "0", 10),//default 0
    CHMOD_FOR_NEW_FOLDER: process.env.CHMOD_FOR_NEW_FOLDER && parseInt(process.env.CHMOD_FOR_NEW_FOLDER, 8),//default 0o777 (this is the default for mkdir)
    CACHE_FOLDER_PATH: process.env.CACHE_FOLDER_PATH || '/data/cache/plugins',//default /data/cache/plugins
    JELLYFIN_ENDPOINT: process.env.JELLYFIN_ENDPOINT!,
    JELLYFIN_API_KEY: process.env.JELLYFIN_API_KEY!,
    FUSE_API_PORT: parseInt(process.env.FUSE_API_PORT || "3000", 10),//default 3000
    FUSE_API_HOST: process.env.FUSE_API_HOST || 'localhost',//default localhost
    METADATA_FORMATS: (process.env.METADATA_FORMATS || 'meta').split(',').map(f => f.trim()).filter(f => f.length > 0),//default 'meta'
    MAX_WORKER_THREADS: process.env.MAX_WORKER_THREADS ? parseInt(process.env.MAX_WORKER_THREADS, 10) : undefined,
    POLLING_PATHS: parsePollingPaths(),

    // KV Storage Configuration
    META_CORE_PATH: process.env.META_CORE_PATH || '/meta-core',
    FILES_PATH: process.env.FILES_PATH || '/files',
    SERVICE_NAME: process.env.SERVICE_NAME || 'meta-sort',
    SERVICE_VERSION: process.env.SERVICE_VERSION || '1.0.0',
    REDIS_PORT: parseInt(process.env.REDIS_PORT || "6379", 10),
    REDIS_URL: process.env.REDIS_URL,
    BASE_URL: process.env.BASE_URL,
    ADVERTISE_HOST: process.env.ADVERTISE_HOST,

    // TaskScheduler Configuration
    FAST_QUEUE_CONCURRENCY: parseInt(process.env.FAST_QUEUE_CONCURRENCY || "32", 10),
    BACKGROUND_QUEUE_CONCURRENCY: parseInt(process.env.BACKGROUND_QUEUE_CONCURRENCY || "8", 10),
    FAST_THRESHOLD_MS: parseInt(process.env.FAST_THRESHOLD_MS || "1000", 10),
    MIN_SAMPLES_FOR_MEASUREMENT: parseInt(process.env.MIN_SAMPLES_FOR_MEASUREMENT || "10", 10),

    // Container Plugins Configuration
    CONTAINER_PLUGINS_CONFIG: process.env.CONTAINER_PLUGINS_CONFIG || '/app/plugins.yml',
    DOCKER_SOCKET_PATH: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    CONTAINER_CALLBACK_URL: process.env.CONTAINER_CALLBACK_URL || 'http://meta-sort:8180',
    CONTAINER_META_CORE_URL: process.env.CONTAINER_META_CORE_URL || 'http://meta-sort:9000',
    CONTAINER_NETWORK: process.env.CONTAINER_NETWORK || 'meta-network',
    PLUGIN_FILE_MOUNTS: process.env.PLUGIN_FILE_MOUNTS,
    PLUGIN_CACHE_FOLDER: process.env.PLUGIN_CACHE_FOLDER,
    PLUGIN_OUTPUT_FOLDER: process.env.PLUGIN_OUTPUT_FOLDER,
    PLUGIN_STACK_NAME: process.env.PLUGIN_STACK_NAME,
};

if(process.env.TEST!=='true') {
    if (!config.WATCH_FOLDER_LIST) {
        console.error('Invalid configuration: WATCH_FOLDER_LIST is required');
    }
}

