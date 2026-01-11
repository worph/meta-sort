/**
 * Redis KV Client - Implements IKVClient interface using Redis
 *
 * Uses Redis hashes for efficient nested key storage:
 * - Each file's metadata is stored as a Redis hash
 * - Hash key: file:{hashId}
 * - Hash field: property/path (e.g., "video/codec")
 *
 * Benefits of Redis hashes:
 * - Single command to get all file metadata (HGETALL)
 * - Single command to set multiple properties (HMSET)
 * - Atomic operations on file metadata
 */

import * as IORedis from 'ioredis';
import type { IKVClient, KeyValuePair } from './IKVClient.js';
import {
    flattenMetadata,
    reconstructMetadata,
    buildFilePrefix,
    buildPropertyKey,
} from './MetadataUtils.js';

// ESM/CJS interop for ioredis
const Redis = (IORedis as any).default ?? IORedis;
type RedisInstance = InstanceType<typeof Redis>;

interface RedisClientConfig {
    url: string;
    timeout?: number;
    prefix?: string;
}

export class RedisKVClient implements IKVClient {
    private redis: RedisInstance;
    private timeout: number;
    private prefix: string;
    private isConnected: boolean = false;

    constructor(config: RedisClientConfig) {
        this.timeout = config.timeout || 30000;
        this.prefix = config.prefix || '';

        // Parse Redis URL and create client
        this.redis = new Redis(config.url, {
            commandTimeout: this.timeout,
            connectTimeout: this.timeout,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            enableOfflineQueue: true,
            retryStrategy: (times) => {
                const delay = Math.min(times * 200, 2000);
                console.log(`[Redis] Retry attempt ${times}, waiting ${delay}ms`);
                return delay;
            }
        });

        // Event handlers
        this.redis.on('connect', () => {
            this.isConnected = true;
            console.log('[Redis] Connected');
        });

        this.redis.on('error', (err) => {
            console.error('[Redis] Error:', err.message);
        });

        this.redis.on('close', () => {
            this.isConnected = false;
            console.log('[Redis] Connection closed');
        });
    }

    /**
     * Connect to Redis (call before using other methods)
     */
    async connect(): Promise<void> {
        if (this.isConnected) return;
        await this.redis.connect();
    }

    /**
     * Build the full Redis key with optional prefix
     */
    private buildKey(key: string): string {
        return this.prefix ? `${this.prefix}${key}` : key;
    }

    // ========================================================================
    // Basic Operations
    // ========================================================================

    async set(key: string, value: any): Promise<void> {
        const fullKey = this.buildKey(key);
        await this.redis.set(fullKey, JSON.stringify(value));
    }

