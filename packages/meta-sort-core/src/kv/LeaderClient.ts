/**
 * LeaderClient - Client for reading leader info from meta-core
 *
 * This replaces the old LeaderElection.ts by delegating leader election
 * to meta-core (Go sidecar) and just reading the results.
 *
 * Features:
 * - Reads kv-leader.info file for leader URLs
 * - Calls meta-core /urls API for current leader URLs
 * - Watches for leader changes via file system watcher
 */

import { promises as fs } from 'fs';
import { watch, FSWatcher } from 'fs';
import { dirname } from 'path';
import type { LeaderLockInfo } from './IKVClient.js';

export interface LeaderClientConfig {
    /** Path to META_CORE_VOLUME (e.g., /meta-core) */
    metaCorePath: string;

    /** meta-core API URL (e.g., http://meta-core:9000 or http://localhost:9000) */
    metaCoreUrl?: string;
}

export interface URLsResponse {
    hostname: string;
    baseUrl: string;
    apiUrl: string;
    redisUrl: string;
    webdavUrl: string;
    webdavUrlInternal: string;
    isLeader: boolean;
}

export class LeaderClient {
    private config: LeaderClientConfig;
    private infoFilePath: string;
    private leaderInfo: LeaderLockInfo | null = null;
    private watcher: FSWatcher | null = null;
    private onChangeCallbacks: (() => void)[] = [];

    // URL caching
    private cachedUrls: URLsResponse | null = null;
    private urlsCacheTime: number = 0;
    private readonly urlsCacheTTL: number = 5000; // 5 seconds

    constructor(config: LeaderClientConfig) {
        this.config = config;
        this.infoFilePath = `${config.metaCorePath}/locks/kv-leader.info`;
    }

    /**
     * Read API URL from file (plain text format)
     */
    private async getApiUrlFromFile(): Promise<string | null> {
        try {
            const content = await fs.readFile(this.infoFilePath, 'utf-8');
            return content.trim() || null;
        } catch (error) {
            console.error('[LeaderClient] Failed to read API URL from file:', error);
            return null;
        }
    }

    /**
     * Fetch URLs from meta-core /urls API with caching
     */
    private async fetchUrls(apiUrl: string): Promise<URLsResponse | null> {
        // Check cache
        const now = Date.now();
        if (this.cachedUrls && (now - this.urlsCacheTime) < this.urlsCacheTTL) {
            return this.cachedUrls;
        }

        try {
            const response = await fetch(`${apiUrl}/urls`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) {
                console.error('[LeaderClient] Failed to fetch URLs:', response.status, response.statusText);
                return null;
            }

            this.cachedUrls = await response.json() as URLsResponse;
            this.urlsCacheTime = now;
            return this.cachedUrls;
        } catch (error) {
            console.error('[LeaderClient] Error calling /urls API:', error);
            return null;
        }
    }

    /**
     * Read leader info from file and /urls API
     */
    async getLeaderInfo(): Promise<LeaderLockInfo | null> {
        try {
            // Read API URL from file (plain text)
            const apiUrl = await this.getApiUrlFromFile();
            if (!apiUrl) {
                return null;
            }

            // Fetch full info from /urls API
            const urls = await this.fetchUrls(apiUrl);
            if (!urls) {
                return null;
            }

            // Convert URLsResponse to LeaderLockInfo
            this.leaderInfo = {
                hostname: urls.hostname,
                baseUrl: urls.baseUrl,
                apiUrl: urls.apiUrl,
                redisUrl: urls.redisUrl,
                webdavUrl: urls.webdavUrl,
                webdavUrlInternal: urls.webdavUrlInternal,
                timestamp: Date.now(),
                pid: 0 // Unknown for remote leader
            };
            return this.leaderInfo;
        } catch (error) {
            console.error('[LeaderClient] Failed to read leader info:', error);
            return null;
        }
    }

    /**
     * Get Redis URL from leader info
     */
    async getRedisUrl(): Promise<string | null> {
        const info = await this.getLeaderInfo();
        return info?.redisUrl ?? null;
    }

    /**
     * Get WebDAV URL from leader info (external, via nginx/HTTPS)
     */
    async getWebdavUrl(): Promise<string | null> {
        const info = await this.getLeaderInfo();
        return info?.webdavUrl ?? null;
    }

    /**
     * Get internal WebDAV URL from leader info (direct to port 9000)
     * Use this for container-to-container communication
     */
    async getWebdavUrlInternal(): Promise<string | null> {
        const info = await this.getLeaderInfo();
        return info?.webdavUrlInternal ?? null;
    }

    /**
     * Get meta-core API URL from leader info
     */
    async getApiUrl(): Promise<string | null> {
        const info = await this.getLeaderInfo();
        return info?.apiUrl ?? null;
    }

    /**
     * Call meta-core /urls API to get current URLs
     * Useful for getting URLs when you don't want to read the file directly
     */
    async getUrls(): Promise<URLsResponse | null> {
        // First try using configured metaCoreUrl
        let apiUrl = this.config.metaCoreUrl;

        // Fall back to reading from file
        if (!apiUrl) {
            apiUrl = await this.getApiUrlFromFile();
        }

        if (!apiUrl) {
            console.error('[LeaderClient] No meta-core API URL available');
            return null;
        }

        return this.fetchUrls(apiUrl);
    }

    /**
     * Wait for leader info to be available
     */
    async waitForLeader(timeoutMs: number = 30000): Promise<LeaderLockInfo> {
        const startTime = Date.now();
        const pollInterval = 500;

        while (Date.now() - startTime < timeoutMs) {
            const info = await this.getLeaderInfo();
            if (info) {
                console.log(`[LeaderClient] Leader found: ${info.hostname} at ${info.redisUrl}`);
                return info;
            }

            console.log('[LeaderClient] Waiting for leader...');
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        throw new Error(`No leader found within ${timeoutMs}ms`);
    }

    /**
     * Start watching for leader changes
     */
    startWatching(): void {
        if (this.watcher) {
            return; // Already watching
        }

        const lockDir = dirname(this.infoFilePath);

        try {
            this.watcher = watch(lockDir, (eventType, filename) => {
                if (filename === 'kv-leader.info') {
                    console.log('[LeaderClient] Leader info changed, invalidating cache...');
                    // Invalidate cache to force fresh API call
                    this.cachedUrls = null;
                    this.urlsCacheTime = 0;

                    this.getLeaderInfo().then(() => {
                        this.notifyChange();
                    }).catch(console.error);
                }
            });

            console.log(`[LeaderClient] Watching for leader changes in ${lockDir}`);
        } catch (error) {
            console.error('[LeaderClient] Failed to start watching:', error);
        }
    }

    /**
     * Stop watching for leader changes
     */
    stopWatching(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
            console.log('[LeaderClient] Stopped watching for leader changes');
        }
    }

    /**
     * Register callback for leader changes
     */
    onChange(callback: () => void): this {
        this.onChangeCallbacks.push(callback);
        return this;
    }

    /**
     * Notify all change callbacks
     */
    private notifyChange(): void {
        for (const callback of this.onChangeCallbacks) {
            try {
                callback();
            } catch (error) {
                console.error('[LeaderClient] Error in change callback:', error);
            }
        }
    }

    /**
     * Get cached leader info (without re-reading file)
     */
    getCachedLeaderInfo(): LeaderLockInfo | null {
        return this.leaderInfo;
    }

    /**
     * Clean up resources
     */
    close(): void {
        this.stopWatching();
        this.onChangeCallbacks = [];
    }
}
