/**
 * Plugin Context Implementation
 *
 * Provides KV store, cache, and logger implementations for plugins.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { MetadataNode } from '@metazla/meta-interface';
import type {
    PluginKVStore,
    PluginCache,
    PluginLogger,
    PluginContext,
    PluginLifecycleContext,
} from './types.js';

// =============================================================================
// KV Store Implementation
// =============================================================================

/**
 * In-memory KV store implementation with path-style keys
 */
export class KVStore implements PluginKVStore {
    private data: Map<string, string> = new Map();

    constructor(initialData?: Map<string, string> | Record<string, string>) {
        if (initialData) {
            if (initialData instanceof Map) {
                this.data = new Map(initialData);
            } else {
                for (const [key, value] of Object.entries(initialData)) {
                    if (typeof value === 'string') {
                        this.data.set(key, value);
                    }
                }
            }
        }
    }

    get(key: string): string | undefined {
        return this.data.get(key);
    }

    set(key: string, value: string): void {
        if (key === undefined || key === null || key === '') {
            return;
        }
        if (value === undefined || value === null) {
            return;
        }
        this.data.set(key, String(value));
    }

    delete(key: string): void {
        this.data.delete(key);
    }

    keys(prefix?: string): string[] {
        const allKeys = Array.from(this.data.keys());
        if (!prefix) {
            return allKeys;
        }
        return allKeys.filter(k => k.startsWith(prefix));
    }

    entries(prefix?: string): Array<[string, string]> {
        const allEntries = Array.from(this.data.entries());
        if (!prefix) {
            return allEntries;
        }
        return allEntries.filter(([k]) => k.startsWith(prefix));
    }

    /**
     * Get all data as a plain object (for serialization)
     */
    toObject(): Record<string, string> {
        const obj: Record<string, string> = {};
        this.data.forEach((value, key) => {
            obj[key] = value;
        });
        return obj;
    }

    /**
     * Get the underlying Map
     */
    toMap(): Map<string, string> {
        return new Map(this.data);
    }

    /**
     * Clear all data
     */
    clear(): void {
        this.data.clear();
    }
}

// =============================================================================
// MetadataNode KV Store Adapter
// =============================================================================

/**
 * KV store that wraps MetadataNode from @metazla/meta-interface.
 * This ensures plugins output the same nested object format as the old processors.
 *
 * Path conversion:
 * - 'fileType' -> metadata.at('fileType')
 * - 'fileinfo/duration' -> metadata.at('fileinfo').at('duration')
 * - 'fileinfo/streamdetails/video/0/codec' -> metadata.at('fileinfo').at('streamdetails').at('video').at('0').at('codec')
 */
export class MetadataNodeKVStore implements PluginKVStore {
    private metadata: MetadataNode<any>;

    constructor(metadata: MetadataNode<any>) {
        this.metadata = metadata;
    }

    /**
     * Navigate to a nested node using path segments
     */
    private navigate(key: string): MetadataNode<any> {
        const parts = key.split('/');
        let node = this.metadata;
        for (const part of parts) {
            node = node.at(part);
        }
        return node;
    }

    get(key: string): string | undefined {
        try {
            const value = this.navigate(key).get();
            if (value === undefined || value === null) {
                return undefined;
            }
            if (typeof value === 'string') {
                return value;
            }
            if (typeof value === 'object') {
                // Return undefined for objects (indicates path to nested data)
                return undefined;
            }
            return String(value);
        } catch {
            return undefined;
        }
    }

    set(key: string, value: string): void {
        if (key === undefined || key === null || key === '') {
            return;
        }
        if (value === undefined || value === null) {
            return;
        }
        try {
            this.navigate(key).set(String(value));
        } catch (e) {
            console.error(`[MetadataNodeKVStore] Error setting ${key}:`, e);
        }
    }

    delete(key: string): void {
        // MetadataNode doesn't have a delete method, so we set to undefined
        try {
            this.navigate(key).set(undefined as any);
        } catch {
            // Ignore errors
        }
    }

    /**
     * Get keys is not easily supported by MetadataNode.
     * This returns an empty array - plugins should track their own keys if needed.
     */
    keys(prefix?: string): string[] {
        // MetadataNode doesn't expose iteration over keys
        // Plugins that need to iterate should use the metadata object directly
        console.warn('[MetadataNodeKVStore] keys() not supported - use metadata.get() for object inspection');
        return [];
    }

