import { strict as assert } from 'assert';
import { buildRecordFields } from './MetadataUtils.js';

/**
 * `buildRecordFields` is the single boundary where in-memory metadata becomes a
 * record. It is worth testing precisely because the bug it fixes had no coverage:
 * meta-sort had *two* write paths (the meta-core HTTP writer and a direct-Redis
 * fallback), only one of which turned sibling CIDs into the `cids/<cid>` key-set.
 * The other wrote a literal `cid_midhash256` field, which meta-core stores but
 * never reverse-indexes — so those records were unresolvable by their own CID,
 * silently. Both paths now go through this function.
 */
describe('buildRecordFields', () => {
    const MIDHASH = 'bagacbabaec7v3fu2ygzh3e2sybg3fbzmisry2hbtpmck6vx3yftea6vzq35r4';
    const SHA256 = 'baejbeibku6ua2l6r5olnggx4pto2sii2s5jeeawgh4cbkhlbmp52gudbua';

    it('turns cids[] into the bare-CID key-set, not array indices', () => {
        const flat = buildRecordFields({
            hashId: MIDHASH,
            cids: [MIDHASH, SHA256],
            title: 'Inception',
        });

        assert.equal(flat[`cids/${MIDHASH}`], 'true');
        assert.equal(flat[`cids/${SHA256}`], 'true');

        // The trap: the generic flattener would emit `cids/0`, `cids/1` for an
        // array. meta-core's reverse-index hook only matches `cids/<cid>`, so
        // those would be stored and never indexed.
        assert.equal(flat['cids/0'], undefined);
        assert.equal(flat['cids/1'], undefined);
    });

    it('never emits a deprecated cid_* or midhash256 field', () => {
        const flat = buildRecordFields({
            hashId: MIDHASH,
            cids: [MIDHASH],
            title: 'Inception',
        });

        // meta-core returns 400 for any of these now — a record that carried one
        // was stored but unindexed.
        for (const field of Object.keys(flat)) {
            assert.ok(
                !field.startsWith('cid_'),
                `deprecated per-algorithm field reached the record: ${field}`
            );
            assert.notEqual(field, 'midhash256');
            assert.notEqual(field, 'canonical_cid');
        }
    });

    it('does not store hashId as a property of its own record', () => {
        const flat = buildRecordFields({hashId: MIDHASH, cids: [MIDHASH], title: 'x'});
        // hashId IS the record key (`/file/{hashId}`); repeating it inside is noise.
        assert.equal(flat['hashId'], undefined);
    });

    it('still flattens ordinary nested metadata', () => {
        const flat = buildRecordFields({
            hashId: MIDHASH,
            cids: [MIDHASH],
            title: 'Inception',
            fileinfo: {duration: 8878.5, streamdetails: {video: {codec: 'h264'}}},
        });

        assert.equal(flat['title'], 'Inception');
        assert.equal(flat['fileinfo/duration'], '8878.5');
        assert.equal(flat['fileinfo/streamdetails/video/codec'], 'h264');
    });

    it('honours excludeFields', () => {
        const flat = buildRecordFields(
            {hashId: MIDHASH, cids: [MIDHASH], title: 'x', processingStatus: 'processing'},
            ['processingStatus']
        );
        assert.equal(flat['processingStatus'], undefined);
        assert.equal(flat['title'], 'x');
    });

    it('tolerates a record with no cids at all', () => {
        const flat = buildRecordFields({title: 'x'});
        assert.equal(flat['title'], 'x');
        assert.ok(!Object.keys(flat).some(k => k.startsWith('cids/')));
    });
});
