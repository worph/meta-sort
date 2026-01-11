/**
 * Plugin System Validation Script
 *
 * Simple validation to ensure the plugin system works correctly.
 * Run with: node dist/plugin2/validate.js
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';

import {
    KVStore,
    PluginCacheImpl,
    resolveDependencyOrder,
    canActivate,
    canDeactivate,
    PluginManager,
} from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, '../../test-plugins-validation');
const TEST_CACHE_DIR = path.join(__dirname, '../../test-cache-validation');
const TEST_STATE_PATH = path.join(__dirname, '../../test-plugins-validation.json');

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${message}`);
    } else {
        failed++;
        console.log(`  ✗ ${message}`);
    }
}

async function cleanup() {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    if (existsSync(TEST_CACHE_DIR)) rmSync(TEST_CACHE_DIR, { recursive: true });
    if (existsSync(TEST_STATE_PATH)) rmSync(TEST_STATE_PATH);
}

async function setup() {
    await cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
}

async function createTestPlugin(id, deps = []) {
    const pluginDir = path.join(TEST_DIR, id);
    mkdirSync(pluginDir, { recursive: true });

    const manifestYaml = `id: ${id}
name: ${id}
version: 1.0.0
${deps.length ? `dependencies:\n${deps.map(d => `  - ${d}`).join('\n')}` : ''}
`;
    await fs.writeFile(path.join(pluginDir, 'manifest.yml'), manifestYaml);

    const pluginCode = `
export default {
    async process(ctx) {
        ctx.kv.set("${id}/processed", "true");
    }
};
`;
    await fs.writeFile(path.join(pluginDir, 'index.js'), pluginCode);
}

async function testKVStore() {
    console.log('\nTesting KVStore...');

    const kv = new KVStore();
    kv.set('file/name', 'test.mkv');
    assert(kv.get('file/name') === 'test.mkv', 'set and get value');

    assert(kv.get('missing/key') === undefined, 'missing key returns undefined');

    kv.set('audio/0/codec', 'aac');
    kv.set('audio/0/language', 'eng');
    kv.set('audio/1/codec', 'dts');
    const audioKeys = kv.keys('audio/');
    assert(audioKeys.length === 3, 'keys with prefix filters correctly');

    kv.delete('file/name');
    assert(kv.get('file/name') === undefined, 'delete removes key');

    const obj = kv.toObject();
    assert(typeof obj === 'object', 'toObject returns object');
}

async function testPluginCache() {
    console.log('\nTesting PluginCache...');

    const cacheDir = path.join(TEST_CACHE_DIR, 'test-cache');
    const cache = new PluginCacheImpl(cacheDir);

    await cache.writeJson('test.json', { foo: 'bar' });
    const data = await cache.readJson('test.json');
    assert(data?.foo === 'bar', 'writeJson and readJson work');

    const exists = await cache.exists('test.json');
    assert(exists === true, 'exists returns true for existing file');

    const notExists = await cache.exists('missing.json');
    assert(notExists === false, 'exists returns false for missing file');

    await cache.delete('test.json');
    const afterDelete = await cache.exists('test.json');
    assert(afterDelete === false, 'delete removes file');
}

async function testDependencyResolution() {
    console.log('\nTesting Dependency Resolution...');

    const plugins = new Map([
        ['a', { id: 'a', name: 'A', version: '1.0.0', dependencies: [] }],
        ['b', { id: 'b', name: 'B', version: '1.0.0', dependencies: ['a'] }],
        ['c', { id: 'c', name: 'C', version: '1.0.0', dependencies: ['b'] }],
    ]);

    const active = new Set(['a', 'b', 'c']);
    const { order, errors } = resolveDependencyOrder(plugins, active);

    assert(errors.length === 0, 'no errors for valid dependency chain');
    assert(order.indexOf('a') < order.indexOf('b'), 'a comes before b');
    assert(order.indexOf('b') < order.indexOf('c'), 'b comes before c');

    // Test can activate
    const { canActivate: can, missingDeps } = canActivate('b', plugins, new Set(['a']));
    assert(can === true, 'can activate when dependencies met');

    const { canActivate: cannot, missingDeps: missing } = canActivate('b', plugins, new Set());
    assert(cannot === false, 'cannot activate when dependencies missing');
    assert(missing.includes('a'), 'reports missing dependency');

    // Test can deactivate
    const { canDeactivate: canDeact } = canDeactivate('c', plugins, active);
    assert(canDeact === true, 'can deactivate when no dependents');

    const { canDeactivate: cannotDeact, dependents } = canDeactivate('a', plugins, active);
    assert(cannotDeact === false, 'cannot deactivate when has dependents');
    assert(dependents.includes('b'), 'reports dependent plugin');
}

async function testPluginManager() {
    console.log('\nTesting PluginManager...');

    await createTestPlugin('plugin-a');
    await createTestPlugin('plugin-b', ['plugin-a']);

    const manager = new PluginManager({
        pluginsDir: TEST_DIR,
        statePath: TEST_STATE_PATH,
        cacheDir: TEST_CACHE_DIR,
    });

    const plugins = await manager.scanPlugins();
    assert(plugins.length === 2, 'scans and discovers plugins');

    await manager.loadAll();
    assert(manager.getPlugins().length === 2, 'loads all plugins');

    await manager.activate('plugin-a');
    await manager.activate('plugin-b');
    assert(manager.getActivePlugins().length === 2, 'activates plugins');

    const order = manager.getExecutionOrder();
    assert(order.indexOf('plugin-a') < order.indexOf('plugin-b'), 'respects dependency order');

    const kv = manager.createKVStore();
    const result = await manager.processFile('/test/file.mkv', kv);
    assert(result.success === true, 'processes file successfully');
    assert(kv.get('plugin-a/processed') === 'true', 'plugin-a executed');
    assert(kv.get('plugin-b/processed') === 'true', 'plugin-b executed');

    await manager.deactivate('plugin-b');
    assert(manager.getActivePlugins().length === 1, 'deactivates plugin');

    await manager.shutdown();
}

async function run() {
    console.log('Plugin System Validation\n========================');

    try {
        await setup();
        await testKVStore();
        await testPluginCache();
        await testDependencyResolution();
        await testPluginManager();
        await cleanup();

        console.log(`\n========================`);
        console.log(`Results: ${passed} passed, ${failed} failed`);

        if (failed > 0) {
            process.exit(1);
        }
    } catch (error) {
        console.error('\nValidation error:', error);
        await cleanup();
        process.exit(1);
    }
}

run();
