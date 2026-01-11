/**
 * Plugin System Unit Tests
 */

import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';

import {
    KVStore,
    PluginCacheImpl,
    PluginLoggerImpl,
    parseManifest,
    validateManifest,
    resolveDependencyOrder,
    canActivate,
    canDeactivate,
    PluginManager,
} from './index.js';
import type { PluginManifest, Plugin, PluginContext } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, '../../test-plugins');
const TEST_CACHE_DIR = path.join(__dirname, '../../test-cache');
const TEST_STATE_PATH = path.join(__dirname, '../../test-plugins.json');

// =============================================================================
// Test Helpers
// =============================================================================

async function setupTestDir() {
    // Clean up
    if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true });
    }
    if (existsSync(TEST_CACHE_DIR)) {
        rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    if (existsSync(TEST_STATE_PATH)) {
        rmSync(TEST_STATE_PATH);
    }

    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
}

async function cleanupTestDir() {
    if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true });
    }
    if (existsSync(TEST_CACHE_DIR)) {
        rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    if (existsSync(TEST_STATE_PATH)) {
        rmSync(TEST_STATE_PATH);
    }
}

async function createTestPlugin(
    id: string,
    manifest: Partial<PluginManifest>,
    processCode: string = 'ctx.kv.set("test/processed", "true");'
): Promise<string> {
    const pluginDir = path.join(TEST_DIR, id);
    mkdirSync(pluginDir, { recursive: true });

    // Write manifest
    const fullManifest = {
        id,
        name: manifest.name || id,
        version: manifest.version || '1.0.0',
        ...manifest,
    };

    const manifestYaml = `id: ${fullManifest.id}
name: ${fullManifest.name}
version: ${fullManifest.version}
${fullManifest.description ? `description: ${fullManifest.description}` : ''}
${fullManifest.dependencies?.length ? `dependencies:\n${fullManifest.dependencies.map(d => `  - ${d}`).join('\n')}` : ''}
`;

    await fs.writeFile(path.join(pluginDir, 'manifest.yml'), manifestYaml);

    // Write plugin code
    const pluginCode = `
export default {
    async process(ctx) {
        ${processCode}
    }
};
`;
    await fs.writeFile(path.join(pluginDir, 'index.js'), pluginCode);

    return pluginDir;
}

// =============================================================================
// KVStore Tests
// =============================================================================

describe('KVStore', () => {
    it('should set and get values', () => {
        const kv = new KVStore();
        kv.set('file/name', 'test.mkv');
        expect(kv.get('file/name')).to.equal('test.mkv');
    });

    it('should return undefined for missing keys', () => {
        const kv = new KVStore();
        expect(kv.get('missing/key')).to.be.undefined;
    });

    it('should delete keys', () => {
        const kv = new KVStore();
        kv.set('file/name', 'test.mkv');
        kv.delete('file/name');
        expect(kv.get('file/name')).to.be.undefined;
    });

    it('should list all keys', () => {
        const kv = new KVStore();
        kv.set('file/name', 'test.mkv');
        kv.set('video/codec', 'h264');
        kv.set('audio/0/codec', 'aac');

        const keys = kv.keys();
        expect(keys).to.have.lengthOf(3);
        expect(keys).to.include('file/name');
        expect(keys).to.include('video/codec');
        expect(keys).to.include('audio/0/codec');
    });

    it('should filter keys by prefix', () => {
        const kv = new KVStore();
        kv.set('file/name', 'test.mkv');
        kv.set('audio/0/codec', 'aac');
        kv.set('audio/0/language', 'eng');
        kv.set('audio/1/codec', 'dts');

        const audioKeys = kv.keys('audio/');
        expect(audioKeys).to.have.lengthOf(3);
        expect(audioKeys).to.include('audio/0/codec');
        expect(audioKeys).to.include('audio/0/language');
        expect(audioKeys).to.include('audio/1/codec');
    });

    it('should return entries', () => {
        const kv = new KVStore();
        kv.set('file/name', 'test.mkv');
        kv.set('video/codec', 'h264');

        const entries = kv.entries();
        expect(entries).to.have.lengthOf(2);
        expect(entries).to.deep.include(['file/name', 'test.mkv']);
        expect(entries).to.deep.include(['video/codec', 'h264']);
    });

    it('should filter entries by prefix', () => {
        const kv = new KVStore();
        kv.set('file/name', 'test.mkv');
        kv.set('audio/0/codec', 'aac');
        kv.set('audio/1/codec', 'dts');

        const audioEntries = kv.entries('audio/');
        expect(audioEntries).to.have.lengthOf(2);
    });

    it('should initialize with data', () => {
        const kv = new KVStore({ 'file/name': 'test.mkv', 'video/codec': 'h264' });
        expect(kv.get('file/name')).to.equal('test.mkv');
        expect(kv.get('video/codec')).to.equal('h264');
    });

    it('should convert to object', () => {
        const kv = new KVStore();
        kv.set('file/name', 'test.mkv');
        kv.set('video/codec', 'h264');

        const obj = kv.toObject();
        expect(obj).to.deep.equal({
            'file/name': 'test.mkv',
            'video/codec': 'h264',
        });
    });

    it('should ignore null/undefined values', () => {
        const kv = new KVStore();
        kv.set('test', null as any);
        kv.set('test2', undefined as any);
        expect(kv.keys()).to.have.lengthOf(0);
    });

    it('should ignore empty keys', () => {
        const kv = new KVStore();
        kv.set('', 'value');
        expect(kv.keys()).to.have.lengthOf(0);
    });
});

