/**
 * FileEventConsumer
 *
 * Consumes file events from meta-core via Redis Stream.
 * When events are received, they are forwarded to the StreamingPipeline.
 *
 * This enables meta-sort to run without direct filesystem access - it receives
 * file discovery events from meta-core and processes files via WebDAV.
 */

import type { RedisKVClient, StreamMessage } from '../kv/RedisClient.js';

// Pipeline interface (minimal, matching StreamingPipeline)
interface Pipeline {
    handleFileAdded(filePath: string, midhash256?: string): void;
    handleFileChanged(filePath: string, midhash256?: string): void;
    handleFileDeleted(filePath: string): void;
}

// Redis Stream configuration
const EVENTS_STREAM = 'file:events';
const CONSUMER_GROUP = 'meta-sort-processor';

export interface FileEventConsumerOptions {
    /** Redis KV client */
    kvClient: RedisKVClient;

    /** Pipeline to receive events */
    pipeline: Pipeline;

    /** Base path for files (e.g., /files). Paths from meta-core are relative and need this prefix. */
    filesPath?: string;

    /** Block timeout in milliseconds for stream reads */
    blockMs?: number;
}

export class FileEventConsumer {
    private kvClient: RedisKVClient;
    private pipeline: Pipeline;
    private filesPath: string;
    private blockMs: number;
    private isRunning = false;

    constructor(options: FileEventConsumerOptions) {
        this.kvClient = options.kvClient;
        this.pipeline = options.pipeline;
        this.filesPath = options.filesPath ?? '/files';
        this.blockMs = options.blockMs ?? 5000;
    }

    /**
     * Start consuming events from Redis Stream
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            console.log('[FileEventConsumer] Already running');
            return;
        }

        this.isRunning = true;
        console.log(`[FileEventConsumer] Starting stream consumer for ${EVENTS_STREAM}...`);

        // Initialize consumer group
        await this.kvClient.initStreamConsumer(EVENTS_STREAM, CONSUMER_GROUP);

        // Process any pending entries from crashed consumers
        await this.kvClient.processPendingEntries(
            EVENTS_STREAM,
            CONSUMER_GROUP,
            30000, // 30 second idle threshold
            async (message) => this.handleMessage(message)
        );

        // Start consumer loop in background (don't await - runs indefinitely)
        this.kvClient.startStreamConsumer(
            EVENTS_STREAM,
            CONSUMER_GROUP,
            async (message) => this.handleMessage(message),
            this.blockMs
        ).catch(error => {
            console.error('[FileEventConsumer] Stream consumer error:', error);
        });

        console.log('[FileEventConsumer] Stream consumer started');
    }

    /**
     * Stop consuming events
     */
    stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        this.kvClient.stopStreamConsumer();
        console.log('[FileEventConsumer] Stopped');
    }

    /**
     * Handle a stream message
     */
    private async handleMessage(message: StreamMessage): Promise<void> {
        // Convert relative path to absolute path
        const toAbsolutePath = (relativePath: string): string => {
            // If path is already absolute, return as-is
            if (relativePath.startsWith('/')) {
                return relativePath;
            }
            // Otherwise, prepend filesPath
            return `${this.filesPath}/${relativePath}`;
        };

        const absolutePath = toAbsolutePath(message.path);

        switch (message.type) {
            case 'add':
                this.pipeline.handleFileAdded(absolutePath, message.midhash256);
                break;

            case 'change':
                this.pipeline.handleFileChanged(absolutePath, message.midhash256);
                break;

            case 'delete':
                this.pipeline.handleFileDeleted(absolutePath);
                break;

            case 'rename':
                // Handle rename as delete + add
                if (message.oldPath) {
                    this.pipeline.handleFileDeleted(toAbsolutePath(message.oldPath));
                }
                this.pipeline.handleFileAdded(absolutePath, message.midhash256);
                break;

            default:
                console.warn(`[FileEventConsumer] Unknown event type: ${message.type}`);
        }
    }
}

/**
 * Create a FileEventConsumer with default configuration
 */
export function createFileEventConsumer(
    kvClient: RedisKVClient,
    pipeline: Pipeline,
    options?: Partial<FileEventConsumerOptions>
): FileEventConsumer {
    return new FileEventConsumer({
        kvClient,
        pipeline,
        ...options
    });
}
