// Browser-compatible hash implementation
import {SimpleHash} from "@root/file-id/SimpleHash";
import {createMD5, createSHA1, createSHA256, createSHA3} from "hash-wasm";

export class BrowserHasher implements SimpleHash {
    private algorithm: string;
    private wasmHasher: any;
    private isWasm: boolean;

    constructor(algorithm: string) {
        this.algorithm = algorithm;
        this.isWasm = true;
    }

    async initialize(): Promise<void> {
        if (this.isWasm) {
            switch (this.algorithm) {
                case 'md5':
                    this.wasmHasher = await createMD5();
                    break;
                case 'sha-1':
                    this.wasmHasher = await createSHA1();
                    break;
                case 'sha-256':
                    this.wasmHasher = await createSHA256();
                    break;
                case 'sha3-256':
                    this.wasmHasher = await createSHA3(256);
                    break;
                case 'sha3-384':
                    this.wasmHasher = await createSHA3(384);
                    break;
                default:
                    throw new Error(`Unsupported algorithm: ${this.algorithm}`);
            }
            this.wasmHasher.init();
        }
    }

    update(data: Uint8Array): SimpleHash {
        this.wasmHasher.update(data);
        return this;
    }

    async digest(): Promise<Uint8Array> {
        const hash = await this.wasmHasher.digest('binary');
        return new Uint8Array(hash);
    }
}