// =============================================================================
// PluginCache Tests
// =============================================================================

describe('PluginCache', () => {
    const cacheDir = path.join(TEST_CACHE_DIR, 'test-plugin');

    beforeEach(async () => {
        if (existsSync(cacheDir)) {
            rmSync(cacheDir, { recursive: true });
        }
    });

    afterEach(async () => {
        if (existsSync(cacheDir)) {
            rmSync(cacheDir, { recursive: true });
        }
    });

    it('should write and read JSON', async () => {
        const cache = new PluginCacheImpl(cacheDir);
        const data = { foo: 'bar', num: 42 };

        await cache.writeJson('test.json', data);
        const result = await cache.readJson<typeof data>('test.json');

        expect(result).to.deep.equal(data);
    });

    it('should return null for missing files', async () => {
        const cache = new PluginCacheImpl(cacheDir);
        const result = await cache.readJson('missing.json');
        expect(result).to.be.null;
    });

    it('should check file existence', async () => {
        const cache = new PluginCacheImpl(cacheDir);

        expect(await cache.exists('test.json')).to.be.false;

        await cache.writeJson('test.json', { foo: 'bar' });
        expect(await cache.exists('test.json')).to.be.true;
    });

    it('should delete files', async () => {
        const cache = new PluginCacheImpl(cacheDir);
        await cache.writeJson('test.json', { foo: 'bar' });

        await cache.delete('test.json');
        expect(await cache.exists('test.json')).to.be.false;
    });

    it('should clear all files', async () => {
        const cache = new PluginCacheImpl(cacheDir);
        await cache.writeJson('test1.json', { a: 1 });
        await cache.writeJson('test2.json', { b: 2 });

        await cache.clear();

        expect(await cache.exists('test1.json')).to.be.false;
        expect(await cache.exists('test2.json')).to.be.false;
    });

    it('should get full path', () => {
        const cache = new PluginCacheImpl(cacheDir);
        const fullPath = cache.getPath('test.json');
        expect(fullPath).to.equal(path.join(cacheDir, 'test.json'));
    });
});

// =============================================================================
// Manifest Parsing Tests
// =============================================================================

describe('Manifest Parsing', () => {
    beforeEach(setupTestDir);
    afterEach(cleanupTestDir);

    it('should parse valid manifest', async () => {
        const manifestPath = path.join(TEST_DIR, 'manifest.yml');
        await fs.writeFile(
            manifestPath,
            `id: test-plugin
name: Test Plugin
version: 1.0.0
description: A test plugin
dependencies:
  - other-plugin
config:
  apiKey:
    type: string
    required: true
    secret: true
  language:
    type: string
    default: en-US
`
        );

        const manifest = await parseManifest(manifestPath);

        expect(manifest.id).to.equal('test-plugin');
        expect(manifest.name).to.equal('Test Plugin');
        expect(manifest.version).to.equal('1.0.0');
        expect(manifest.description).to.equal('A test plugin');
        expect(manifest.dependencies).to.deep.equal(['other-plugin']);
        expect(manifest.config?.apiKey?.type).to.equal('string');
        expect(manifest.config?.apiKey?.secret).to.be.true;
        expect(manifest.config?.language?.default).to.equal('en-US');
    });

    it('should validate manifest - valid', () => {
        const manifest: PluginManifest = {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
        };

        const errors = validateManifest(manifest);
        expect(errors).to.have.lengthOf(0);
    });

    it('should validate manifest - invalid id', () => {
        const manifest: PluginManifest = {
            id: 'Test_Plugin',
            name: 'Test Plugin',
            version: '1.0.0',
        };

        const errors = validateManifest(manifest);
        expect(errors).to.have.lengthOf(1);
        expect(errors[0]).to.include('Invalid plugin id');
    });

    it('should validate manifest - invalid version', () => {
        const manifest: PluginManifest = {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: 'invalid',
        };

        const errors = validateManifest(manifest);
        expect(errors).to.have.lengthOf(1);
        expect(errors[0]).to.include('Invalid version');
    });
});

