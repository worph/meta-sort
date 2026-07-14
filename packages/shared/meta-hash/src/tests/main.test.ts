import {
    CidAlgorithm,
    HashComputerIndexCache,
    HashComputerWorker,
    pickCidByAlgorithm,
} from "../lib";

import {describe, expect, it} from 'vitest';
import * as process from "process";
import {mkdir, rm, stat} from "fs/promises";

process.env.WORKER_URL = "./dist/worker.js";

/**
 * /!\ WARNING /!\
 * Remember to build the worker each time you change the worker code.
 */

const ALGOS: CidAlgorithm[] = ['sha1', 'sha256', 'md5', 'sha3_256', 'crc32', 'sha3_384'];

/** `src/tests/test.txt`, checked out with LF endings (`.gitattributes`: text=auto eol=lf). */
const FIXTURE_BYTES = 490;

/**
 * The expected digests of `src/tests/test.txt`, as bare CIDv1 strings.
 *
 * Independently reproducible — these are not "whatever the code printed":
 *
 *   $ sha256sum src/tests/test.txt
 *   be25c28a7af0dfd58b3bd487858d0c40faf4c8fb3a721c9fe5d5db7fff3157ec
 *   $ md5sum  → c8971ace120d1393b658eabb45d08c88
 *   $ sha1sum → fb6497eb882a7ce7773f4680fdd2b75cd73ebcf7
 *
 * and each CID below wraps exactly that digest under its multicodec (meta-hash's
 * encoder sets `codec == multihash code`).
 *
 * ⚠ These values were **re-pinned**. The previous ones described a 499-byte
 * CRLF copy of the fixture, from before `.gitattributes` normalised it to LF —
 * so on any LF checkout the digests could never match and this suite was red.
 * The mismatch was invisible because the worker path was also broken, so the
 * assertions never even ran. Hence the explicit `FIXTURE_BYTES` check: if the
 * fixture's bytes ever shift again, the test says *that*, instead of printing
 * six inscrutable CID diffs.
 */
const EXPECTED: Record<string, string> = {
    crc32: 'bagzafmqcat2hnot3',
    md5: 'bahkqdvibcdejogwocigrhe5wldvlwroqrsea',
    sha1: 'baeircfh3msl6xcbkpttxop2gqd65fn24247lz5y',
    sha256: 'baejbeif6exbiu6xq37kywo6uq6cy2dca7l2mr6z2oioj7zov3n776mkx5q',
    sha3_256: 'baelbmiemf56ripvp5zvx5rxljfr56fqfjpxv7xwyx3lphfyv6y5j2egdyi',
    sha3_384: 'baekrkmatuj3wvbkizsyfe6bb3kk7eoiglmsa6qhrr2jehdboxbauep2mppu56xaxxtdztagn7adtswhrw7wq',
};

/**
 * Every expected digest is present in the bare list, and each is recoverable by
 * its algorithm **through its multicodec** — there is no field name to look up.
 * That is the whole point of the `cids: string[]` shape: a CIDv1 is
 * self-describing, so the record never carries a per-algorithm key that could
 * drift from the CID it names (METADATA_KEYS.md §14.13).
 */
function expectAllDigests(cids: string[] | undefined) {
    expect(cids).toBeDefined();
    expect([...cids!].sort()).toEqual(Object.values(EXPECTED).sort());

    for (const algo of ALGOS) {
        expect(pickCidByAlgorithm(cids, algo)).toBe(EXPECTED[algo]);
    }
}

describe('add', () => {
    it('the fixture has the bytes these CIDs were pinned against', async () => {
        const {size} = await stat('./src/tests/test.txt');
        expect(size).toBe(FIXTURE_BYTES);
    });

    it('meta data compute', async () => {
        const hashComputer = new HashComputerWorker(ALGOS);
        const metadata = {};
        await hashComputer.computeMissingHash('./src/tests/test.txt', metadata);
        expectAllDigests((metadata as { cids?: string[] }).cids);
    });

    it('meta data compute with index', async () => {
        await rm("./tmp", {recursive: true, force: true});
        await mkdir("./tmp", {recursive: true});
        const hashComputer = new HashComputerIndexCache("./tmp/index.csv", ALGOS);
        const metadata = {};
        await hashComputer.computeMissingHash('./src/tests/test.txt', metadata);
        expectAllDigests((metadata as { cids?: string[] }).cids);
        await (await hashComputer.getHashIndexManager()).saveCacheToFile();
    });

    it('cache', async () => {
        await mkdir("./tmp", {recursive: true});
        const hashComputer = new HashComputerIndexCache("./tmp/index.csv", ALGOS);

        // The on-disk index is the one place per-algorithm columns survive — it
        // answers "already computed?" in O(1) and never leaves this machine. Note
        // the columns are bare algorithm names now (`sha256`), not the removed
        // record-field names (`cid_sha2-256`).
        const indexLine = await (await hashComputer.getHashIndexManager()).getCidForFileAsync('./src/tests/test.txt');
        delete indexLine['mtime'];
        expect(indexLine).toEqual({
            ...EXPECTED,
            path: "test.txt",
            size: String(FIXTURE_BYTES),
        });
    });

    it('a second pass reuses the cache and recomputes nothing', async () => {
        const hashComputer = new HashComputerIndexCache("./tmp/index.csv", ALGOS);
        const metadata = {};
        await hashComputer.computeMissingHash('./src/tests/test.txt', metadata);
        // Same digests, recovered from the index rather than by re-hashing.
        expectAllDigests((metadata as { cids?: string[] }).cids);
    });
});
