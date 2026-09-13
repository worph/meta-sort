/**
 * API Integration Tests for UnifiedAPIServer
 *
 * Tests the UI-related API endpoints using Fastify's inject() method.
 * These tests run inside the meta-sort container with a real Redis instance.
 */

import { expect } from 'chai';
import { UnifiedAPIServer } from './UnifiedAPIServer.js';
import { UnifiedProcessingStateManager } from '../logic/UnifiedProcessingStateManager.js';
import { performanceMetrics } from '../metrics/PerformanceMetrics.js';
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

    // Stand-in for meta-core's GET /api/files/tuples. null = a meta-core that
    // predates the endpoint.
    fileTuples: Array<{ hashId: string; filePath: string; sizeByte: number; mtimeNano: number }> | null = null;
    fileTuplesDelayMs = 0;
    calls = { getFileTuples: 0, getAllHashIds: 0, getMetadataFlat: 0 };

    async getFileTuples(opts: { summary?: boolean } = {}) {
        this.calls.getFileTuples++;
        if (this.fileTuplesDelayMs) {
            await new Promise(resolve => setTimeout(resolve, this.fileTuplesDelayMs));
        }
        if (!this.fileTuples) return null;
        const files = this.fileTuples;
        const totalSize = files.reduce((sum, f) => sum + f.sizeByte, 0);
        return opts.summary
            ? { count: files.length, totalSize }
            : { count: files.length, totalSize, files };
    }

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
        this.calls.getMetadataFlat++;
        const entry = this.data.get(hashId);
        if (!entry) return null;
        return Object.fromEntries(entry);
    }

    async getMetadata(hashId: string, propertyPath: string): Promise<any | null> {
        const entry = this.data.get(hashId);
        if (!entry) return null;
        return entry.get(propertyPath) ?? null;
    }

    async setMetadataProperty(hashId: string, property: string, value: string): Promise<void> {
        if (!this.data.has(hashId)) {
            this.data.set(hashId, new Map());
        }
        this.data.get(hashId)!.set(property, value);
    }

    async deleteMetadataFlat(hashId: string): Promise<number> {
        const entry = this.data.get(hashId);
        const count = entry?.size ?? 0;
        this.data.delete(hashId);
        return count;
    }

    async getAllHashIds(): Promise<string[]> {
        this.calls.getAllHashIds++;
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
    addDiscovered(path: string): void {
        this.pending.add(path);
    }

    addDone(path: string): void {
        this.done.add(path);
    }

    addFailed(path: string, error: string): void {
        this.failed.set(path, error);
    }
}

// NOTE: Duplicates API has been moved to meta-dup service (port 8183)

// =============================================================================
// Test Suite
// =============================================================================

