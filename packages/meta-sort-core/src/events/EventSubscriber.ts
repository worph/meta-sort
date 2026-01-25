/**
 * EventSubscriber
 *
 * Subscribes to file events from meta-core via SSE (Server-Sent Events).
 * When events are received, they are forwarded to the StreamingPipeline.
 *
 * This enables meta-sort to run without direct filesystem access - it receives
 * file discovery events from meta-core and processes files via WebDAV.
 */

import { EventSource } from 'eventsource';

// File event types matching meta-core's watcher
interface FileEvent {
  type: 'add' | 'change' | 'delete' | 'rename';
  path: string;           // Relative to FILES_PATH
  size?: number;
  timestamp: number;
  partialHash?: string;   // Hash of first 64KB
  oldPath?: string;       // For rename events
}

// Pipeline interface (minimal, matching StreamingPipeline)
interface Pipeline {
  handleFileAdded(filePath: string): void;
  handleFileChanged(filePath: string): void;
  handleFileDeleted(filePath: string): void;
}

export interface EventSubscriberOptions {
  /** URL of meta-core API (e.g., http://meta-core or http://localhost:8083) */
  metaCoreUrl: string;

  /** Pipeline to receive events */
  pipeline: Pipeline;

  /** Base path for files (e.g., /files). Paths from meta-core are relative and need this prefix. */
  filesPath?: string;

  /** Whether to request an initial scan when connecting */
  requestInitialScan?: boolean;

  /** Reconnect delay in milliseconds */
  reconnectDelayMs?: number;

  /** Maximum reconnect attempts (0 = unlimited) */
  maxReconnectAttempts?: number;
}

export class EventSubscriber {
  private options: Required<EventSubscriberOptions>;
  private eventSource: EventSource | null = null;
  private isRunning = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: EventSubscriberOptions) {
    this.options = {
      filesPath: '/files',
      requestInitialScan: true,
      reconnectDelayMs: 5000,
      maxReconnectAttempts: 0, // Unlimited by default
      ...options
    };
  }

  /**
   * Start subscribing to events from meta-core
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[EventSubscriber] Already running');
      return;
    }

    this.isRunning = true;
    console.log(`[EventSubscriber] Connecting to ${this.options.metaCoreUrl}/api/events/subscribe`);

    await this.connect();
  }

  /**
   * Stop subscribing to events
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    console.log('[EventSubscriber] Stopped');
  }

  /**
   * Trigger a manual scan on meta-core
   */
  async triggerScan(): Promise<void> {
    try {
      const response = await fetch(`${this.options.metaCoreUrl}/api/scan/trigger`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('[EventSubscriber] Scan triggered on meta-core');
    } catch (error) {
      console.error('[EventSubscriber] Failed to trigger scan:', error);
    }
  }

  /**
   * Get watcher status from meta-core
   */
  async getStatus(): Promise<{
    status: string;
    scanning: boolean;
    lastScan: number;
    fileCount: number;
  } | null> {
    try {
      const response = await fetch(`${this.options.metaCoreUrl}/api/scan/status`);

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('[EventSubscriber] Failed to get status:', error);
      return null;
    }
  }

  /**
   * Poll for events since a timestamp (fallback for SSE)
   */
  async pollEvents(sinceMs: number, limit = 100): Promise<FileEvent[]> {
    try {
      const url = `${this.options.metaCoreUrl}/api/events/poll?since=${sinceMs}&limit=${limit}`;
      const response = await fetch(url);

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return data.events || [];
    } catch (error) {
      console.error('[EventSubscriber] Failed to poll events:', error);
      return [];
    }
  }

  private async connect(): Promise<void> {
    if (!this.isRunning) return;

    const url = `${this.options.metaCoreUrl}/api/events/subscribe`;

    try {
      this.eventSource = new EventSource(url);

      this.eventSource.onopen = () => {
        console.log('[EventSubscriber] Connected to meta-core SSE');
        this.reconnectAttempts = 0;

        // Request initial scan if configured
        if (this.options.requestInitialScan) {
          this.triggerScan().catch(err => {
            console.error('[EventSubscriber] Failed to trigger initial scan:', err);
          });
        }
      };

      this.eventSource.onerror = (error) => {
        console.error('[EventSubscriber] SSE connection error:', error);
        this.scheduleReconnect();
      };

      // Handle file events
      this.eventSource.addEventListener('file', (event: MessageEvent) => {
        try {
          const fileEvent: FileEvent = JSON.parse(event.data);
          this.handleEvent(fileEvent);
        } catch (error) {
          console.error('[EventSubscriber] Failed to parse event:', error);
        }
      });

      // Handle connected event
      this.eventSource.addEventListener('connected', () => {
        console.log('[EventSubscriber] Received connected event');
      });

    } catch (error) {
      console.error('[EventSubscriber] Failed to connect:', error);
      this.scheduleReconnect();
    }
  }

  private handleEvent(event: FileEvent): void {
    const { pipeline, filesPath } = this.options;

    // Convert relative path to absolute path
    const toAbsolutePath = (relativePath: string): string => {
      // If path is already absolute, return as-is
      if (relativePath.startsWith('/')) {
        return relativePath;
      }
      // Otherwise, prepend filesPath
      return `${filesPath}/${relativePath}`;
    };

    const absolutePath = toAbsolutePath(event.path);

    switch (event.type) {
      case 'add':
        pipeline.handleFileAdded(absolutePath);
        break;

      case 'change':
        pipeline.handleFileChanged(absolutePath);
        break;

      case 'delete':
        pipeline.handleFileDeleted(absolutePath);
        break;

      case 'rename':
        // Handle rename as delete + add
        if (event.oldPath) {
          pipeline.handleFileDeleted(toAbsolutePath(event.oldPath));
        }
        pipeline.handleFileAdded(absolutePath);
        break;

      default:
        console.warn(`[EventSubscriber] Unknown event type: ${event.type}`);
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;

    // Close existing connection
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Check reconnect limits
    if (this.options.maxReconnectAttempts > 0 &&
        this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error('[EventSubscriber] Max reconnect attempts reached, giving up');
      this.isRunning = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = this.options.reconnectDelayMs * Math.min(this.reconnectAttempts, 6); // Max 30s

    console.log(`[EventSubscriber] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/**
 * Create an EventSubscriber with default configuration
 */
export function createEventSubscriber(
  metaCoreUrl: string,
  pipeline: Pipeline,
  options?: Partial<EventSubscriberOptions>
): EventSubscriber {
  return new EventSubscriber({
    metaCoreUrl,
    pipeline,
    ...options
  });
}
