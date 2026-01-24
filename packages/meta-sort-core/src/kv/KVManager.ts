/**
 * KV Manager - Unified manager for KV storage, leader election, and service discovery
 *
 * This is the main entry point for the KV subsystem. It:
 * 1. Participates in leader election (spawns Redis if leader)
 * 2. Creates and manages the KV client (Redis)
 * 3. Handles service discovery registration
 * 4. Manages reconnection on leader failure
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

import { networkInterfaces } from 'os';
import { LeaderElection } from './LeaderElection.js';
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

    /** Service version */
    version?: string;

    /** HTTP API port */
    apiPort: number;

    /** Redis port (default: 6379) */
    redisPort?: number;

    /** Service capabilities */
    capabilities?: string[];

    /** Whether to skip leader election and use provided Redis URL */
    redisUrl?: string;

    /** Base URL for service discovery (overrides auto-detected URL) */
    baseUrl?: string;

    /**
     * Hostname to advertise in lock file for other services to connect.
     * Use Docker service name (e.g., 'meta-sort-dev') for stable DNS resolution.
     */
    advertiseHost?: string;
}

export class KVManager {
    private config: KVManagerConfig;
    private leaderElection: LeaderElection | null = null;
    private serviceDiscovery: ServiceDiscovery | null = null;
    private kvClient: IKVClient | null = null;
    private isStarted = false;
    private isShuttingDown = false;

    // Event callbacks
    private onReadyCallbacks: (() => void)[] = [];
    private onReconnectCallbacks: (() => void)[] = [];

    constructor(config: KVManagerConfig) {
        this.config = {
            version: '1.0.0',
            redisPort: 6379,
            capabilities: [],
            ...config
        };
    }

    /**
     * Get the local IP for API URL construction
     */
    private getLocalIP(): string {
        const interfaces = networkInterfaces();

        for (const name of Object.keys(interfaces)) {
            const addrs = interfaces[name];
            if (!addrs) continue;

            for (const addr of addrs) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }

        return 'localhost';
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

        // Check for direct Redis URL (skip leader election)
        if (this.config.redisUrl) {
            console.log(`[KVManager] Using direct Redis URL: ${this.config.redisUrl}`);
            this.kvClient = await this.createRedisClient(this.config.redisUrl);

            // NOTE: Service discovery is handled by Go meta-core sidecar
            // The Go binary writes to /meta-core/services/{serviceName}.json with correct internal IPs
            // TypeScript ServiceDiscovery would overwrite with external BASE_URL, breaking internal discovery
            // Keep ServiceDiscovery instance for reading/discovery only, but don't call start()
            const apiUrl = this.config.baseUrl || `http://localhost:${this.config.apiPort}`;
            this.serviceDiscovery = new ServiceDiscovery({
                metaCorePath: this.config.metaCorePath,
                serviceName: this.config.serviceName,
                version: this.config.version!,
                apiUrl,
                capabilities: this.config.capabilities,
                endpoints: {
                    health: '/health',
                    dashboard: '/',
                    api: '/api',
                    metrics: '/api/metrics',
                    processing: '/api/processing/status'
                }
            });
            // Don't call start() - Go meta-core handles registration
            // await this.serviceDiscovery.start();

            this.isStarted = true;
            this.notifyReady();
            return;
        }

        // Initialize leader election
        const localIP = this.getLocalIP();

        this.leaderElection = new LeaderElection({
            metaCorePath: this.config.metaCorePath,
            serviceName: this.config.serviceName,
            apiPort: this.config.apiPort,
            redisPort: this.config.redisPort,
            baseUrl: this.config.baseUrl
        });

        // Setup leader election callbacks
        this.leaderElection.onLeader(async () => {
            console.log('[KVManager] We are the leader, connecting to local Redis...');

            // Connect to local Redis (spawned by leader election)
            const redisUrl = `redis://127.0.0.1:${this.config.redisPort}`;
            this.kvClient = await this.createRedisClient(redisUrl);

            this.notifyReady();
        });

        this.leaderElection.onFollower(async (leaderInfo: LeaderLockInfo) => {
            console.log(`[KVManager] We are a follower, connecting to leader at ${leaderInfo.api}...`);

            // Connect to leader's Redis
            this.kvClient = await this.createRedisClient(leaderInfo.api);

            this.notifyReady();
        });

        this.leaderElection.onLostLeader(async () => {
            console.log('[KVManager] Leader lost, disconnecting...');

            if (this.kvClient) {
                await this.kvClient.close();
                this.kvClient = null;
            }

            // Leader election will handle re-election and reconnection
        });

        // Initialize service discovery
        // Use BASE_URL if provided, otherwise fall back to auto-detected local IP
        const apiUrl = this.config.baseUrl || `http://${localIP}:${this.config.apiPort}`;

        this.serviceDiscovery = new ServiceDiscovery({
            metaCorePath: this.config.metaCorePath,
            serviceName: this.config.serviceName,
            version: this.config.version!,
            apiUrl,
            capabilities: this.config.capabilities,
            endpoints: {
                health: '/health',
                dashboard: '/',
                api: '/api',
                metrics: '/api/metrics',
                processing: '/api/processing/status'
            }
        });

        // Start leader election first
        await this.leaderElection.start();

        // Start service discovery
        await this.serviceDiscovery.start();

        this.isStarted = true;
    }

    /**
     * Stop the KV manager
     */
    async stop(): Promise<void> {
        if (!this.isStarted) return;

        console.log('[KVManager] Stopping...');
        this.isShuttingDown = true;

        // Stop service discovery
        if (this.serviceDiscovery) {
            await this.serviceDiscovery.stop();
            this.serviceDiscovery = null;
        }

        // Close KV client
        if (this.kvClient) {
            await this.kvClient.close();
            this.kvClient = null;
        }

        // Stop leader election (releases lock, stops Redis if leader)
        if (this.leaderElection) {
            await this.leaderElection.stop();
            this.leaderElection = null;
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
     * Check if this service is the leader
     */
    isLeader(): boolean {
        return this.leaderElection?.isLeader() ?? false;
    }

    /**
     * Check if this service is a follower
     */
    isFollower(): boolean {
        return this.leaderElection?.isFollower() ?? false;
    }

    /**
     * Get the current leader info
     */
    getLeaderInfo(): LeaderLockInfo | null {
        return this.leaderElection?.getLeaderInfo() ?? null;
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
