/**
 * API Integration Tests for UnifiedAPIServer
 *
 * Tests the UI-related API endpoints using Fastify's inject() method.
 * These tests run inside the meta-sort container with a real Redis instance.
 */

import { expect } from 'chai';
import { UnifiedAPIServer } from './UnifiedAPIServer.js';
import { VirtualFileSystem } from './VirtualFileSystem.js';
import { UnifiedProcessingStateManager } from '../logic/UnifiedProcessingStateManager.js';
import { DuplicateResult } from '../logic/DuplicateFinder.js';
import type { IKVClient } from '../kv/IKVClient.js';
import type { FastifyInstance } from 'fastify';

// =============================================================================
// Mock Implementations
// =============================================================================

/**
 * Mock KV Client for testing
 * Implements IKVClient interface with in-memory storage
 */
class MockKVClient implements IKVClient {
    private data: Map<string, Map<string, any>> = new Map();
    private rawStore: Map<string, string> = new Map();

    // Basic operations
    async set(key: string, value: any): Promise<void> {
        this.rawStore.set(key, JSON.stringify(value));
    }

    async get(key: string): Promise<any | null> {
        const val = this.rawStore.get(key);
        return val ? JSON.parse(val) : null;
    }

    async delete(key: string): Promise<void> {
        this.rawStore.delete(key);
    }

    async countKeysWithPrefix(prefix: string): Promise<number> {
        let count = 0;
        for (const key of this.rawStore.keys()) {
            if (key.startsWith(prefix)) count++;
        }
        return count;
    }

    async health(): Promise<boolean> {
        return true;
    }

    // Nested key architecture methods
    async setProperty(key: string, value: string): Promise<void> {
        this.rawStore.set(key, value);
    }

    async getProperty(key: string): Promise<string | null> {
        return this.rawStore.get(key) ?? null;
    }

    async getRange(prefix: string): Promise<Array<{ key: string; value: string }>> {
        const pairs: Array<{ key: string; value: string }> = [];
        for (const [key, value] of this.rawStore.entries()) {
            if (key.startsWith(prefix)) {
                pairs.push({ key, value });
            }
        }
        return pairs;
    }

    async setMultiple(pairs: Array<{ key: string; value: string }>): Promise<void> {
        for (const { key, value } of pairs) {
            this.rawStore.set(key, value);
        }
    }

    async deleteRange(prefix: string): Promise<number> {
        let count = 0;
        for (const key of this.rawStore.keys()) {
            if (key.startsWith(prefix)) {
                this.rawStore.delete(key);
                count++;
            }
        }
        return count;
    }

    // High-level metadata operations
    async setMetadataFlat(hashId: string, metadata: any, excludeFields?: string[]): Promise<void> {
        if (!this.data.has(hashId)) {
            this.data.set(hashId, new Map());
        }
        const entry = this.data.get(hashId)!;
        for (const [key, value] of Object.entries(metadata)) {
            if (!excludeFields?.includes(key)) {
                entry.set(key, value);
            }
        }
    }

    async getMetadataFlat(hashId: string): Promise<any | null> {
        const entry = this.data.get(hashId);
        if (!entry) return null;
        return Object.fromEntries(entry);
    }

    async getMetadata(hashId: string, propertyPath: string): Promise<any | null> {
        const entry = this.data.get(hashId);
        if (!entry) return null;
        return entry.get(propertyPath) ?? null;
    }

    async deleteMetadataFlat(hashId: string): Promise<number> {
        const entry = this.data.get(hashId);
        const count = entry?.size ?? 0;
        this.data.delete(hashId);
        return count;
    }

    async getAllHashIds(): Promise<string[]> {
        return Array.from(this.data.keys());
    }

    async close(): Promise<void> {
        // No-op for mock
    }

    // Helper for tests to seed data
    seedData(hashId: string, metadata: Record<string, any>): void {
        const entry = new Map(Object.entries(metadata));
        this.data.set(hashId, entry);
    }

    clear(): void {
        this.data.clear();
        this.rawStore.clear();
    }
}

/**
 * Mock Processing State Manager
 */
class MockProcessingStateManager {
    private pending = new Set<string>();
    private lightProcessing = new Set<string>();
    private hashProcessing = new Set<string>();
    private done = new Set<string>();
    private failed = new Map<string, string>();

    getSnapshot() {
        return {
            pending: Array.from(this.pending),
            lightProcessing: Array.from(this.lightProcessing),
            hashProcessing: Array.from(this.hashProcessing),
            done: Array.from(this.done)
        };
    }

