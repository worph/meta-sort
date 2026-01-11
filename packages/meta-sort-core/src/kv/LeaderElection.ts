/**
 * Leader Election using flock on shared filesystem
 *
 * This implements a distributed leader election mechanism using:
 * 1. flock (advisory file locking) for mutual exclusion
 * 2. Shared filesystem as the consensus layer
 * 3. Separate info file for service discovery
 *
 * Architecture:
 * - Service tries to acquire exclusive flock on /meta-core/locks/kv-leader.lock
 * - If acquired → becomes LEADER, spawns Redis, writes endpoint to info file
 * - If blocked → becomes FOLLOWER, reads leader endpoint from info file
 * - flock automatically releases when process dies (no stale lock issues!)
 *
 * Key advantage over O_EXCL approach:
 * - Lock is automatically released when process exits/crashes
 * - No need for timestamp-based stale detection
 * - No race conditions during takeover
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';
import { hostname, networkInterfaces } from 'os';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as IORedis from 'ioredis';
import type { LeaderLockInfo } from './IKVClient.js';

// ESM/CJS interop for ioredis
const Redis = (IORedis as any).default ?? IORedis;

interface LeaderElectionConfig {
    /** Path to META_CORE_VOLUME (e.g., /meta-core) */
    metaCorePath: string;

    /** Service name for identification */
    serviceName: string;

    /** HTTP API port */
    apiPort: number;

    /** Redis port (default: 6379) */
    redisPort?: number;

    /** Redis data directory (relative to META_CORE_VOLUME/db/redis) */
    redisDataDir?: string;

    /** Health check interval in ms (default: 5000) */
    healthCheckInterval?: number;

    /** Base URL for stable service discovery (e.g., http://localhost:8180) */
    baseUrl?: string;
}

type LeaderRole = 'leader' | 'follower' | 'unknown';

export class LeaderElection {
    private config: LeaderElectionConfig;
    private lockFilePath: string;
    private infoFilePath: string;
    private flockProcess: ChildProcess | null = null;
    private role: LeaderRole = 'unknown';
    private leaderInfo: LeaderLockInfo | null = null;
    private redisProcess: ChildProcess | null = null;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private isShuttingDown = false;

    // Event callbacks
    private onBecomeLeader?: () => void;
    private onBecomeFollower?: (leaderInfo: LeaderLockInfo) => void;
    private onLeaderLost?: () => void;

    constructor(config: LeaderElectionConfig) {
        this.config = {
            redisPort: 6379,
            healthCheckInterval: 5000,
            ...config
        };

        this.lockFilePath = `${this.config.metaCorePath}/locks/kv-leader.lock`;
        this.infoFilePath = `${this.config.metaCorePath}/locks/kv-leader.info`;
    }

    /**
     * Get the local machine's IP address
     */
    private getLocalIP(): string {
        const interfaces = networkInterfaces();

        // Prefer non-internal IPv4 addresses
        for (const name of Object.keys(interfaces)) {
            const addrs = interfaces[name];
            if (!addrs) continue;

            for (const addr of addrs) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }

        // Fallback to hostname or localhost
        return hostname() || 'localhost';
    }

    /**
     * Build leader info for this service
     */
    private buildLeaderInfo(): LeaderLockInfo {
        const ip = this.getLocalIP();
        return {
            host: hostname(),
            api: `redis://${ip}:${this.config.redisPort}`,
            http: `http://${ip}:${this.config.apiPort}`,
            baseUrl: this.config.baseUrl,
            timestamp: Date.now(),
            pid: process.pid
        };
    }

    /**
     * Ensure lock directory exists
     */
    private async ensureLockDir(): Promise<void> {
        const lockDir = dirname(this.lockFilePath);
        await fs.mkdir(lockDir, { recursive: true });
    }