    entries(prefix?: string): Array<[string, string]> {
        console.warn('[MetadataNodeKVStore] entries() not supported - use metadata.get() for object inspection');
        return [];
    }

    /**
     * Get the underlying MetadataNode
     */
    getMetadataNode(): MetadataNode<any> {
        return this.metadata;
    }

    /**
     * Add a value to a set (for RecordSet fields like genres, tags)
     */
    add(key: string, value: string): void {
        if (key === undefined || key === null || key === '') {
            return;
        }
        if (value === undefined || value === null) {
            return;
        }
        try {
            this.navigate(key).add(value);
        } catch (e) {
            console.error(`[MetadataNodeKVStore] Error adding to ${key}:`, e);
        }
    }

    /**
     * Get full object at a path (for inspecting nested structures)
     */
    getObject(key: string): any {
        try {
            return this.navigate(key).get();
        } catch {
            return undefined;
        }
    }
}

// =============================================================================
// Cache Implementation
// =============================================================================

/**
 * File-based cache implementation for plugins
 */
export class PluginCacheImpl implements PluginCache {
    private cacheDir: string;
    private initialized: boolean = false;

    constructor(cacheDir: string) {
        this.cacheDir = cacheDir;
    }

    private ensureDir(): void {
        if (!this.initialized) {
            if (!existsSync(this.cacheDir)) {
                mkdirSync(this.cacheDir, { recursive: true });
            }
            this.initialized = true;
        }
    }

    getPath(filename: string): string {
        this.ensureDir();
        return path.join(this.cacheDir, filename);
    }

    async readJson<T>(filename: string): Promise<T | null> {
        try {
            const filePath = this.getPath(filename);
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data) as T;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async writeJson(filename: string, data: unknown): Promise<void> {
        this.ensureDir();
        const filePath = this.getPath(filename);
        const dir = path.dirname(filePath);
        if (!existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true });
        }
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    }

    async exists(filename: string): Promise<boolean> {
        try {
            await fs.access(this.getPath(filename));
            return true;
        } catch {
            return false;
        }
    }

    async delete(filename: string): Promise<void> {
        try {
            await fs.unlink(this.getPath(filename));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }

    async clear(): Promise<void> {
        try {
            const files = await fs.readdir(this.cacheDir);
            await Promise.all(
                files.map(file => fs.unlink(path.join(this.cacheDir, file)).catch(() => {}))
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }
}

// =============================================================================
// Logger Implementation
// =============================================================================

/**
 * Scoped logger implementation for plugins
 */
export class PluginLoggerImpl implements PluginLogger {
    private prefix: string;

    constructor(pluginId: string) {
        this.prefix = `[plugin:${pluginId}]`;
    }

    debug(message: string, ...args: unknown[]): void {
        console.debug(this.prefix, message, ...args);
    }

    info(message: string, ...args: unknown[]): void {
        console.info(this.prefix, message, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        console.warn(this.prefix, message, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        console.error(this.prefix, message, ...args);
    }
}

// =============================================================================
// Context Factory
// =============================================================================

/**
 * Create a lifecycle context for a plugin
 */
export function createLifecycleContext(
    pluginId: string,
    config: Record<string, unknown>,
    cacheDir: string
): PluginLifecycleContext {
    return {
        config,
        cacheDir,
        log: new PluginLoggerImpl(pluginId),
    };
}

/**
 * Create a full plugin context for file processing
 */
export function createPluginContext(
    pluginId: string,
    filePath: string,
    kv: PluginKVStore,
    config: Record<string, unknown>,
    cacheDir: string,
    metadata?: any
): PluginContext {
    const ctx: PluginContext = {
        kv,
        filePath,
        config,
        cacheDir,
        cache: new PluginCacheImpl(cacheDir),
        log: new PluginLoggerImpl(pluginId),
    };

    // If kv is a MetadataNodeKVStore, extract the MetadataNode
    if (metadata) {
        ctx.metadata = metadata;
    } else if (kv instanceof MetadataNodeKVStore) {
        ctx.metadata = kv.getMetadataNode();
    }

    return ctx;
}
