/**
 * HTTP REST API Server for Duplicate Files
 *
 * Provides endpoints for accessing duplicate file detection results.
 * Separate from FUSE API to maintain proper separation of concerns.
 */

import * as http from 'http';

export interface DuplicatesAPIConfig {
  /** Port to listen on (default: 3003) */
  port?: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** Enable CORS (default: true) */
  enableCors?: boolean;
  /** Mount path for duplicates endpoint (default: '/duplicates') */
  mountPath?: string;
}

export class DuplicatesAPI {
  private server: http.Server | null = null;
  private config: Required<DuplicatesAPIConfig>;

  constructor(config: DuplicatesAPIConfig = {}) {
    this.config = {
      port: config.port ?? 3003,
      host: config.host ?? 'localhost',
      enableCors: config.enableCors ?? true,
      mountPath: config.mountPath ?? '/duplicates'
    };
  }

  /**
   * Start the HTTP server
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.handleRequest.bind(this));

      this.server.on('error', reject);

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`Duplicates API listening on http://${this.config.host}:${this.config.port}${this.config.mountPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          reject(err);
        } else {
          console.log('Duplicates API stopped');
          this.server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers
    if (this.config.enableCors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const pathname = url.pathname;
      const method = req.method!;

      // Route the request
      if (method === 'GET' && pathname === this.config.mountPath) {
        await this.handleDuplicates(res);
      } else if (method === 'GET' && pathname === '/health') {
        this.handleHealth(res);
      } else {
        this.sendError(res, 404, 'Not Found');
      }
    } catch (error) {
      console.error('Error handling request:', error);
      this.sendError(res, 500, 'Internal Server Error', error);
    }
  }

  /**
   * Send JSON response
   */
  private sendJson(res: http.ServerResponse, data: any, statusCode: number = 200): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Send error response
   */
  private sendError(res: http.ServerResponse, statusCode: number, message: string, error?: any): void {
    this.sendJson(res, {
      error: message,
      details: error?.message ?? error
    }, statusCode);
  }

  /**
   * GET /duplicates
   * Get duplicate files
   * NOTE: This API is deprecated. Use UnifiedAPIServer's /api/duplicates endpoint instead.
   * Disk-based duplicate logging has been removed for performance.
   */
  private async handleDuplicates(res: http.ServerResponse): Promise<void> {
    try {
      // Return empty results - duplicate detection now happens in-memory via UnifiedAPIServer
      const hashDuplicates: Array<{ key: string; files: string[]; virtualPath?: string }> = [];
      const titleDuplicates: Array<{ key: string; files: string[]; virtualPath?: string }> = [];

      this.sendJson(res, {
        hashDuplicates,
        titleDuplicates,
        stats: {
          hashGroupCount: 0,
          hashFileCount: 0,
          titleGroupCount: 0,
          titleFileCount: 0
        },
        deprecated: true,
        message: 'This API is deprecated. Use UnifiedAPIServer /api/duplicates endpoint instead.'
      });
    } catch (error) {
      console.error('Error in duplicates endpoint:', error);
      this.sendError(res, 500, 'Failed to get duplicate data', error);
    }
  }

  /**
   * GET /health
   * Health check endpoint
   */
  private handleHealth(res: http.ServerResponse): void {
    this.sendJson(res, {
      status: 'ok',
      service: 'duplicates-api',
      timestamp: new Date().toISOString()
    });
  }
}
