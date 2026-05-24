/**
 * SSEEventClient — HTTP Server-Sent Events client for meta-core event streams.
 *
 * Replaces the Redis Streams XREADGROUP loop. Each consumer service holds
 * one long-lived HTTP connection to meta-core's /api/events/{files,meta}
 * endpoint and receives JSON events as the underlying Redis Stream is
 * appended to.
 *
 * Cursor semantics (see meta-core docs/api-mediated-access.md):
 *   - The SSE wire id is the opaque Redis Stream entry ID (`<ms>-<seq>`).
 *     We treat it as a black-box string.
 *   - On reconnect we send Last-Event-ID so meta-core resumes from the
 *     entry AFTER our cursor.
 *   - We persist the cursor to disk so the loop survives a process
 *     restart. The cursor is written every flushIntervalMs and on graceful
 *     stop.
 *   - On a `gap` event the server is telling us our cursor was trimmed
 *     out of retention. Caller-supplied onGap handles it (typically a
 *     re-bootstrap from a full HTTP fetch). If the caller doesn't handle
 *     gaps, we just continue from the new cursor.
 */
import { promises as fs } from 'fs';
import { dirname } from 'path';

/** One SSE event parsed off the wire. */
export interface SSEEvent {
    /** Opaque cursor (Redis Stream entry ID under the hood). */
    id: string;
    /** Event type — `add` / `change` / `delete` / `rename` / `reset` for
     *  file:events; `set` / `del` / `expire` for meta:events; `gap` for
     *  trim notifications; arbitrary otherwise. */
    event: string;
    /** Parsed JSON payload from the `data:` line. */
    data: any;
}

export interface SSEClientOptions {
    /** Full URL to subscribe to (e.g. http://metacore-app:9000/api/events/files). */
    url: string;

    /** Path where the cursor is persisted between runs.
     *  Set to null to keep the cursor in-memory only (at-most-once on crash). */
    cursorPath: string | null;

    /** Handler for every non-gap event. */
    onEvent: (e: SSEEvent) => Promise<void> | void;

    /** Optional handler for the synthetic `gap` event. If omitted we just
     *  log and continue from the resumeFrom cursor inside the payload. */
    onGap?: (payload: { requested: string; resumeFrom: string; reason: string }) => Promise<void> | void;

    /** Logger prefix used for console.log lines. */
    logTag?: string;

    /** Initial reconnect backoff in ms (doubles per failure, capped). Default 500. */
    reconnectBaseMs?: number;

    /** Max reconnect backoff in ms. Default 30_000. */
    reconnectMaxMs?: number;

    /** How often to flush the in-memory cursor to disk. Default 2000. */
    flushIntervalMs?: number;
}

export class SSEEventClient {
    private readonly opts: Required<Omit<SSEClientOptions, 'onGap'>> & Pick<SSEClientOptions, 'onGap'>;
    private cursor: string = '';
    private cursorDirty = false;
    private abort: AbortController | null = null;
    private flushTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private backoff = 0;

    constructor(options: SSEClientOptions) {
        this.opts = {
            url: options.url,
            cursorPath: options.cursorPath,
            onEvent: options.onEvent,
            onGap: options.onGap,
            logTag: options.logTag ?? '[SSE]',
            reconnectBaseMs: options.reconnectBaseMs ?? 500,
            reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
            flushIntervalMs: options.flushIntervalMs ?? 2000,
        };
        this.backoff = this.opts.reconnectBaseMs;
    }

    /**
     * Read the persisted cursor (if any) and begin streaming. The returned
     * promise resolves on stop()/permanent error; callers should not await
     * it directly — fire-and-forget and call stop() to shut down.
     */
    async start(): Promise<void> {
        await this.loadCursor();
        this.startFlushTimer();
        await this.runLoop();
    }

    /** Graceful shutdown — closes the open connection and flushes the cursor. */
    async stop(): Promise<void> {
        this.stopped = true;
        if (this.abort) {
            this.abort.abort();
            this.abort = null;
        }
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flushCursor();
    }

    /** Currently-known cursor — useful for tests. */
    getCursor(): string {
        return this.cursor;
    }

    private async loadCursor(): Promise<void> {
        if (!this.opts.cursorPath) return;
        try {
            const data = await fs.readFile(this.opts.cursorPath, 'utf-8');
            const trimmed = data.trim();
            if (trimmed) {
                this.cursor = trimmed;
                console.log(`${this.opts.logTag} Resuming from cursor ${this.cursor}`);
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') {
                console.warn(`${this.opts.logTag} Could not read cursor file ${this.opts.cursorPath}: ${err.message}`);
            }
            // ENOENT is expected first time; start at "$" (server-default).
        }
    }