    /**
     * Try to acquire the leader lock using flock
     * Returns true if lock acquired (we are leader), false otherwise
     *
     * Uses `flock -n -x` for non-blocking exclusive lock attempt.
     * The lock is held by keeping a child process alive with the lock fd open.
     */
    private async tryAcquireLock(): Promise<boolean> {
        await this.ensureLockDir();

        // Ensure lock file exists (flock needs an existing file)
        try {
            await fs.writeFile(this.lockFilePath, '', { flag: 'a' });
        } catch {
            // Ignore if file already exists
        }

        return new Promise((resolve) => {
            // Spawn a process that tries to acquire the lock and holds it
            // Using flock with file descriptor: open fd 200 on lock file, then sleep forever
            // The lock is held as long as fd 200 is open (process alive)
            this.flockProcess = spawn('bash', [
                '-c',
                `exec 200>"${this.lockFilePath}" && flock -n -x 200 && echo LOCKED && while true; do sleep 86400; done`
            ], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let resolved = false;

            // Check stdout for "LOCKED" message indicating we got the lock
            this.flockProcess.stdout?.on('data', (data) => {
                const output = data.toString().trim();
                if (output === 'LOCKED' && !resolved) {
                    resolved = true;
                    console.log('[LeaderElection] Acquired flock on', this.lockFilePath);
                    resolve(true);
                }
            });

            this.flockProcess.stderr?.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    console.error('[LeaderElection] flock stderr:', msg);
                }
            });

            // If process exits quickly, we didn't get the lock
            this.flockProcess.on('exit', (code) => {
                if (!resolved) {
                    resolved = true;
                    console.log('[LeaderElection] Could not acquire flock (lock held by another process)');
                    this.flockProcess = null;
                    resolve(false);
                } else if (!this.isShuttingDown && this.role === 'leader') {
                    // Lock process died unexpectedly while we were leader
                    console.error('[LeaderElection] flock process died unexpectedly!');
                    this.flockProcess = null;
                    this.handleLockLost();
                }
            });

            // Timeout: if we don't get the lock within 2 seconds, assume it's held
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    if (this.flockProcess) {
                        this.flockProcess.kill();
                        this.flockProcess = null;
                    }
                    console.log('[LeaderElection] Timeout acquiring flock (lock held by another process)');
                    resolve(false);
                }
            }, 2000);
        });
    }

    /**
     * Handle losing the lock unexpectedly
     */
    private async handleLockLost(): Promise<void> {
        if (this.isShuttingDown) return;

        console.log('[LeaderElection] Lost leadership, cleaning up...');
        this.role = 'unknown';

        // Stop Redis
        await this.stopRedis();

        // Notify callback
        this.onLeaderLost?.();

        // Try to re-elect
        const acquired = await this.tryAcquireLock();
        if (acquired) {
            await this.transitionToLeader();
        } else {
            await this.transitionToFollower();
        }
    }

    /**
     * Check if the lock is currently held by someone
     * Uses flock -n which fails immediately if lock is held
     */
    private isLockHeld(): boolean {
        try {
            // Try to acquire lock non-blocking - if it succeeds, no one holds it
            execSync(`flock -n -x "${this.lockFilePath}" -c "exit 0"`, {
                timeout: 1000,
                stdio: 'ignore'
            });
            // Lock was free (we briefly held it and released)
            return false;
        } catch {
            // Lock is held by someone else
            return true;
        }
    }

    /**
     * Read leader info from info file
     */
    private async readLeaderInfo(): Promise<LeaderLockInfo | null> {
        try {
            const content = await fs.readFile(this.infoFilePath, 'utf-8');
            return JSON.parse(content) as LeaderLockInfo;
        } catch {
            return null;
        }
    }

    /**
     * Write leader info to info file (atomic write)
     */
    private async writeLeaderInfo(): Promise<void> {
        this.leaderInfo = this.buildLeaderInfo();

        // Atomic write: write to temp file, then rename
        const tempPath = `${this.infoFilePath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(this.leaderInfo, null, 2));
        await fs.rename(tempPath, this.infoFilePath);

        console.log('[LeaderElection] Wrote leader info to', this.infoFilePath);
    }

    /**
     * Update leader timestamp (heartbeat) using atomic write
     */
    private async updateLeaderTimestamp(): Promise<void> {
        if (this.role !== 'leader' || !this.leaderInfo) return;

        this.leaderInfo.timestamp = Date.now();
        try {
            // Atomic write: write to temp file, then rename
            const tempPath = `${this.infoFilePath}.tmp`;
            await fs.writeFile(tempPath, JSON.stringify(this.leaderInfo, null, 2));
            await fs.rename(tempPath, this.infoFilePath);
        } catch (error) {
            console.error('[LeaderElection] Failed to update timestamp:', error);
        }
    }

    /**
     * Spawn Redis server as child process
     */
    private async spawnRedis(): Promise<void> {
        const redisDataDir = `${this.config.metaCorePath}/db/redis`;

        // Ensure Redis data directory exists
        await fs.mkdir(redisDataDir, { recursive: true });

        console.log(`[LeaderElection] Spawning Redis on port ${this.config.redisPort}...`);

        // Spawn Redis server
        this.redisProcess = spawn('redis-server', [
            '--port', String(this.config.redisPort),
            '--bind', '0.0.0.0',
            '--dir', redisDataDir,
            '--appendonly', 'yes',
            '--appendfilename', 'appendonly.aof',
            '--dbfilename', 'dump.rdb',
            '--save', '60', '1', // Save after 60 seconds if at least 1 key changed
            '--loglevel', 'warning'
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false
        });

        this.redisProcess.stdout?.on('data', (data) => {
            console.log(`[Redis] ${data.toString().trim()}`);
        });

        this.redisProcess.stderr?.on('data', (data) => {
            console.error(`[Redis] ${data.toString().trim()}`);
        });

        this.redisProcess.on('exit', (code, signal) => {
            console.log(`[Redis] Process exited with code ${code}, signal ${signal}`);
            this.redisProcess = null;

            if (!this.isShuttingDown && this.role === 'leader') {
                // Redis crashed - try to restart
                console.log('[LeaderElection] Redis crashed, attempting restart...');
                this.spawnRedis().catch(console.error);
            }
        });

        // Wait for Redis to be ready
        await this.waitForRedisReady();
    }

    /**
     * Wait for Redis to be ready to accept connections
     */
    private async waitForRedisReady(): Promise<void> {
        const maxAttempts = 30;
        const ip = this.getLocalIP();

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const client = new Redis({
                    host: ip,
                    port: this.config.redisPort,
                    connectTimeout: 1000,
                    maxRetriesPerRequest: 1
                });

                const pong = await client.ping();
                await client.quit();

                if (pong === 'PONG') {
                    console.log('[LeaderElection] Redis is ready');
                    return;
                }
            } catch {
                // Redis not ready yet
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        throw new Error('Redis failed to start within timeout');
    }

    /**
     * Stop Redis server
     */
    private async stopRedis(): Promise<void> {
        if (this.redisProcess) {
            console.log('[LeaderElection] Stopping Redis...');
            this.redisProcess.kill('SIGTERM');

            // Wait for graceful shutdown
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.redisProcess) {
                        this.redisProcess.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);

                this.redisProcess!.on('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });

            this.redisProcess = null;
        }
    }

    /**
     * Release the leader lock by killing the flock process
     */
    private async releaseLock(): Promise<void> {
        if (this.flockProcess) {
            console.log('[LeaderElection] Releasing flock...');

            // Kill the flock holder process - this releases the lock
            this.flockProcess.kill('SIGTERM');

            // Wait briefly for graceful exit
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.flockProcess) {
                        this.flockProcess.kill('SIGKILL');
                    }
                    resolve();
                }, 1000);

                if (this.flockProcess) {
                    this.flockProcess.on('exit', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                } else {
                    clearTimeout(timeout);
                    resolve();
                }
            });

            this.flockProcess = null;
        }

        // Clean up info file (optional, but good hygiene)
        try {
            await fs.unlink(this.infoFilePath);
        } catch {
            // Ignore if file doesn't exist
        }
    }

    /**
     * Start health check loop
     */
    private startHealthCheck(): void {
        this.healthCheckTimer = setInterval(async () => {
            if (this.isShuttingDown) return;

            try {
                if (this.role === 'leader') {
                    // Update timestamp as heartbeat
                    await this.updateLeaderTimestamp();

                    // Verify we still hold the lock
                    if (!this.flockProcess || this.flockProcess.exitCode !== null) {
                        console.error('[LeaderElection] Lost flock process!');
                        await this.handleLockLost();
                    }
                } else if (this.role === 'follower') {
                    // Check if lock is still held (leader still alive)
                    if (!this.isLockHeld()) {
                        console.log('[LeaderElection] Lock is free, attempting to become leader...');
                        this.onLeaderLost?.();

                        // Try to become leader
                        const acquired = await this.tryAcquireLock();
                        if (acquired) {
                            await this.transitionToLeader();
                        } else {
                            // Another service became leader - reconnect
                            await this.transitionToFollower();
                        }
                    }
                }
            } catch (error) {
                console.error('[LeaderElection] Health check error:', error);
            }
        }, this.config.healthCheckInterval);
    }

    /**
     * Transition to leader role
     */
    private async transitionToLeader(): Promise<void> {
        console.log('[LeaderElection] Becoming LEADER');
        this.role = 'leader';

        // Write leader info BEFORE spawning Redis so followers can find us
        await this.writeLeaderInfo();

        // Spawn Redis
        await this.spawnRedis();

        // Notify callback
        this.onBecomeLeader?.();
    }

    /**
     * Transition to follower role
     */
    private async transitionToFollower(): Promise<void> {
        console.log('[LeaderElection] Becoming FOLLOWER');
        this.role = 'follower';

        // Wait a bit for leader to write info file
        await new Promise(resolve => setTimeout(resolve, 500));

        // Read leader info
        this.leaderInfo = await this.readLeaderInfo();

        if (this.leaderInfo) {
            console.log(`[LeaderElection] Leader is ${this.leaderInfo.host} at ${this.leaderInfo.api}`);
            this.onBecomeFollower?.(this.leaderInfo);
        } else {
            console.warn('[LeaderElection] Could not read leader info, will retry...');
            // Retry reading after a delay
            setTimeout(async () => {
                this.leaderInfo = await this.readLeaderInfo();
                if (this.leaderInfo) {
                    console.log(`[LeaderElection] Leader is ${this.leaderInfo.host} at ${this.leaderInfo.api}`);
                    this.onBecomeFollower?.(this.leaderInfo);
                }
            }, 2000);
        }
    }

    /**
     * Start the leader election process
     */
    async start(): Promise<void> {
        console.log(`[LeaderElection] Starting election for ${this.config.serviceName}...`);
        console.log(`[LeaderElection] Lock file: ${this.lockFilePath}`);
        console.log(`[LeaderElection] Info file: ${this.infoFilePath}`);

        // Try to become leader
        const acquired = await this.tryAcquireLock();

        if (acquired) {
            await this.transitionToLeader();
        } else {
            await this.transitionToFollower();
        }

        // Start health check
        this.startHealthCheck();
    }

    /**
     * Stop and cleanup
     */
    async stop(): Promise<void> {
        console.log('[LeaderElection] Stopping...');
        this.isShuttingDown = true;

        // Stop health check
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }

        // If we were leader, cleanup
        if (this.role === 'leader') {
            await this.stopRedis();
            await this.releaseLock();
        }

        this.role = 'unknown';
        console.log('[LeaderElection] Stopped');
    }

    // ========================================================================
    // Event Registration
    // ========================================================================

    onLeader(callback: () => void): this {
        this.onBecomeLeader = callback;
        return this;
    }

    onFollower(callback: (leaderInfo: LeaderLockInfo) => void): this {
        this.onBecomeFollower = callback;
        return this;
    }

    onLostLeader(callback: () => void): this {
        this.onLeaderLost = callback;
        return this;
    }

    // ========================================================================
    // Getters
    // ========================================================================

    getRole(): LeaderRole {
        return this.role;
    }

    isLeader(): boolean {
        return this.role === 'leader';
    }

    isFollower(): boolean {
        return this.role === 'follower';
    }

    getLeaderInfo(): LeaderLockInfo | null {
        return this.leaderInfo;
    }

    getRedisUrl(): string | null {
        if (this.leaderInfo) {
            return this.leaderInfo.api;
        }
        return null;
    }
}