    async get(key: string): Promise<any | null> {
        const fullKey = this.buildKey(key);
        const value = await this.redis.get(fullKey);
        if (value === null) return null;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    async delete(key: string): Promise<void> {
        const fullKey = this.buildKey(key);
        await this.redis.del(fullKey);
    }

    async countKeysWithPrefix(prefix: string): Promise<number> {
        const fullPrefix = this.buildKey(prefix);
        // Use SCAN to count keys (don't use KEYS in production)
        let count = 0;
        let cursor = '0';

        do {
            const [nextCursor, keys] = await this.redis.scan(
                cursor,
                'MATCH',
                `${fullPrefix}*`,
                'COUNT',
                1000
            );
            cursor = nextCursor;
            count += keys.length;
        } while (cursor !== '0');

        return count;
    }

    async health(): Promise<boolean> {
        try {
            const result = await this.redis.ping();
            return result === 'PONG';
        } catch {
            return false;
        }
    }

    // ========================================================================
    // Nested Key Architecture Methods
    // ========================================================================

    async setProperty(key: string, value: string): Promise<void> {
        const fullKey = this.buildKey(key);
        await this.redis.set(fullKey, value);
    }

    async getProperty(key: string): Promise<string | null> {
        const fullKey = this.buildKey(key);
        return await this.redis.get(fullKey);
    }

    async getRange(prefix: string): Promise<KeyValuePair[]> {
        const fullPrefix = this.buildKey(prefix);
        const pairs: KeyValuePair[] = [];
        let cursor = '0';

        do {
            const [nextCursor, keys] = await this.redis.scan(
                cursor,
                'MATCH',
                `${fullPrefix}*`,
                'COUNT',
                1000
            );
            cursor = nextCursor;

            if (keys.length > 0) {
                // Get values for all found keys
                const values = await this.redis.mget(...keys);
                keys.forEach((key, index) => {
                    const value = values[index];
                    if (value !== null) {
                        // Strip prefix to get original key
                        const originalKey = this.prefix
                            ? key.slice(this.prefix.length)
                            : key;
                        pairs.push({ key: originalKey, value });
                    }
                });
            }
        } while (cursor !== '0');

        return pairs;
    }

    async setMultiple(pairs: KeyValuePair[]): Promise<void> {
        if (pairs.length === 0) return;

        // Use pipeline for efficient batch operations
        const pipeline = this.redis.pipeline();

        for (const pair of pairs) {
            const fullKey = this.buildKey(pair.key);
            pipeline.set(fullKey, pair.value);
        }

        await pipeline.exec();
    }

    async deleteRange(prefix: string): Promise<number> {
        const fullPrefix = this.buildKey(prefix);
        let deletedCount = 0;
        let cursor = '0';

        do {
            const [nextCursor, keys] = await this.redis.scan(
                cursor,
                'MATCH',
                `${fullPrefix}*`,
                'COUNT',
                1000
            );
            cursor = nextCursor;

            if (keys.length > 0) {
                const deleted = await this.redis.del(...keys);
                deletedCount += deleted;
            }
        } while (cursor !== '0');

        return deletedCount;
    }

    // ========================================================================
    // High-Level Metadata Operations (Using Redis Hashes)
    // ========================================================================

    /**
     * Store file metadata using Redis hash
     * More efficient than individual keys - single HMSET command
     */
    async setMetadataFlat(
        hashId: string,
        metadata: any,
        excludeFields: string[] = []
    ): Promise<void> {
        const prefix = buildFilePrefix(hashId);
        const pairs = flattenMetadata(metadata, prefix, excludeFields);

        if (pairs.length === 0) return;

        // Convert to Redis hash format
        // Hash key: file:{hashId}
        // Hash fields: property paths (without /file/{hashId} prefix)
        const hashKey = this.buildKey(`file:${hashId}`);
        const hashData: Record<string, string> = {};

        for (const pair of pairs) {
            // Extract field name by removing the prefix
            const field = pair.key.slice(prefix.length + 1); // +1 for trailing /
            if (field) {
                hashData[field] = pair.value;
            }
        }

        if (Object.keys(hashData).length > 0) {
            await this.redis.hmset(hashKey, hashData);
        }

        // Also store in key index for getAllHashIds
        await this.redis.sadd(this.buildKey('file:__index__'), hashId);
    }

    async getMetadataFlat(hashId: string): Promise<any | null> {
        const hashKey = this.buildKey(`file:${hashId}`);
        const hashData = await this.redis.hgetall(hashKey);

        if (!hashData || Object.keys(hashData).length === 0) {
            return null;
        }

        // Convert Redis hash back to KeyValuePair format for reconstruction
        const prefix = buildFilePrefix(hashId);
        const pairs: KeyValuePair[] = Object.entries(hashData).map(([field, value]) => ({
            key: `${prefix}/${field}`,
            value: value as string
        }));

        return reconstructMetadata(pairs, prefix);
    }

    async getMetadata(hashId: string, propertyPath: string): Promise<any | null> {
        const hashKey = this.buildKey(`file:${hashId}`);
        const value = await this.redis.hget(hashKey, propertyPath);

        if (value === null) return null;

        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    async deleteMetadataFlat(hashId: string): Promise<number> {
        const hashKey = this.buildKey(`file:${hashId}`);
        const fieldCount = await this.redis.hlen(hashKey);

        await this.redis.del(hashKey);
        await this.redis.srem(this.buildKey('file:__index__'), hashId);

        return fieldCount;
    }

    async getAllHashIds(): Promise<string[]> {
        const indexKey = this.buildKey('file:__index__');
        return await this.redis.smembers(indexKey);
    }

    // ========================================================================
    // Pub/Sub Operations
    // ========================================================================

    /**
     * Publish a message to a Redis channel
     * Used for notifying other services (meta-fuse) about file changes
     * Note: Channel names are NOT prefixed - they use their own namespace
     */
    async publish(channel: string, message: string): Promise<number> {
        return await this.redis.publish(channel, message);
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    async close(): Promise<void> {
        await this.redis.quit();
        this.isConnected = false;
    }

    /**
     * Check if client is connected
     */
    isHealthy(): boolean {
        return this.isConnected;
    }

    /**
     * Get the underlying Redis client (for advanced operations)
     */
    getRedisClient(): RedisInstance {
        return this.redis;
    }
}
