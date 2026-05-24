/**
 * FileEventConsumer
 *
 * Consumes file events from meta-core via SSE (Server-Sent Events).
 * When events are received, they are forwarded to the StreamingPipeline.
 *
 * This enables meta-sort to run without direct filesystem access — it receives
 * file discovery events from meta-core and processes files via WebDAV.
 *
 * Previously consumed `file:events` via Redis Streams XREADGROUP. The
 * api-mediated-access migration (PR C) routes this through meta-core's HTTP
 * /api/events/files endpoint instead, so consumers no longer need direct
 * Redis access. Cursor durability is now the consumer's responsibility —
 * see SSEEventClient.
 */

import { SSEEventClient, type SSEEvent } from './SSEEventClient.js';

// Pipeline interface (minimal, matching StreamingPipeline)
interface Pipeline {
    handleFileAdded(filePath: string, midhash256?: string): void;
    handleFileChanged(filePath: string, midhash256?: string): void;
    handleFileDeleted(filePath: string): void;
    reset(): Promise<void>;
}

export interface FileEventConsumerOptions {
    /** meta-core API base URL (e.g. http://metacore-app:9000). */
    metaCoreApiUrl: string;

    /** Pipeline to receive events */
    pipeline: Pipeline;

    /** Base path for files (e.g., /files). Paths from meta-core are relative and need this prefix. */
    filesPath?: string;

    /** Where to persist the SSE cursor. Defaults to /meta-core/cursors/meta-sort-files.cursor. */
    cursorPath?: string;
}

export class FileEventConsumer {
    private pipeline: Pipeline;
    private filesPath: string;
    private sse: SSEEventClient;
    private isRunning = false;

    constructor(options: FileEventConsumerOptions) {
        this.pipeline = options.pipeline;
        this.filesPath = options.filesPath ?? '/files';

        const apiUrl = options.metaCoreApiUrl.replace(/\/+$/, '');
        const cursorPath = options.cursorPath ?? '/meta-core/cursors/meta-sort-files.cursor';

        this.sse = new SSEEventClient({
            url: `${apiUrl}/api/events/files`,
            cursorPath,
            logTag: '[FileEventConsumer]',
            onEvent: (e) => this.handleSSEEvent(e),
            // gap on file:events means we missed retention. Easiest correct
            // response: ask meta-core for a watcher rescan so the StreamingPipeline
            // can rebuild from a known-good baseline.
            onGap: () => {
                console.warn('[FileEventConsumer] Stream cursor trimmed — pipeline will rebuild from next reset event');
            },
        });
    }

    /**
     * Start consuming events from the meta-core SSE endpoint.
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            console.log('[FileEventConsumer] Already running');
            return;
        }
        this.isRunning = true;
        console.log('[FileEventConsumer] Starting SSE stream consumer for /api/events/files...');
        // Fire-and-forget. SSEEventClient.start() returns only when stopped.
        this.sse.start().catch(error => {
            console.error('[FileEventConsumer] Stream consumer terminated:', error);
        });
        console.log('[FileEventConsumer] SSE stream consumer started');
    }

    /**
     * Stop consuming events
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }
        this.isRunning = false;
        await this.sse.stop();
        console.log('[FileEventConsumer] Stopped');
    }

    private async handleSSEEvent(e: SSEEvent): Promise<void> {
        // Convert relative path to absolute path
        const toAbsolutePath = (relativePath: string): string => {
            if (!relativePath) return relativePath;
            if (relativePath.startsWith('/')) return relativePath;
            return `${this.filesPath}/${relativePath}`;
        };

        const path: string = e.data?.path ?? '';
        const midhash256: string | undefined = e.data?.midhash256 ?? undefined;
        const oldPath: string | undefined = e.data?.oldPath ?? undefined;
        const watcherId: string | undefined = e.data?.watcherId ?? undefined;

        switch (e.event) {
            case 'reset':
                console.log(`[FileEventConsumer] Received reset event from watcher: ${watcherId || 'all'}`);
                await this.pipeline.reset();
                break;

            case 'add':
                if (path) this.pipeline.handleFileAdded(toAbsolutePath(path), midhash256);
                break;

            case 'change':
                if (path) this.pipeline.handleFileChanged(toAbsolutePath(path), midhash256);
                break;

            case 'delete':
                if (path) this.pipeline.handleFileDeleted(toAbsolutePath(path));
                break;

            case 'rename':
                if (oldPath) this.pipeline.handleFileDeleted(toAbsolutePath(oldPath));
                if (path) this.pipeline.handleFileAdded(toAbsolutePath(path), midhash256);
                break;

            default:
                console.warn(`[FileEventConsumer] Unknown event type: ${e.event}`);
        }
    }
}

/**
 * Create a FileEventConsumer with default configuration
 */
export function createFileEventConsumer(
    metaCoreApiUrl: string,
    pipeline: Pipeline,
    options?: Partial<FileEventConsumerOptions>
): FileEventConsumer {
    return new FileEventConsumer({
        metaCoreApiUrl,
        pipeline,
        ...options
    });
}
