import { strict as assert } from 'assert';
import { createServer, type Server } from 'http';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContainerManager } from './ContainerManager.js';
import { ExternalPluginStore } from './ExternalPluginStore.js';

/**
 * External plugins are the meta-sort side of the beacon Scan card's Add: a
 * plugin meta-sort did not spawn, reached by URL, identified by its manifest
 * id, persisted outside the read-only plugins.yml.
 */
describe('external plugins', () => {
    let server: Server;
    let url: string;

    before(async () => {
        server = createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/manifest') {
                res.end(JSON.stringify({ id: 'language', name: 'Language', version: '1.0.2', defaultQueue: 'fast' }));
            } else if (req.url === '/health') {
                res.end(JSON.stringify({ status: 'healthy', ready: true, version: '1.0.2' }));
            } else {
                res.statusCode = 404;
                res.end('{}');
            }
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const addr = server.address();
        url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    });

    after(() => server.close());

    function manager(path: string): ContainerManager {
        const m = new ContainerManager('/nonexistent/plugins.yml', 'none', '/files', 'http://cb', 'http://core');
        m.setExternalStore(new ExternalPluginStore(path));
        return m;
    }

    it('adds by URL under the manifest id, persists, and refuses duplicates', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'ext-')), 'state', 'external-plugins.json');
        const m = manager(path);
        const entry = await m.addExternalPlugin(`${url}/`, 'metapluginlanguage-plugin');
        assert.equal(entry.pluginId, 'language');
        assert.equal(entry.url, url, 'trailing slash normalised');

        const saved = JSON.parse(readFileSync(path, 'utf-8'));
        assert.equal(saved.plugins[0].pluginId, 'language');

        await assert.rejects(m.addExternalPlugin(url), /already registered/);
        const status = m.getStatus().plugins.find((p) => p.pluginId === 'language');
        assert.equal(status?.kind, 'external');
        assert.equal(status?.url, url);

        await m.removeExternalPlugin('language');
        assert.equal(m.getStatus().plugins.length, 0);
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf-8')).plugins, []);
        await assert.rejects(m.removeExternalPlugin('language'), /not an external plugin/);
    });

    it('rejects a URL whose manifest cannot be read', async () => {
        const m = manager(join(mkdtempSync(join(tmpdir(), 'ext-')), 'x.json'));
        await assert.rejects(m.addExternalPlugin('http://127.0.0.1:9/'), /could not read/);
        await assert.rejects(m.addExternalPlugin('ftp://x'), /http/);
    });

    it('a missing or corrupt store reads as empty', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ext-'));
        assert.deepEqual(await new ExternalPluginStore(join(dir, 'missing.json')).load(), []);
    });
});
