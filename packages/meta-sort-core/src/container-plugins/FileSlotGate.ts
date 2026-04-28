/**
 * FileSlotGate — bounds the number of files concurrently in a processing phase.
 *
 * Motivation: every plugin that runs against a file pulls bytes from CORN/SMB
 * via WebDAV. Without a per-file gate, the task queue happily fans 8 plugins
 * across hundreds of files at once, multiplying the WebDAV fetch cost by the
 * plugin count and overwhelming whatever local cache exists. The gate caps the
 * number of files that can be "in flight" in a given phase so the cache only
 * has to hold N files at a time.
 *
 * Semantics:
 *   - Keyed by fileHash. A file holds at most one slot in a given phase.
 *   - acquire(fileHash) resolves immediately if the file already holds a slot
 *     or there is free capacity; otherwise it queues FIFO.
 *   - release(fileHash) is idempotent for non-holders. When called on a real
 *     holder it frees the slot and wakes the next waiter.
 *
 * The gate intentionally knows nothing about tasks or plugins — it is a thin
 * file-level semaphore. Counting tasks per (file, phase) and deciding when to
 * release is the caller's responsibility.
 */
export class FileSlotGate {
    private readonly holders: Set<string> = new Set();
    private readonly waiters: Array<{ fileHash: string; resolve: () => void }> = [];

    constructor(public readonly capacity: number) {
        if (!Number.isFinite(capacity) || capacity < 1) {
            throw new Error(`FileSlotGate capacity must be a positive integer, got ${capacity}`);
        }
    }

    /**
     * Acquire a slot for fileHash. If the file already holds a slot, resolves
     * immediately (re-entrant for the same file). Otherwise queues until a
     * slot is released.
     */
    acquire(fileHash: string): Promise<void> {
        if (this.holders.has(fileHash)) {
            return Promise.resolve();
        }
        if (this.holders.size < this.capacity) {
            this.holders.add(fileHash);
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.waiters.push({ fileHash, resolve });
        });
    }

    /**
     * Release the slot held by fileHash. No-op if the file doesn't hold one.
     * Wakes the next FIFO waiter, if any, and grants it a slot.
     */
    release(fileHash: string): void {
        if (!this.holders.delete(fileHash)) {
            return;
        }
        const next = this.waiters.shift();
        if (!next) {
            return;
        }
        this.holders.add(next.fileHash);
        next.resolve();
    }

    holds(fileHash: string): boolean {
        return this.holders.has(fileHash);
    }

    inUse(): number {
        return this.holders.size;
    }

    waiting(): number {
        return this.waiters.length;
    }

    getHolders(): string[] {
        return Array.from(this.holders);
    }
}
