/**
 * KV Client Interface - Abstraction layer for key-value storage
 *
 * Redis-based key-value storage with nested key architecture.
 * Uses property-level granularity for efficient updates.
 *
 * Key Structure:
 * /file/{hashId}/{property/path} → value
 *
 * Example:
 * /file/midhash256:abc123/title → "Inception"
 * /file/midhash256:abc123/video/codec → "h265"
 */

export interface KeyValuePair {
    key: string;
    value: string;
}

export interface IKVClient {
    // ========================================================================
    // Basic Operations
    // ========================================================================

    /**
     * Set a key-value pair (value is JSON serialized)
     */
    set(key: string, value: any): Promise<void>;

    /**
     * Get a value by key (value is JSON deserialized)
     */
    get(key: string): Promise<any | null>;

    /**
     * Delete a key
     */
    delete(key: string): Promise<void>;

    /**
     * Count keys with a given prefix
     */
    countKeysWithPrefix(prefix: string): Promise<number>;

    /**
     * Health check - verifies KV store is accessible
     */
    health(): Promise<boolean>;

    // ========================================================================
    // Nested Key Architecture Methods
    // ========================================================================

    /**
     * Set a single property value (raw string, not JSON)
     */
    setProperty(key: string, value: string): Promise<void>;

    /**
     * Get a single property value (raw string)
     */
    getProperty(key: string): Promise<string | null>;

    /**
     * Get all key-value pairs with a given prefix
     */
    getRange(prefix: string): Promise<KeyValuePair[]>;

    /**
     * Set multiple key-value pairs atomically (or as close as possible)
     */
    setMultiple(pairs: KeyValuePair[]): Promise<void>;

    /**
     * Delete all keys with a given prefix
     */
    deleteRange(prefix: string): Promise<number>;

    // ========================================================================
    // High-Level Metadata Operations
    // ========================================================================

    /**
     * Store file metadata using nested key architecture
     * Flattens the metadata object and stores each property as a separate key
     */
    setMetadataFlat(hashId: string, metadata: any, excludeFields?: string[]): Promise<void>;

    /**
     * Retrieve file metadata - reconstructs from individual property keys
     */
    getMetadataFlat(hashId: string): Promise<any | null>;

    /**
     * Get a specific property from a file's metadata
     */
    getMetadata(hashId: string, propertyPath: string): Promise<any | null>;

    /**
     * Set a single metadata property for a file (writes to Redis Hash)
     */
    setMetadataProperty(hashId: string, property: string, value: string): Promise<void>;

    /**
     * Delete all metadata for a file
     */
    deleteMetadataFlat(hashId: string): Promise<number>;

    /**
     * Get all unique hash IDs (files) stored in KV
     */
    getAllHashIds(): Promise<string[]>;

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Close connections and cleanup resources
     */
    close(): Promise<void>;
}

/**
 * KV Client configuration
 */
export interface KVClientConfig {
    /** Backend type */
    type: 'redis';

    /** Connection URL (e.g., redis://localhost:6379) */
    url: string;

    /** Operation timeout in ms (default: 30000) */
    timeout?: number;

    /** Key prefix for all operations (default: '' for none) */
    prefix?: string;
}

/**
 * Leader lock file content format (kv-leader.info)
 * Written by meta-core leader, read by other services
 */
export interface LeaderLockInfo {
    /** Hostname of the leader */
    hostname: string;

    /** Base URL for the leader service (e.g., http://localhost:8180) */
    baseUrl: string;

    /** meta-core API URL (port 9000) */
    apiUrl: string;

    /** Redis connection URL (e.g., redis://10.0.1.50:6379) */
    redisUrl: string;

    /** WebDAV URL for file access (external, via nginx/HTTPS) */
    webdavUrl: string;

    /** WebDAV URL for internal container-to-container access (direct to port 9000) */
    webdavUrlInternal: string;

    /** Timestamp when leadership was acquired */
    timestamp: number;

    /** Process ID of the leader */
    pid: number;
}

/**
 * Service registration info (simplified)
 * Full URLs are obtained via the /urls API endpoint
 */
export interface ServiceInfo {
    /** Service name (e.g., 'meta-sort', 'meta-fuse') */
    name: string;

    /** Hostname */
    hostname: string;

    /** Base URL for the service */
    baseUrl: string;

    /** Current status */
    status: 'running' | 'stale' | 'stopped';

    /** Last heartbeat timestamp (ISO string) */
    lastHeartbeat: string;

    /** Role for meta-core instances: 'leader', 'follower', or undefined for other services */
    role?: string;
}
