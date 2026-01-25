import dotenv from 'dotenv';
dotenv.config();

interface EnvConfig {
    /** Path to the index file within the NFO CID library. */
    INDEX_FOLDER_PATH: string;

    /** Interval in milliseconds to update/check for changes. (default 30000) */
    UPDATE_INTERVAL_MS: number;

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

    // ========================================================================
    // KV Storage Configuration
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

    /** Concurrency for fast plugin queue. Default: 32 */
    FAST_QUEUE_CONCURRENCY: number;

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
     * WebDAV URL for plugin file access.
     * Plugins access /files via this WebDAV endpoint served by meta-sort nginx.
     * Example: "http://meta-sort-dev/webdav"
     */
    PLUGIN_WEBDAV_URL?: string;

    /** Docker Compose project name for grouping containers in Docker Desktop (optional). When set, plugin containers appear grouped as a stack. */
    PLUGIN_STACK_NAME?: string;

    /**
     * Host path for plugin cache folders.
     * This is the actual host filesystem path that plugin containers will mount.
     * Required for persistent plugin caches across container restarts.
     * Example: "/d/workspace/MetaMesh/meta-root-v2/dev/cache/meta-sort/plugin-cache"
     */
    PLUGIN_CACHE_HOST_PATH?: string;

    // NOTE: Plugin output files are written via WebDAV (WEBDAV_URL/plugin/<pluginId>/)
    // No PLUGIN_OUTPUT_HOST_PATH needed - plugins use HTTP PUT to write files

    // ========================================================================
    // Event Subscriber Configuration (Architecture V3)
    // ========================================================================

    /**
     * URL of meta-core API for event subscription (SSE).
     * REQUIRED: meta-sort receives file events from meta-core via SSE.
     * Example: "http://meta-core" or "http://localhost:8083"
     */
    META_CORE_URL?: string;
}

export const config: EnvConfig = {
    INDEX_FOLDER_PATH: process.env.INDEX_FOLDER_PATH || '/data/cache/hash-index',
    UPDATE_INTERVAL_MS: parseInt(process.env.UPDATE_INTERVAL_MS || "30000", 10),
    CHMOD_FOR_NEW_FOLDER: process.env.CHMOD_FOR_NEW_FOLDER && parseInt(process.env.CHMOD_FOR_NEW_FOLDER, 8),
    CACHE_FOLDER_PATH: process.env.CACHE_FOLDER_PATH || '/data/cache',
    JELLYFIN_ENDPOINT: process.env.JELLYFIN_ENDPOINT!,
    JELLYFIN_API_KEY: process.env.JELLYFIN_API_KEY!,
    FUSE_API_PORT: parseInt(process.env.FUSE_API_PORT || "3000", 10),
    FUSE_API_HOST: process.env.FUSE_API_HOST || '0.0.0.0',
    METADATA_FORMATS: (process.env.METADATA_FORMATS || 'meta').split(',').map(f => f.trim()).filter(f => f.length > 0),
    MAX_WORKER_THREADS: process.env.MAX_WORKER_THREADS ? parseInt(process.env.MAX_WORKER_THREADS, 10) : undefined,

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

    // Container Plugins Configuration
    CONTAINER_PLUGINS_CONFIG: process.env.CONTAINER_PLUGINS_CONFIG || '/app/plugins.yml',
    DOCKER_SOCKET_PATH: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    CONTAINER_CALLBACK_URL: process.env.CONTAINER_CALLBACK_URL || 'http://meta-sort:8180',
    CONTAINER_META_CORE_URL: process.env.CONTAINER_META_CORE_URL || 'http://meta-sort:9000',
    CONTAINER_NETWORK: process.env.CONTAINER_NETWORK || 'meta-network',
    PLUGIN_WEBDAV_URL: process.env.PLUGIN_WEBDAV_URL,
    PLUGIN_STACK_NAME: process.env.PLUGIN_STACK_NAME,
    PLUGIN_CACHE_HOST_PATH: process.env.PLUGIN_CACHE_HOST_PATH,

    // Event Subscriber Configuration
    META_CORE_URL: process.env.META_CORE_URL,
};