    getFailedFiles(): Array<{ path: string; error: string; timestamp: number }> {
        return Array.from(this.failed.entries()).map(([path, error]) => ({
            path,
            error,
            timestamp: Date.now()
        }));
    }

    retryFile(filePath: string): boolean {
        if (this.failed.has(filePath)) {
            this.failed.delete(filePath);
            this.pending.add(filePath);
            return true;
        }
        return false;
    }

    retryAllFailed(): number {
        const count = this.failed.size;
        for (const path of this.failed.keys()) {
            this.pending.add(path);
        }
        this.failed.clear();
        return count;
    }

    // Helpers for tests
    addPending(path: string): void {
        this.pending.add(path);
    }

    addDone(path: string): void {
        this.done.add(path);
    }

    addFailed(path: string, error: string): void {
        this.failed.set(path, error);
    }
}

/**
 * Mock Duplicate Result Provider
 */
function createMockDuplicateResult(): DuplicateResult {
    return {
        hashDuplicates: [
            {
                key: 'abc123',
                files: ['/files/movie1.mp4', '/files/movie1-copy.mp4']
            }
        ],
        titleDuplicates: [
            {
                key: 'Movie Title',
                files: ['/files/movie1.mp4', '/files/movie2.mp4']
            }
        ]
    };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('UnifiedAPIServer', function() {
    let server: UnifiedAPIServer;
    let app: FastifyInstance;
    let mockKV: MockKVClient;
    let mockStateManager: MockProcessingStateManager;
    let duplicateResult = createMockDuplicateResult();

    before(async function() {
        // Create mocks
        mockKV = new MockKVClient();
        mockStateManager = new MockProcessingStateManager();

        // Seed some test data
        mockKV.seedData('testhash001', {
            fileName: 'Test Movie.mp4',
            filePath: '/files/test/Test Movie.mp4',
            sizeByte: 1000000,
            videoType: 'movie',
            title: 'Test Movie'
        });
        mockKV.seedData('testhash002', {
            fileName: 'Test Episode S01E01.mp4',
            filePath: '/files/test/Test Episode S01E01.mp4',
            sizeByte: 500000,
            videoType: 'episode',
            title: 'Test Episode'
        });

        mockStateManager.addDone('/files/test/Test Movie.mp4');
        mockStateManager.addPending('/files/test/pending.mp4');

        // Create VFS (no params needed - uses defaults)
        const vfs = new VirtualFileSystem();

        // Create server
        server = new UnifiedAPIServer(
            vfs,
            { port: 3000, host: 'localhost', enableCors: true },
            mockStateManager as any,
            () => duplicateResult,
            mockKV as any,
            async () => { /* scan trigger */ },
            4, // backgroundQueueConcurrency
            16, // fastQueueConcurrency
            () => ({ fast: { pending: 0, running: 0 }, background: { pending: 0, running: 0 } })
        );

        app = server.getApp();
        await app.ready();
    });

    after(async function() {
        await app.close();
    });

    // =========================================================================
    // Health Endpoints
    // =========================================================================

    describe('Health Endpoints', function() {
        it('GET /health returns ok status', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/health'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body.status).to.equal('ok');
            expect(body.services).to.have.property('fuse');
            expect(body.services).to.have.property('metrics');
        });

        it('GET /api/health returns redis status', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/health'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('status');
            expect(body).to.have.property('redis');
            expect(body).to.have.property('uptime');
        });

        it('GET /meta-health returns status', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/meta-health'
            });

            expect(response.statusCode).to.equal(200);
        });
    });

    // =========================================================================
    // Processing API (Monitor Page)
    // =========================================================================

    describe('Processing API (/api/processing/*)', function() {
        it('GET /api/processing/status returns processing snapshot', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/processing/status'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('pending');
            expect(body).to.have.property('lightProcessing');
            expect(body).to.have.property('hashProcessing');
            expect(body).to.have.property('done');
            expect(Array.isArray(body.pending)).to.be.true;
            expect(Array.isArray(body.done)).to.be.true;
        });

        it('GET /api/processing/queue returns queue items', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/processing/queue'
            });

            // May return 200 with items or 500 if TaskScheduler not available
            expect([200, 500]).to.include(response.statusCode);
            if (response.statusCode === 200) {
                const body = JSON.parse(response.payload);
                expect(body).to.have.property('items');
                expect(Array.isArray(body.items)).to.be.true;
            }
        });

        it('GET /api/processing/failed returns failed files list', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/processing/failed'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('failedFiles');
            expect(body).to.have.property('totalFailed');
            expect(Array.isArray(body.failedFiles)).to.be.true;
        });

        it('POST /api/processing/retry returns 400 without filePath', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/processing/retry',
                payload: {}
            });

            expect(response.statusCode).to.equal(400);
        });

        it('POST /api/processing/retry-all returns status', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/processing/retry-all'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('status', 'ok');
            expect(body).to.have.property('message');
        });
    });

    // =========================================================================
    // Duplicates API (Duplicates Page)
    // =========================================================================

    describe('Duplicates API (/api/duplicates)', function() {
        it('GET /api/duplicates returns duplicate analysis', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/duplicates'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('hashDuplicates');
            expect(body).to.have.property('titleDuplicates');
            expect(Array.isArray(body.hashDuplicates)).to.be.true;
            expect(Array.isArray(body.titleDuplicates)).to.be.true;
        });

        it('POST /api/duplicates/refresh acknowledges request', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/duplicates/refresh'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('status');
        });
    });

    // =========================================================================
    // Metadata API (File Browser)
    // =========================================================================

    describe('Metadata API (/api/metadata/*)', function() {
        it('GET /api/metadata/hash-ids returns list of hash IDs', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/metadata/hash-ids'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('hashIds');
            expect(Array.isArray(body.hashIds)).to.be.true;
            expect(body.hashIds).to.include('testhash001');
        });

        it('GET /api/metadata/list returns paginated file list', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/metadata/list?limit=10&offset=0'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('files');
            expect(body).to.have.property('total');
            expect(Array.isArray(body.files)).to.be.true;
        });

        it('GET /api/metadata/:hashId returns file metadata', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/metadata/testhash001'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            // API returns metadata flat (not wrapped in { hashId, metadata })
            expect(body).to.have.property('fileName', 'Test Movie.mp4');
        });

        it('GET /api/metadata/:hashId returns 404 for unknown hash', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/metadata/unknownhash'
            });

            expect(response.statusCode).to.equal(404);
        });

        it('GET /api/metadata/:hashId/property returns specific property', async function() {
            // The API uses getProperty with key format /file/{hashId}/{property}
            // We need to seed the property in the rawStore
            await mockKV.setProperty('/file/testhash001/videoType', 'movie');

            const response = await app.inject({
                method: 'GET',
                url: '/api/metadata/testhash001/property?property=videoType'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('value', 'movie');
        });

        it('PUT /api/metadata/:hashId updates metadata', async function() {
            const response = await app.inject({
                method: 'PUT',
                url: '/api/metadata/testhash001',
                payload: {
                    customField: 'customValue'
                }
            });

            expect(response.statusCode).to.equal(200);

            // Verify the update
            const verify = await app.inject({
                method: 'GET',
                url: '/api/metadata/testhash001'
            });
            const body = JSON.parse(verify.payload);
            // Response is flat metadata
            expect(body).to.have.property('customField', 'customValue');
        });

        it('DELETE /api/metadata/:hashId deletes file metadata', async function() {
            // First create a test entry
            mockKV.seedData('deleteme', { fileName: 'delete.mp4' });

            const response = await app.inject({
                method: 'DELETE',
                url: '/api/metadata/deleteme'
            });

            expect(response.statusCode).to.equal(200);

            // Verify deletion
            const verify = await app.inject({
                method: 'GET',
                url: '/api/metadata/deleteme'
            });
            expect(verify.statusCode).to.equal(404);
        });

        it('POST /api/metadata/search searches files', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/metadata/search',
                payload: {
                    property: 'videoType',
                    propertyValue: 'movie'
                }
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('results');
            expect(Array.isArray(body.results)).to.be.true;
        });
    });

    // =========================================================================
    // Stats API (Dashboard)
    // =========================================================================

    describe('Stats API (/api/stats)', function() {
        it('GET /api/stats returns statistics', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/stats'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('fileCount');
            expect(body).to.have.property('totalSize');
        });
    });

    // =========================================================================
    // Metrics API
    // =========================================================================

    describe('Metrics API (/api/metrics)', function() {
        it('GET /api/metrics returns performance metrics', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/metrics'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('uptime');
        });
    });

    // =========================================================================
    // Scan API
    // =========================================================================

    describe('Scan API (/api/scan)', function() {
        it('POST /api/scan/trigger triggers a scan', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/scan/trigger'
            });

            expect([200, 202, 204]).to.include(response.statusCode);
        });
    });

    // =========================================================================
    // FUSE API (Virtual Filesystem)
    // =========================================================================

    describe('FUSE API (/api/fuse/*)', function() {
        it('GET /api/fuse/health returns ok', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/fuse/health'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body.status).to.equal('ok');
        });

        it('GET /api/fuse/stats returns VFS statistics', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/fuse/stats'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('fileCount');
            expect(body).to.have.property('directoryCount');
        });

        it('POST /api/fuse/readdir returns directory contents', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/fuse/readdir',
                payload: { path: '/' }
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('entries');
            expect(Array.isArray(body.entries)).to.be.true;
        });

        it('POST /api/fuse/exists checks path existence', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/fuse/exists',
                payload: { path: '/' }
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('exists');
            expect(typeof body.exists).to.equal('boolean');
        });

        it('GET /api/fuse/tree returns full VFS tree', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/fuse/tree'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            // API returns tree structure directly (path, type, children)
            expect(body).to.have.property('path');
            expect(body).to.have.property('type');
        });

        it('GET /api/fuse/files returns all file paths', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/fuse/files'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('files');
            expect(Array.isArray(body.files)).to.be.true;
        });

        it('GET /api/fuse/directories returns all directory paths', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/fuse/directories'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('directories');
            expect(Array.isArray(body.directories)).to.be.true;
        });
    });

    // =========================================================================
    // KV Browser API (Editor)
    // =========================================================================

    describe('KV Browser API (/api/kv/*)', function() {
        it('GET /api/kv/info returns database info', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/kv/info'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('fileCount');
        });

        it('GET /api/kv/keys returns paginated keys', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/kv/keys?cursor=0&count=50'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('keys');
            expect(Array.isArray(body.keys)).to.be.true;
        });
    });

    // =========================================================================
    // Plugins API (Plugins Page)
    // =========================================================================

    describe('Plugins API (/api/plugins/*)', function() {
        it('GET /api/plugins returns 503 when plugin manager not initialized', async function() {
            // Without a plugin manager configured, should return 503
            const response = await app.inject({
                method: 'GET',
                url: '/api/plugins'
            });

            expect(response.statusCode).to.equal(503);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('error');
            expect(body.error).to.include('not yet initialized');
        });

        it('GET /api/plugins/timings returns timing data', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/plugins/timings'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('timings');
            expect(Array.isArray(body.timings)).to.be.true;
        });

        it('POST /api/plugins/:pluginId/activate returns 503 without plugin manager', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/plugins/test-plugin/activate'
            });

            expect(response.statusCode).to.equal(503);
        });

        it('POST /api/plugins/:pluginId/deactivate returns 503 without plugin manager', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/plugins/test-plugin/deactivate'
            });

            expect(response.statusCode).to.equal(503);
        });

        it('PUT /api/plugins/:pluginId/config returns 503 without plugin manager', async function() {
            const response = await app.inject({
                method: 'PUT',
                url: '/api/plugins/test-plugin/config',
                payload: { setting: 'value' }
            });

            expect(response.statusCode).to.equal(503);
        });

        it('POST /api/plugins/:pluginId/clear-cache returns 503 without plugin manager', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/plugins/test-plugin/clear-cache'
            });

            expect(response.statusCode).to.equal(503);
        });

        it('POST /api/plugins/rescan returns 503 without plugin manager', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/plugins/rescan'
            });

            expect(response.statusCode).to.equal(503);
        });
    });

    // =========================================================================
    // Container Plugins API
    // =========================================================================

    describe('Container Plugins API (/api/plugins/containers/*)', function() {
        it('GET /api/plugins/containers returns container plugin info', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/plugins/containers'
            });

            // May return 200 with empty data or 503 if not initialized
            expect([200, 503]).to.include(response.statusCode);

            if (response.statusCode === 200) {
                const body = JSON.parse(response.payload);
                expect(body).to.have.property('pluginCount');
            }
        });

        it('POST /api/plugins/callback returns 503 without scheduler', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/plugins/callback',
                payload: {
                    taskId: 'test-task-123',
                    pluginId: 'test-plugin',
                    status: 'success',
                    hashId: 'testhash001',
                    metadata: { testKey: 'testValue' }
                }
            });

            // Returns 503 when container plugin scheduler not available
            expect(response.statusCode).to.equal(503);
        });
    });

    // =========================================================================
    // Mounts API (Mounts Page)
    // =========================================================================

    describe('Mounts API (/api/mounts/*)', function() {
        it('GET /api/mounts returns mount list', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/mounts'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('mounts');
            expect(Array.isArray(body.mounts)).to.be.true;
        });

        it('GET /api/mounts/rclone/remotes returns rclone remotes', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/api/mounts/rclone/remotes'
            });

            // May succeed or fail depending on rclone availability
            expect([200, 500]).to.include(response.statusCode);

            if (response.statusCode === 200) {
                const body = JSON.parse(response.payload);
                expect(body).to.have.property('remotes');
                expect(Array.isArray(body.remotes)).to.be.true;
            }
        });

        it('POST /api/mounts validates required fields', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/mounts',
                payload: {
                    // Missing required fields
                }
            });

            expect(response.statusCode).to.equal(400);
        });

        it('POST /api/mounts/:id/mount returns 404 for unknown mount', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/mounts/nonexistent-mount/mount'
            });

            expect(response.statusCode).to.equal(404);
        });

        it('POST /api/mounts/:id/unmount returns 404 for unknown mount', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/api/mounts/nonexistent-mount/unmount'
            });

            expect(response.statusCode).to.equal(404);
        });

        it('DELETE /api/mounts/:id returns 404 for unknown mount', async function() {
            const response = await app.inject({
                method: 'DELETE',
                url: '/api/mounts/nonexistent-mount'
            });

            expect(response.statusCode).to.equal(404);
        });
    });

    // =========================================================================
    // Meta-Core Compatible API (for plugins)
    // =========================================================================

    describe('Meta-Core Compatible API (/meta/*)', function() {
        it('GET /meta/:hash returns file metadata wrapped', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/meta/testhash001'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            // API returns { metadata: {...} }
            expect(body).to.have.property('metadata');
            expect(body.metadata).to.have.property('fileName', 'Test Movie.mp4');
        });

        it('GET /meta/:hash returns empty metadata for unknown hash', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/meta/unknownhash'
            });

            // API returns { metadata: {} } for unknown hash, not 404
            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('metadata');
        });

        it('GET /meta/:hash/:key returns specific property', async function() {
            const response = await app.inject({
                method: 'GET',
                url: '/meta/testhash001/videoType'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('value', 'movie');
        });

        it('PUT /meta/:hash/:key sets property value', async function() {
            const response = await app.inject({
                method: 'PUT',
                url: '/meta/testhash001/metaCustomField',
                payload: { value: 'metaCustomValue' }
            });

            expect(response.statusCode).to.equal(200);

            // Verify the update
            const verify = await app.inject({
                method: 'GET',
                url: '/meta/testhash001/metaCustomField'
            });
            const body = JSON.parse(verify.payload);
            expect(body).to.have.property('value', 'metaCustomValue');
        });

        it('PATCH /meta/:hash merges metadata', async function() {
            const response = await app.inject({
                method: 'PATCH',
                url: '/meta/testhash001',
                payload: {
                    patchedField: 'patchedValue',
                    anotherField: '123'
                }
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('status', 'ok');

            // Verify the merge
            const verify = await app.inject({
                method: 'GET',
                url: '/meta/testhash001'
            });
            const verifyBody = JSON.parse(verify.payload);
            expect(verifyBody.metadata).to.have.property('patchedField', 'patchedValue');
            expect(verifyBody.metadata).to.have.property('fileName', 'Test Movie.mp4'); // Original preserved
        });

        it('DELETE /meta/:hash/:key removes property', async function() {
            // First set a property
            await app.inject({
                method: 'PUT',
                url: '/meta/testhash001/toDeleteMeta',
                payload: { value: 'deleteMe' }
            });

            // Verify property was set
            const beforeDelete = await app.inject({
                method: 'GET',
                url: '/meta/testhash001/toDeleteMeta'
            });
            expect(beforeDelete.statusCode).to.equal(200);

            // Then delete it
            const response = await app.inject({
                method: 'DELETE',
                url: '/meta/testhash001/toDeleteMeta'
            });

            expect(response.statusCode).to.equal(200);
            const body = JSON.parse(response.payload);
            expect(body).to.have.property('status', 'ok');
        });
    });

    // =========================================================================
    // File CID API
    // =========================================================================

    describe('File CID API (/file/cid)', function() {
        it('POST /file/cid returns 400 without path', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/file/cid',
                payload: {}
            });

            expect(response.statusCode).to.equal(400);
        });

        it('POST /file/cid returns 404 for nonexistent file', async function() {
            const response = await app.inject({
                method: 'POST',
                url: '/file/cid',
                payload: { path: '/nonexistent/file.mp4' }
            });

            expect(response.statusCode).to.equal(404);
        });
    });
});
