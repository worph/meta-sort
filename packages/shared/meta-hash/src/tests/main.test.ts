import {CID_ALGORITHM_NAMES, HashComputerIndexCache, HashComputerWorker} from "../lib";

import {describe, expect, it} from 'vitest';
import * as process from "process";
import { mkdir, rm, rmdir } from "fs/promises";

process.env.WORKER_URL = "./dist/worker.js";

/**
 * /!\ WARNING /!\
 * Remember to build the worker each time you change the worker code.
 */

describe('add', () => {
    it('meta data compute', async () => {
        let hashComputer = new HashComputerWorker([
            CID_ALGORITHM_NAMES.sha1,
            CID_ALGORITHM_NAMES.sha256,
            CID_ALGORITHM_NAMES.md5,
            CID_ALGORITHM_NAMES.sha3_256,
            CID_ALGORITHM_NAMES.crc32,
            CID_ALGORITHM_NAMES.sha3_384
        ]);
        let metadata = {};
        await hashComputer.computeMissingHash('./src/tests/test.txt', metadata);
        console.log(metadata);
        /**
         * test.txt CF20B62A (CRC32)
         * 26f1157f4349a6fb5d207ac5f5995140 *test.txt (MD5)
         * bb242b7b821074f4b9eb9a94d439ab668705aac4 ?SHA1*test.txt
         * 2aa7a80d2fd1eb96d31afc7cdda9211a97524202c63f04151d6163fba35061a0 ?SHA256*test.txt
         * 865a1ea4977b25e04b8ea84af93b21f1a031cb48359f3805089cdae1d89842b9a3faf87654989dcae418144a8bbb378c ?SHA3-384*test.txt
         */
        expect(metadata).toEqual({
            "cid_crc32": "bagzafmqcathsbnrk",
            "cid_sha1": 'baeircff3eqvxxaqqot2lt242stkdtk3gq4c2vra',
            "cid_sha2-256": 'baejbeibku6ua2l6r5olnggx4pto2sii2s5jeeawgh4cbkhlbmp52gudbua',
            "cid_md5": 'bahkqdvibcatpcfl7ine2n625eb5ml5mzkfaa',
            "cid_sha3-256": 'baelbmidner7x3dd7t2kldh6wiq4w6lsye7qrwo6uoqot2t52zkhqk56fnq',
            "cid_sha3-384": 'baekrkmeglipkjf33exqexdvijl4twipruay4wsbvt44akce43lq5rgccxgr7v6dwksmj3sxedakevc53g6ga'
        });
    });
    it('meta data compute with index', async () => {
        await rm("./tmp",{recursive:true});
        await mkdir("./tmp",{recursive:true});
        let hashComputer = new HashComputerIndexCache("./tmp/index.csv",[
            CID_ALGORITHM_NAMES.sha1,
            CID_ALGORITHM_NAMES.sha256,
            CID_ALGORITHM_NAMES.md5,
            CID_ALGORITHM_NAMES.sha3_256,
            CID_ALGORITHM_NAMES.crc32,
            CID_ALGORITHM_NAMES.sha3_384
        ]);
        let metadata = {};
        await hashComputer.computeMissingHash('./src/tests/test.txt', metadata);
        console.log(metadata);
        /**
         * test.txt CF20B62A (CRC32)
         * 26f1157f4349a6fb5d207ac5f5995140 *test.txt (MD5)
         * bb242b7b821074f4b9eb9a94d439ab668705aac4 ?SHA1*test.txt
         * 2aa7a80d2fd1eb96d31afc7cdda9211a97524202c63f04151d6163fba35061a0 ?SHA256*test.txt
         * 865a1ea4977b25e04b8ea84af93b21f1a031cb48359f3805089cdae1d89842b9a3faf87654989dcae418144a8bbb378c ?SHA3-384*test.txt
         */
        expect(metadata).toEqual({
            "cid_crc32": "bagzafmqcathsbnrk",
            "cid_sha1": 'baeircff3eqvxxaqqot2lt242stkdtk3gq4c2vra',
            "cid_sha2-256": 'baejbeibku6ua2l6r5olnggx4pto2sii2s5jeeawgh4cbkhlbmp52gudbua',
            "cid_md5": 'bahkqdvibcatpcfl7ine2n625eb5ml5mzkfaa',
            "cid_sha3-256": 'baelbmidner7x3dd7t2kldh6wiq4w6lsye7qrwo6uoqot2t52zkhqk56fnq',
            "cid_sha3-384": 'baekrkmeglipkjf33exqexdvijl4twipruay4wsbvt44akce43lq5rgccxgr7v6dwksmj3sxedakevc53g6ga'
        });
        await (await hashComputer.getHashIndexManager()).saveCacheToFile();
    });
    it('cache', async () => {
        await mkdir("./tmp",{recursive:true});
        let hashComputer = new HashComputerIndexCache("./tmp/index.csv",[
            CID_ALGORITHM_NAMES.sha1,
            CID_ALGORITHM_NAMES.sha256,
            CID_ALGORITHM_NAMES.md5,
            CID_ALGORITHM_NAMES.sha3_256,
            CID_ALGORITHM_NAMES.crc32,
            CID_ALGORITHM_NAMES.sha3_384
        ]);
        let indexLine = await (await hashComputer.getHashIndexManager()).getCidForFileAsync('./src/tests/test.txt');
        delete indexLine['mtime'];
        expect(indexLine).toEqual({
            "cid_sha1": 'baeircff3eqvxxaqqot2lt242stkdtk3gq4c2vra',
            "cid_sha2-256": 'baejbeibku6ua2l6r5olnggx4pto2sii2s5jeeawgh4cbkhlbmp52gudbua',
            "cid_md5": 'bahkqdvibcatpcfl7ine2n625eb5ml5mzkfaa',
            "cid_sha3-256": 'baelbmidner7x3dd7t2kldh6wiq4w6lsye7qrwo6uoqot2t52zkhqk56fnq',
            "cid_crc32": "bagzafmqcathsbnrk",
            "cid_sha3-384": 'baekrkmeglipkjf33exqexdvijl4twipruay4wsbvt44akce43lq5rgccxgr7v6dwksmj3sxedakevc53g6ga',
            "path": "test.txt",
            "size": "499",
        });
    });
});