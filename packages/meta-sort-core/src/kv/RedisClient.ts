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
import * as os from 'os';
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

/**
 * Stream message from Redis Streams
 * File events from meta-core: add, change, delete, rename
 */
export interface StreamMessage {
    id: string;
    type: 'add' | 'change' | 'delete' | 'rename';
    path: string;
    size?: string;
    partialHash?: string;
    oldPath?: string;
    timestamp: string;
}

/**
 * Stream consumer callback
 */
export type StreamMessageHandler = (message: StreamMessage) => Promise<void>;

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

    // Stream consumer state
    private streamConsumerRunning = false;
    private streamConsumerAbort: AbortController | null = null;
    private consumerName: string;

    constructor(config: RedisClientConfig) {
        this.timeout = config.timeout || 30000;
        this.prefix = config.prefix || '';

        // Unique consumer name for this instance
        this.consumerName = `${os.hostname()}-${process.pid}`;

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

    /**
     * Set a single metadata property for a file
     * Writes directly to Redis hash field
     */
    async setMetadataProperty(hashId: string, property: string, value: string): Promise<void> {
        const hashKey = this.buildKey(`file:${hashId}`);
        await this.redis.hset(hashKey, property, value);

        // Also ensure the file is in the index
        await this.redis.sadd(this.buildKey('file:__index__'), hashId);
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
    // Redis Streams Operations
    // ========================================================================

    /**
     * Add an entry to a Redis stream
     * Used for reliable event delivery between services (replaces pub/sub)
     *
     * @param stream - Stream name (e.g., 'meta-sort:events')
     * @param maxlen - Maximum stream length (approximate, uses ~ for efficiency)
     * @param fields - Object containing field-value pairs to add
     * @returns The ID of the added entry
     */
    async xadd(stream: string, maxlen: number, fields: Record<string, string>): Promise<string> {
        // Convert fields object to flat array for ioredis
        const fieldArray: string[] = [];
        for (const [key, value] of Object.entries(fields)) {
            fieldArray.push(key, value);
        }

        // Use XADD with MAXLEN ~ for approximate trimming (more efficient)
        const result = await this.redis.xadd(
            stream,
            'MAXLEN',
            '~',
            maxlen.toString(),
            '*',
            ...fieldArray
        );

        return result as string;
    }

    // ========================================================================
    // Redis Streams Consumer Methods
    // ========================================================================

    /**
     * Initialize stream consumer group
     * Creates the consumer group at position 0 to read all historical events
     *
     * @param stream - Stream name (e.g., 'file:events')
     * @param group - Consumer group name (e.g., 'meta-sort-processor')
     */
    async initStreamConsumer(stream: string, group: string): Promise<void> {
        try {
            // Create consumer group at position 0 (read all historical events)
            // MKSTREAM creates the stream if it doesn't exist
            await this.redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
            console.log(`[Redis] Created consumer group '${group}' for stream '${stream}'`);
        } catch (error: any) {
            // BUSYGROUP means group already exists - that's fine
            if (error.message?.includes('BUSYGROUP')) {
                console.log(`[Redis] Consumer group '${group}' already exists`);
            } else {
                throw error;
            }
        }
    }

    /**
     * Process pending entries from crashed consumers
     * Uses XAUTOCLAIM to claim entries that have been idle too long
     *
     * @param stream - Stream name
     * @param group - Consumer group name
     * @param minIdleTime - Minimum idle time in ms before claiming (default: 30000)
     * @param onMessage - Handler for each message
     */
    async processPendingEntries(
        stream: string,
        group: string,
        minIdleTime: number = 30000,
        onMessage: StreamMessageHandler
    ): Promise<number> {
        let processed = 0;
        let cursor = '0-0';

        try {
            while (true) {
                // XAUTOCLAIM claims idle entries and returns them
                const result = await this.redis.xautoclaim(
                    stream,
                    group,
                    this.consumerName,
                    minIdleTime,
                    cursor,
                    'COUNT',
                    100
                ) as [string, Array<[string, string[]]>, string[]];

                const [nextCursor, entries] = result;
                cursor = nextCursor;

                if (!entries || entries.length === 0) {
                    break;
                }

                for (const [id, fields] of entries) {
                    try {
                        const message = this.parseStreamEntry(id, fields);
                        if (message) {
                            await onMessage(message);
                            // ACK the message after successful processing
                            await this.redis.xack(stream, group, id);
                            processed++;
                        }
                    } catch (error: any) {
                        console.error(`[Redis] Error processing pending entry ${id}:`, error.message);
                    }
                }

                // If cursor is 0-0, we've processed all pending entries
                if (cursor === '0-0') {
                    break;
                }
            }

            if (processed > 0) {
                console.log(`[Redis] Processed ${processed} pending stream entries`);
            }
        } catch (error: any) {
            console.error('[Redis] Error processing pending entries:', error.message);
        }

        return processed;
    }

    /**
     * Start stream consumer loop
     * Reads messages using XREADGROUP and calls the handler
     *
     * @param stream - Stream name
     * @param group - Consumer group name
     * @param onMessage - Handler for each message
     * @param blockMs - Block timeout in ms (default: 5000)
     */
    async startStreamConsumer(
        stream: string,
        group: string,
        onMessage: StreamMessageHandler,
        blockMs: number = 5000
    ): Promise<void> {
        if (this.streamConsumerRunning) {
            console.warn('[Redis] Stream consumer already running');
            return;
        }

        this.streamConsumerRunning = true;
        this.streamConsumerAbort = new AbortController();

        console.log(`[Redis] Starting stream consumer: ${stream} (group: ${group}, consumer: ${this.consumerName})`);

        // Consumer loop
        while (this.streamConsumerRunning && !this.streamConsumerAbort.signal.aborted) {
            try {
                // XREADGROUP blocks waiting for new messages
                // '>' means only read new messages (not already delivered to this consumer)
                const result = await (this.redis.call(
                    'XREADGROUP',
                    'GROUP', group,
                    this.consumerName,
                    'BLOCK', blockMs,
                    'COUNT', 10,
                    'STREAMS', stream,
                    '>'
                ) as Promise<Array<[string, Array<[string, string[]]>]> | null>);

                if (!result || result.length === 0) {
                    continue; // Timeout, loop again
                }

                // Process each stream's messages
                for (const [streamName, entries] of result) {
                    for (const [id, fields] of entries) {
                        try {
                            const message = this.parseStreamEntry(id, fields);
                            if (message) {
                                await onMessage(message);
                                // ACK the message after successful processing
                                await this.redis.xack(stream, group, id);
                            }
                        } catch (error: any) {
                            console.error(`[Redis] Error processing stream entry ${id}:`, error.message);
                            // Don't ACK on error - message will be reprocessed
                        }
                    }
                }
            } catch (error: any) {
                if (this.streamConsumerAbort?.signal.aborted) {
                    break;
                }
                console.error('[Redis] Stream consumer error:', error.message);
                // Brief pause before retrying
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log('[Redis] Stream consumer stopped');
    }

    /**
     * Stop the stream consumer loop
     */
    stopStreamConsumer(): void {
        if (!this.streamConsumerRunning) {
            return;
        }

        console.log('[Redis] Stopping stream consumer...');
        this.streamConsumerRunning = false;
        this.streamConsumerAbort?.abort();
        this.streamConsumerAbort = null;
    }

    /**
     * Parse a stream entry into a StreamMessage
     */
    private parseStreamEntry(id: string, fields: string[]): StreamMessage | null {
        // Fields come as flat array: ['type', 'add', 'path', '...', 'timestamp', '123']
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
            fieldMap[fields[i]] = fields[i + 1];
        }

        if (!fieldMap.type) {
            console.warn(`[Redis] Invalid stream entry ${id}: missing type`);
            return null;
        }

        if (!fieldMap.path) {
            console.warn(`[Redis] Invalid stream entry ${id}: missing path for ${fieldMap.type} event`);
            return null;
        }

        return {
            id,
            type: fieldMap.type as StreamMessage['type'],
            path: fieldMap.path,
            size: fieldMap.size,
            partialHash: fieldMap.partialHash,
            oldPath: fieldMap.oldPath,
            timestamp: fieldMap.timestamp || '0',
        };
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    async close(): Promise<void> {
        // Stop stream consumer first
        this.stopStreamConsumer();
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
