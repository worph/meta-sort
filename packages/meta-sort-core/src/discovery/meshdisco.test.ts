import { strict as assert } from 'assert';
import { capMatches, classifyScan, suggestedName, type MeshNeighbor } from './meshdisco.js';

/** Mirrors meta-feeder-sdk `beacon::scan` tests: same rules, same JSON. */
describe('beacon v2 scan classification', () => {
    const node = (instance: string, cap: string, http?: string, binds?: string): MeshNeighbor => ({
        name: 'plugin', instance, caps: [cap], addr: '10.0.0.1', lastSeen: 0,
        resources: [{ id: 'x', caps: [cap], ...(http ? { endpoints: { http } } : {}), ...(binds ? { binds } : {}) }],
    });

    it('classifies configured, addable and bound-elsewhere', () => {
        const r = classifyScan('metamesh.enrich/*', 'metasort-app', [
            node('meta-plugin-language-0', 'metamesh.enrich/language', 'http://meta-plugin-language-0:8080/', 'metasort-app'),
            node('metapluginffmpeg-plugin', 'metamesh.enrich/ffmpeg', 'http://metapluginffmpeg-plugin:8080'),
            node('other-sort-plugin', 'metamesh.enrich/tmdb', 'http://x:8080', 'other-metasort'),
            node('no-endpoint', 'metamesh.enrich/tmdb'),
            node('a-service', 'metamesh.service/meta-core', 'http://core'),
        ], [['language', 'http://meta-plugin-language-0:8080']]);
        assert.deepEqual(r.summary, { nodes: 5, capable: 3, configured: 1, boundElsewhere: 1, addable: 1 });
        assert.equal(r.candidates[0].instance, 'metapluginffmpeg-plugin');
        assert.equal(r.candidates[1].configuredAs, 'language');
        assert.equal(r.candidates[2].state, 'bound-elsewhere');
    });

    it('caps and names', () => {
        assert.ok(capMatches('metamesh.enrich/*', 'metamesh.enrich/language@1'));
        assert.ok(!capMatches('metamesh.enrich/*', 'metamesh.enrichx/a'));
        assert.equal(suggestedName('MetaPlugin Language'), 'metaplugin-language');
    });
});