describe('UnifiedAPIServer', function() {
    let server: UnifiedAPIServer;
    let app: FastifyInstance;
    let mockKV: MockKVClient;
    let mockStateManager: MockProcessingStateManager;

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
        mockStateManager.addDiscovered('/files/test/pending.mp4');

        // Create server
        server = new UnifiedAPIServer(
            { port: 3000, host: 'localhost', enableCors: true },
            mockStateManager as any,
            mockKV as any,
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

    // NOTE: Duplicates API has been moved to meta-dup service (port 8183)
    // See dev/test/suites/meta-dup.bats for duplicate detection tests

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

    // NOTE: /api/scan/trigger has been removed from meta-sort (Architecture V3)
    // Scan is now handled by meta-core. Tests for scan trigger are in core.bats.

    // NOTE: FUSE API (/api/fuse/*) has been moved to meta-fuse service.

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
    // Mounts API (Mounts Page) - SKIPPED in Architecture V3 (moved to meta-core)
    // =========================================================================

    describe.skip('Mounts API (/api/mounts/*)', function() {
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

// =============================================================================
// File totals + recompute against meta-core's GET /api/files/tuples
// =============================================================================
//
// Each test builds its own server: /api/stats caches for 30 s and recompute is
// single-flight, so shared state between tests would hide both behaviours.

describe('UnifiedAPIServer file totals and recompute', function() {
    const tuple = (hashId: string, sizeByte: number) =>
        ({ hashId, filePath: `/files/watch/${hashId}.mkv`, sizeByte, mtimeNano: 1 });

    let app: FastifyInstance;
    let kv: MockKVClient;
    let queued: Array<{ pluginId: string; fileHash: string }>;

    beforeEach(async function() {
        kv = new MockKVClient();
        queued = [];
        const pluginManager = { getPlugins: () => [{ id: 'ffmpeg', active: true }] };
        const taskScheduler = {
            createTasksForPluginOnFiles: (pluginId: string, files: Array<{ fileHash: string }>) =>
                files.map(f => ({ pluginId, fileHash: f.fileHash })),
            enqueueTasks: (tasks: Array<{ pluginId: string; fileHash: string }>) => { queued.push(...tasks); },
        };
        const server = new UnifiedAPIServer(
            { port: 0, host: 'localhost', enableCors: false },
            new MockProcessingStateManager() as any,
            kv as any,
            4,
            16,
            () => ({ fast: { pending: 0, running: 0 }, background: { pending: 0, running: 0 } }),
            undefined,
            () => pluginManager as any,
            () => taskScheduler as any
        );
        app = server.getApp();
        await app.ready();
    });

    afterEach(async function() {
        await app.close();
    });

    it('GET /api/stats sums meta-core file tuples without walking hash ids', async function() {
        kv.fileTuples = [tuple('a', 100), tuple('b', 250)];

        const response = await app.inject({ method: 'GET', url: '/api/stats' });

        expect(response.statusCode).to.equal(200);
        expect(JSON.parse(response.payload)).to.deep.equal({ fileCount: 2, totalSize: 350, source: 'meta-core' });
        expect(kv.calls.getAllHashIds).to.equal(0);
        expect(kv.calls.getMetadataFlat).to.equal(0);
    });

    it('GET /api/stats degrades to nulls on a meta-core without the endpoint', async function() {
        kv.fileTuples = null;

        const response = await app.inject({ method: 'GET', url: '/api/stats' });

        expect(response.statusCode).to.equal(200);
        expect(JSON.parse(response.payload)).to.deep.equal({ fileCount: null, totalSize: null, source: 'unavailable' });
        expect(kv.calls.getAllHashIds).to.equal(0);
    });

    it('GET /api/stats shares one meta-core call between concurrent polls', async function() {
        kv.fileTuples = [tuple('a', 100)];
        kv.fileTuplesDelayMs = 50;

        const responses = await Promise.all(
            Array.from({ length: 10 }, () => app.inject({ method: 'GET', url: '/api/stats' }))
        );

        for (const response of responses) {
            expect(response.statusCode).to.equal(200);
            expect(JSON.parse(response.payload).totalSize).to.equal(100);
        }
        expect(kv.calls.getFileTuples).to.equal(1);
    });

    it('POST recompute returns 501 on a meta-core without the endpoint', async function() {
        kv.fileTuples = null;

        const response = await app.inject({ method: 'POST', url: '/api/plugins/ffmpeg/recompute' });

        expect(response.statusCode).to.equal(501);
        expect(kv.calls.getAllHashIds).to.equal(0);
        expect(queued).to.have.length(0);
    });

    it('POST recompute queues only file-backed records', async function() {
        kv.seedData('a', { filePath: '/files/watch/a.mkv', fileType: 'video' });
        kv.seedData('b', { filePath: '/files/watch/b.mkv', fileType: 'video' });
        kv.seedData('gateway-record', { title: 'Not a file' });
        kv.fileTuples = [tuple('a', 100), tuple('b', 250)];

        const response = await app.inject({ method: 'POST', url: '/api/plugins/ffmpeg/recompute' });

        expect(response.statusCode).to.equal(200);
        const body = JSON.parse(response.payload);
        expect(body.filesQueued).to.equal(2);
        expect(body.totalFiles).to.equal(2);
        expect(queued.map(q => q.fileHash).sort()).to.deep.equal(['a', 'b']);
        expect(kv.calls.getMetadataFlat).to.equal(2);
        expect(kv.calls.getAllHashIds).to.equal(0);
    });

    it('POST recompute refuses a second run for the same plugin while one is queuing', async function() {
        kv.seedData('a', { filePath: '/files/watch/a.mkv' });
        kv.fileTuples = [tuple('a', 100)];
        kv.fileTuplesDelayMs = 50;

        const [first, second] = await Promise.all([
            app.inject({ method: 'POST', url: '/api/plugins/ffmpeg/recompute' }),
            app.inject({ method: 'POST', url: '/api/plugins/ffmpeg/recompute' }),
        ]);

        expect([first.statusCode, second.statusCode].sort()).to.deep.equal([200, 409]);
        expect(queued).to.have.length(1);
    });
});

// =============================================================================
// File-level processing metric
// =============================================================================

describe('UnifiedProcessingStateManager file metric', function() {
    // Files announced over SSE go straight to light processing; they are never
    // marked discovered, which is the path that used to leave "Processed" at 0.
    const runFile = (manager: UnifiedProcessingStateManager, filePath: string, error?: string) => {
        manager.startLightProcessing(filePath);
        manager.completeLightProcessing(filePath, 'bagacbabaeexamplehash');
        manager.startHashProcessing(filePath);
        manager.completeHashProcessing(filePath, 'bagacbabaeexamplehash', undefined, error);
    };

    it('counts a file as processed when its hash phase completes cleanly', function() {
        const manager = new UnifiedProcessingStateManager();
        const before = performanceMetrics.getMetrics().totalFilesProcessed;

        runFile(manager, '/files/watch/metric-ok.mkv');

        expect(performanceMetrics.getMetrics().totalFilesProcessed).to.equal(before + 1);
    });

    it('does not count a file whose hash phase failed', function() {
        const manager = new UnifiedProcessingStateManager();
        const before = performanceMetrics.getMetrics().totalFilesProcessed;

        runFile(manager, '/files/watch/metric-failed.mkv', 'plugin failed');

        expect(performanceMetrics.getMetrics().totalFilesProcessed).to.equal(before);
    });
});