    private startFlushTimer(): void {
        this.flushTimer = setInterval(() => {
            if (this.cursorDirty) {
                this.flushCursor().catch(err =>
                    console.warn(`${this.opts.logTag} Cursor flush failed: ${err.message}`)
                );
            }
        }, this.opts.flushIntervalMs);
    }

    private async flushCursor(): Promise<void> {
        if (!this.opts.cursorPath || !this.cursorDirty) return;
        this.cursorDirty = false;
        try {
            await fs.mkdir(dirname(this.opts.cursorPath), { recursive: true });
            await fs.writeFile(this.opts.cursorPath, this.cursor, 'utf-8');
        } catch (err: any) {
            // Re-mark dirty so the next tick retries.
            this.cursorDirty = true;
            throw err;
        }
    }

    private async runLoop(): Promise<void> {
        while (!this.stopped) {
            try {
                await this.connect();
                // connect() only returns on graceful end-of-stream — reset
                // backoff so a long-running connection that finally
                // disconnects reconnects quickly.
                this.backoff = this.opts.reconnectBaseMs;
            } catch (err: any) {
                if (this.stopped) return;
                console.warn(`${this.opts.logTag} Stream error, reconnecting in ${this.backoff}ms: ${err?.message ?? err}`);
                await this.sleep(this.backoff);
                this.backoff = Math.min(this.backoff * 2, this.opts.reconnectMaxMs);
            }
        }
    }

    private async connect(): Promise<void> {
        this.abort = new AbortController();
        const headers: Record<string, string> = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
        };
        if (this.cursor) {
            headers['Last-Event-ID'] = this.cursor;
        }

        const response = await fetch(this.opts.url, {
            method: 'GET',
            headers,
            signal: this.abort.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        if (!response.body) {
            throw new Error('Response has no body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        try {
            while (!this.stopped) {
                const { value, done } = await reader.read();
                if (done) {
                    return;
                }
                buffer += decoder.decode(value, { stream: true });
                // Each SSE event ends with a blank line ("\n\n"). Split on
                // that boundary and process each chunk.
                let idx: number;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const rawChunk = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    await this.handleChunk(rawChunk);
                }
            }
        } finally {
            try { reader.releaseLock(); } catch { /* nothing useful */ }
        }
    }

    private async handleChunk(chunk: string): Promise<void> {
        let id = '';
        let event = '';
        const dataLines: string[] = [];
        for (const rawLine of chunk.split('\n')) {
            if (!rawLine || rawLine.startsWith(':')) {
                continue; // comment / heartbeat — ignore
            }
            const colon = rawLine.indexOf(':');
            if (colon === -1) continue;
            const field = rawLine.slice(0, colon);
            // SSE spec: ": " (single space after the colon) is stripped; if no space, keep as-is.
            let value = rawLine.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);

            switch (field) {
                case 'id':
                    id = value;
                    break;
                case 'event':
                    event = value;
                    break;
                case 'data':
                    dataLines.push(value);
                    break;
                // ignore other fields (retry, etc.)
            }
        }

        if (dataLines.length === 0) {
            return; // bare heartbeat / no payload
        }

        let data: any;
        try {
            data = JSON.parse(dataLines.join('\n'));
        } catch (err: any) {
            console.warn(`${this.opts.logTag} Skipping unparseable event ${id || '(no id)'}: ${err.message}`);
            return;
        }

        const ev: SSEEvent = { id, event: event || 'message', data };

        if (ev.event === 'gap') {
            if (this.opts.onGap) {
                await this.opts.onGap(ev.data);
            } else {
                console.warn(`${this.opts.logTag} Gap event (cursor ${ev.data?.requested} trimmed): resumed from ${ev.data?.resumeFrom}`);
            }
            if (typeof ev.data?.resumeFrom === 'string' && ev.data.resumeFrom) {
                this.cursor = ev.data.resumeFrom;
                this.cursorDirty = true;
            }
            return;
        }

        try {
            await this.opts.onEvent(ev);
        } catch (err: any) {
            // Handler error doesn't tear down the connection — log and move on.
            console.error(`${this.opts.logTag} onEvent handler failed for ${ev.id}: ${err?.stack ?? err}`);
        }

        if (ev.id) {
            this.cursor = ev.id;
            this.cursorDirty = true;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