// =============================================================================
// Dependency Resolution Tests
// =============================================================================

describe('Dependency Resolution', () => {
    it('should resolve simple dependency chain', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: [] }],
            ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
            ['c', { id: 'c', name: 'C', version: '1.0.0', dependencies: ['b'] }],
        ]);

        const active = new Set(['a', 'b', 'c']);
        const { order, errors } = resolveDependencyOrder(plugins, active);

        expect(errors).to.have.lengthOf(0);
        expect(order.indexOf('a')).to.be.lessThan(order.indexOf('b'));
        expect(order.indexOf('b')).to.be.lessThan(order.indexOf('c'));
    });

    it('should handle diamond dependency', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: [] }],
            ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
            ['c', { id: 'c', name: 'C', version: '1.0.0', dependencies: ['a'] }],
            ['d', { id: 'd', name: 'D', version: '1.0.0', dependencies: ['b', 'c'] }],
        ]);

        const active = new Set(['a', 'b', 'c', 'd']);
        const { order, errors } = resolveDependencyOrder(plugins, active);

        expect(errors).to.have.lengthOf(0);
        expect(order.indexOf('a')).to.be.lessThan(order.indexOf('b'));
        expect(order.indexOf('a')).to.be.lessThan(order.indexOf('c'));
        expect(order.indexOf('b')).to.be.lessThan(order.indexOf('d'));
        expect(order.indexOf('c')).to.be.lessThan(order.indexOf('d'));
    });

    it('should detect circular dependencies', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: ['c'] }],
            ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
            ['c', { id: 'c', name: 'C', version: '1.0.0', dependencies: ['b'] }],
        ]);

        const active = new Set(['a', 'b', 'c']);
        const { errors } = resolveDependencyOrder(plugins, active);

        expect(errors.length).to.be.greaterThan(0);
        expect(errors[0]).to.include('Circular dependency');
    });

    it('should report missing dependencies', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: ['missing'] }],
        ]);

        const active = new Set(['a']);
        const { errors } = resolveDependencyOrder(plugins, active);

        expect(errors.length).to.be.greaterThan(0);
        expect(errors[0]).to.include('does not exist');
    });

    it('should report inactive dependencies', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: [] }],
            ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
        ]);

        const active = new Set(['b']); // 'a' is not active
        const { errors } = resolveDependencyOrder(plugins, active);

        expect(errors.length).to.be.greaterThan(0);
        expect(errors[0]).to.include('not active');
    });
});

// =============================================================================
// Activation/Deactivation Tests
// =============================================================================

describe('Activation Checks', () => {
    it('should allow activation when dependencies are met', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: [] }],
            ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
        ]);

        const active = new Set(['a']);
        const { canActivate: can, missingDeps } = canActivate('b', plugins, active);

        expect(can).to.be.true;
        expect(missingDeps).to.have.lengthOf(0);
    });

    it('should prevent activation when dependencies are missing', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: [] }],
            ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
        ]);

        const active = new Set<string>(); // 'a' is not active
        const { canActivate: can, missingDeps } = canActivate('b', plugins, active);

        expect(can).to.be.false;
        expect(missingDeps).to.deep.equal(['a']);
    });

    it('should allow deactivation when no dependents', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: [] }],
            ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
        ]);

        const active = new Set(['a', 'b']);
        const { canDeactivate: can, dependents } = canDeactivate('b', plugins, active);

        expect(can).to.be.true;
        expect(dependents).to.have.lengthOf(0);
    });

    it('should prevent deactivation when has dependents', () => {
        const plugins = new Map<string, PluginManifest>([
            ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: [] }],
            ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
        ]);

        const active = new Set(['a', 'b']);
        const { canDeactivate: can, dependents } = canDeactivate('a', plugins, active);

        expect(can).to.be.false;
        expect(dependents).to.deep.equal(['b']);
    });
});

// =============================================================================
// Plugin Manager Integration Tests
// =============================================================================

