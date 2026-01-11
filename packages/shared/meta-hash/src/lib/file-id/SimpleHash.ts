export interface SimpleHash {
    update(data: Uint8Array): SimpleHash | Promise<SimpleHash>;

    digest(): Uint8Array | Promise<Uint8Array>;
}