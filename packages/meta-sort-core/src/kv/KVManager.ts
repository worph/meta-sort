/**
 * KV Manager - Unified manager for KV storage and service discovery
 *
 * This is the main entry point for the KV subsystem. It:
 * 1. Uses LeaderClient to read leader info from meta-core
 * 2. Creates and manages the KV client (Redis)
 * 3. Handles service discovery registration
 * 4. Manages reconnection on leader changes
 *
 * Note: Leader election is now handled by meta-core (Go sidecar).
 * This service only reads the leader info and connects to Redis.
 *
 * Usage:
 * ```typescript
 * const kvManager = new KVManager({
 *     metaCorePath: '/meta-core',
 *     filesPath: '/files',
 *     serviceName: 'meta-sort',
 *     apiPort: 3000
 * });
 *
 * await kvManager.start();
 * const client = kvManager.getClient();
 * // Use client...
 * await kvManager.stop();
 * ```
 */

import { hostname } from 'os';
import { LeaderClient } from './LeaderClient.js';
import { ServiceDiscovery } from './ServiceDiscovery.js';
import { RedisKVClient } from './RedisClient.js';
import type { IKVClient, LeaderLockInfo } from './IKVClient.js';

interface KVManagerConfig {
    /** Path to META_CORE_VOLUME (e.g., /meta-core) */
    metaCorePath: string;

    /** Path to FILES_VOLUME (e.g., /files) */
    filesPath: string;

    /** Service name (e.g., 'meta-sort', 'meta-fuse') */
    serviceName: string;

    /** HTTP API port */
    apiPort: number;

    /** Base URL for service discovery (overrides auto-detected URL) */
    baseUrl?: string;

    /** Optional direct Redis URL (bypasses leader discovery) */
    redisUrl?: string;

    /** meta-core API URL (e.g., http://localhost:9000) */
    metaCoreUrl?: string;
}

export class KVManager {
    private config: KVManagerConfig;
    private leaderClient: LeaderClient | null = null;
    private serviceDiscovery: ServiceDiscovery | null = null;
    private kvClient: IKVClient | null = null;
    private isStarted = false;
    private isShuttingDown = false;

    // Event callbacks
    private onReadyCallbacks: (() => void)[] = [];
    private onReconnectCallbacks: (() => void)[] = [];

    constructor(config: KVManagerConfig) {
        this.config = config;
    }

    /**
     * Create Redis client from URL
     */
    private async createRedisClient(redisUrl: string): Promise<RedisKVClient> {
        const client = new RedisKVClient({
            url: redisUrl,
            timeout: 30000,
            prefix: '' // No prefix for shared access
        });

        await client.connect();
        return client;
    }

    /**
     * Start the KV manager
     */
    async start(): Promise<void> {
        if (this.isStarted) {
            console.warn('[KVManager] Already started');
            return;
        }

        console.log(`[KVManager] Starting for ${this.config.serviceName}...`);

        // Check for direct Redis URL (skip leader discovery)
        if (this.config.redisUrl) {
            console.log(`[KVManager] Using direct Redis URL: ${this.config.redisUrl}`);
            this.kvClient = await this.createRedisClient(this.config.redisUrl);
            this.isStarted = true;
            this.notifyReady();
            return;
        }

        // Initialize leader client
        this.leaderClient = new LeaderClient({
            metaCorePath: this.config.metaCorePath,
            metaCoreUrl: this.config.metaCoreUrl
        });

        // Watch for leader changes
        this.leaderClient.onChange(async () => {
            console.log('[KVManager] Leader changed, reconnecting...');
            await this.reconnect();
        });

        // Wait for leader and connect
        try {
            const leaderInfo = await this.leaderClient.waitForLeader(30000);
            console.log(`[KVManager] Connecting to Redis at ${leaderInfo.redisUrl}...`);
            this.kvClient = await this.createRedisClient(leaderInfo.redisUrl);
        } catch (error) {
            console.error('[KVManager] Failed to connect to leader:', error);
            throw error;
        }

        // Start watching for leader changes
        this.leaderClient.startWatching();

        // Initialize and start service discovery for registration and heartbeat
        const apiUrl = this.config.baseUrl || `http://${hostname()}:${this.config.apiPort}`;
        this.serviceDiscovery = new ServiceDiscovery({
            metaCorePath: this.config.metaCorePath,
            serviceName: this.config.serviceName,
            version: '1.0.0',
            apiUrl
        });
        await this.serviceDiscovery.start();

        this.isStarted = true;
        this.notifyReady();
    }