describe('PluginManager', () => {
    beforeEach(setupTestDir);
    afterEach(async () => {
        await cleanupTestDir();
    });

    it('should scan and discover plugins', async () => {
        await createTestPlugin('test-plugin', {
            name: 'Test Plugin',
            version: '1.0.0',
        });

        const manager = new PluginManager({
            pluginsDir: TEST_DIR,
            statePath: TEST_STATE_PATH,
            cacheDir: TEST_CACHE_DIR,
        });

        const plugins = await manager.scanPlugins();

        expect(plugins).to.have.lengthOf(1);
        expect(plugins[0].id).to.equal('test-plugin');
        expect(plugins[0].name).to.equal('Test Plugin');
    });

    it('should load and activate plugins', async () => {
        await createTestPlugin('plugin-a', { name: 'Plugin A' });

        const manager = new PluginManager({
            pluginsDir: TEST_DIR,
            statePath: TEST_STATE_PATH,
            cacheDir: TEST_CACHE_DIR,
        });

        await manager.scanPlugins();
        await manager.loadAll();

        // Activate
        await manager.activate('plugin-a');

        const plugins = manager.getPlugins();
        expect(plugins[0].active).to.be.true;

        const order = manager.getExecutionOrder();
        expect(order).to.include('plugin-a');
    });

    it('should respect dependency order in execution', async () => {
        await createTestPlugin('plugin-a', { name: 'Plugin A' }, 'ctx.kv.set("order/a", Date.now().toString());');
        await createTestPlugin(
            'plugin-b',
            { name: 'Plugin B', dependencies: ['plugin-a'] },
            'ctx.kv.set("order/b", Date.now().toString());'
        );

        const manager = new PluginManager({
            pluginsDir: TEST_DIR,
            statePath: TEST_STATE_PATH,
            cacheDir: TEST_CACHE_DIR,
        });

        await manager.scanPlugins();
        await manager.loadAll();
        await manager.activate('plugin-a');
        await manager.activate('plugin-b');

        const order = manager.getExecutionOrder();
        expect(order.indexOf('plugin-a')).to.be.lessThan(order.indexOf('plugin-b'));
    });

    it('should process files through plugins', async () => {
        await createTestPlugin(
            'test-plugin',
            { name: 'Test Plugin' },
            `
            ctx.kv.set('file/processed', 'true');
            ctx.kv.set('file/path', ctx.filePath);
            `
        );

        const manager = new PluginManager({
            pluginsDir: TEST_DIR,
            statePath: TEST_STATE_PATH,
            cacheDir: TEST_CACHE_DIR,
        });

        await manager.scanPlugins();
        await manager.loadAll();
        await manager.activate('test-plugin');

        const kv = manager.createKVStore();
        const result = await manager.processFile('/test/file.mkv', kv);

        expect(result.success).to.be.true;
        expect(kv.get('file/processed')).to.equal('true');
        expect(kv.get('file/path')).to.equal('/test/file.mkv');
    });

    it('should persist state across restarts', async () => {
        await createTestPlugin('test-plugin', { name: 'Test Plugin' });

        // First run
        const manager1 = new PluginManager({
            pluginsDir: TEST_DIR,
            statePath: TEST_STATE_PATH,
            cacheDir: TEST_CACHE_DIR,
        });

        await manager1.scanPlugins();
        await manager1.loadAll();
        await manager1.activate('test-plugin');
        await manager1.updateConfig('test-plugin', { setting: 'value' });
        await manager1.shutdown();

        // Second run
        const manager2 = new PluginManager({
            pluginsDir: TEST_DIR,
            statePath: TEST_STATE_PATH,
            cacheDir: TEST_CACHE_DIR,
        });

        await manager2.scanPlugins();
        await manager2.loadAll();

        const plugins = manager2.getPlugins();
        expect(plugins[0].active).to.be.true;
        expect(plugins[0].config.setting).to.equal('value');

        await manager2.shutdown();
    });

    it('should prevent deactivation of plugin with dependents', async () => {
        await createTestPlugin('plugin-a', { name: 'Plugin A' });
        await createTestPlugin('plugin-b', { name: 'Plugin B', dependencies: ['plugin-a'] });

        const manager = new PluginManager({
            pluginsDir: TEST_DIR,
            statePath: TEST_STATE_PATH,
            cacheDir: TEST_CACHE_DIR,
        });

        await manager.scanPlugins();
        await manager.loadAll();
        await manager.activate('plugin-a');
        await manager.activate('plugin-b');

        try {
            await manager.deactivate('plugin-a');
            expect.fail('Should have thrown');
        } catch (error) {
            expect((error as Error).message).to.include('other plugins depend on it');
        }

        await manager.shutdown();
    });

    it('should emit events on activation/deactivation', async () => {
        await createTestPlugin('test-plugin', { name: 'Test Plugin' });

        const manager = new PluginManager({
            pluginsDir: TEST_DIR,
            statePath: TEST_STATE_PATH,
            cacheDir: TEST_CACHE_DIR,
        });

        const events: string[] = [];
        manager.on('plugin:activated', (e) => events.push(`activated:${e.pluginId}`));
        manager.on('plugin:deactivated', (e) => events.push(`deactivated:${e.pluginId}`));

        await manager.scanPlugins();
        await manager.loadAll();
        await manager.activate('test-plugin');
        await manager.deactivate('test-plugin');

        expect(events).to.deep.equal(['activated:test-plugin', 'deactivated:test-plugin']);

        await manager.shutdown();
    });
});