    /**
     * Reconnect to Redis after leader change
     */
    private async reconnect(): Promise<void> {
        if (this.isShuttingDown || !this.leaderClient) {
            return;
        }

        // Close existing connection
        if (this.kvClient) {
            await this.kvClient.close();
            this.kvClient = null;
        }

        // Wait for new leader
        try {
            const leaderInfo = await this.leaderClient.waitForLeader(30000);
            console.log(`[KVManager] Reconnecting to Redis at ${leaderInfo.redisUrl}...`);
            this.kvClient = await this.createRedisClient(leaderInfo.redisUrl);

            // Notify reconnect callbacks
            for (const callback of this.onReconnectCallbacks) {
                try {
                    callback();
                } catch (error) {
                    console.error('[KVManager] Error in reconnect callback:', error);
                }
            }
        } catch (error) {
            console.error('[KVManager] Failed to reconnect:', error);
        }
    }

    /**
     * Stop the KV manager
     */
    async stop(): Promise<void> {
        if (!this.isStarted) return;

        console.log('[KVManager] Stopping...');
        this.isShuttingDown = true;

        // Stop leader client
        if (this.leaderClient) {
            this.leaderClient.close();
            this.leaderClient = null;
        }

        // Close KV client
        if (this.kvClient) {
            await this.kvClient.close();
            this.kvClient = null;
        }

        // Service discovery stop (if it was started)
        if (this.serviceDiscovery) {
            await this.serviceDiscovery.stop();
            this.serviceDiscovery = null;
        }

        this.isStarted = false;
        console.log('[KVManager] Stopped');
    }

    /**
     * Notify ready callbacks
     */
    private notifyReady(): void {
        for (const callback of this.onReadyCallbacks) {
            try {
                callback();
            } catch (error) {
                console.error('[KVManager] Error in ready callback:', error);
            }
        }
    }

    /**
     * Register a callback for when the KV client is ready
     */
    onReady(callback: () => void): this {
        this.onReadyCallbacks.push(callback);

        // If already ready, call immediately
        if (this.kvClient) {
            callback();
        }

        return this;
    }

    /**
     * Register a callback for reconnection events
     */
    onReconnect(callback: () => void): this {
        this.onReconnectCallbacks.push(callback);
        return this;
    }

    /**
     * Wait for the KV client to be ready
     */
    async waitForReady(timeoutMs: number = 30000): Promise<void> {
        if (this.kvClient) return;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`KV client not ready after ${timeoutMs}ms`));
            }, timeoutMs);

            this.onReady(() => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    // ========================================================================
    // Getters
    // ========================================================================

    /**
     * Get the KV client (may be null if not yet connected)
     */
    getClient(): IKVClient | null {
        return this.kvClient;
    }

    /**
     * Get the KV client (throws if not connected)
     */
    requireClient(): IKVClient {
        if (!this.kvClient) {
            throw new Error('KV client not available. Call start() and wait for ready.');
        }
        return this.kvClient;
    }

    /**
     * Get the current leader info
     */
    getLeaderInfo(): LeaderLockInfo | null {
        return this.leaderClient?.getCachedLeaderInfo() ?? null;
    }

    /**
     * Get the leader client
     */
    getLeaderClient(): LeaderClient | null {
        return this.leaderClient;
    }

    /**
     * Get service discovery instance
     */
    getServiceDiscovery(): ServiceDiscovery | null {
        return this.serviceDiscovery;
    }

    /**
     * Discover another service
     */
    async discoverService(name: string) {
        return this.serviceDiscovery?.discoverService(name) ?? null;
    }

    /**
     * Check if the KV store is healthy
     */
    async isHealthy(): Promise<boolean> {
        if (!this.kvClient) return false;
        return this.kvClient.health();
    }

    /**
     * Get paths configuration
     */
    getPaths() {
        return {
            metaCorePath: this.config.metaCorePath,
            filesPath: this.config.filesPath
        };
    }
}
