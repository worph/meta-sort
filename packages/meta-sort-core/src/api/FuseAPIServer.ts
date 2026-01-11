/**
 * HTTP REST API Server for FUSE operations
 *
 * Exposes the VirtualFileSystem over HTTP for consumption by a FUSE driver.
 */

import * as http from 'http';
import { VirtualFileSystem } from './VirtualFileSystem.js';
import { FileAttributes, ReadResult } from './FuseAPI.js';

export interface FuseAPIServerConfig {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** Enable CORS (default: false) */
  enableCors?: boolean;
}

export class FuseAPIServer {
  private server: http.Server | null = null;
  private vfs: VirtualFileSystem;
  private config: Required<FuseAPIServerConfig>;

  constructor(vfs: VirtualFileSystem, config: FuseAPIServerConfig = {}) {
    this.vfs = vfs;
    this.config = {
      port: config.port ?? 3000,
      host: config.host ?? 'localhost',
      enableCors: config.enableCors ?? false
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
        console.log(`FUSE API Server listening on http://${this.config.host}:${this.config.port}`);
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
          console.log('FUSE API Server stopped');
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
      if (method === 'GET' && pathname === '/api/fuse/health') {
        this.handleHealth(res);
      } else if (method === 'GET' && pathname === '/api/fuse/stats') {
        this.handleStats(res);
      } else if (method === 'POST' && pathname === '/api/fuse/readdir') {
        await this.handleReaddir(req, res);
      } else if (method === 'POST' && pathname === '/api/fuse/getattr') {
        await this.handleGetattr(req, res);
      } else if (method === 'POST' && pathname === '/api/fuse/exists') {
        await this.handleExists(req, res);
      } else if (method === 'POST' && pathname === '/api/fuse/read') {
        await this.handleRead(req, res);
      } else if (method === 'POST' && pathname === '/api/fuse/metadata') {
        await this.handleMetadata(req, res);
      } else if (method === 'GET' && pathname === '/api/fuse/tree') {
        this.handleTree(res);
      } else if (method === 'GET' && pathname === '/api/fuse/files') {
        this.handleFiles(res);
      } else if (method === 'GET' && pathname === '/api/fuse/directories') {
        this.handleDirectories(res);
      } else if (method === 'POST' && pathname === '/api/fuse/refresh') {
        await this.handleRefresh(req, res);
      } else {
        this.sendError(res, 404, 'Not Found');
      }
    } catch (error) {
      console.error('Error handling request:', error);
      this.sendError(res, 500, 'Internal Server Error', error);
    }
  }

  /**
   * Parse JSON body from request
   */
  private async parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send JSON response
   */
  private sendJson(res: http.ServerResponse, data: any, statusCode: number = 200): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
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

  // API Handlers

  /**
   * GET /api/health
   * Health check endpoint
   */
  private handleHealth(res: http.ServerResponse): void {
    this.sendJson(res, {
      status: 'ok',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * GET /api/stats
   * Get VFS statistics
   */
  private handleStats(res: http.ServerResponse): void {
    const stats = this.vfs.getStats();
    this.sendJson(res, stats);
  }

  /**
   * POST /api/readdir
   * List directory contents
   * Body: { path: string }
   * Response: { entries: string[] } | { error: string }
   */
  private async handleReaddir(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { path } = await this.parseBody(req);

    if (typeof path !== 'string') {
      this.sendError(res, 400, 'Missing or invalid "path" parameter');
      return;
    }

    const entries = this.vfs.readdir(path);

    if (entries === null) {
      this.sendError(res, 404, 'Directory not found');
      return;
    }

    this.sendJson(res, { entries });
  }

  /**
   * POST /api/getattr
   * Get file attributes
   * Body: { path: string }
   * Response: FileAttributes | { error: string }
   */
  private async handleGetattr(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { path } = await this.parseBody(req);

    if (typeof path !== 'string') {
      this.sendError(res, 400, 'Missing or invalid "path" parameter');
      return;
    }

    const attrs = this.vfs.getattr(path);

    if (attrs === null) {
      this.sendError(res, 404, 'Path not found');
      return;
    }

    this.sendJson(res, attrs);
  }

  /**
   * POST /api/exists
   * Check if path exists
   * Body: { path: string }
   * Response: { exists: boolean }
   */
  private async handleExists(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { path } = await this.parseBody(req);

    if (typeof path !== 'string') {
      this.sendError(res, 400, 'Missing or invalid "path" parameter');
      return;
    }

    const exists = this.vfs.exists(path);
    this.sendJson(res, { exists });
  }

  /**
   * POST /api/read
   * Read file
   * Body: { path: string }
   * Response: ReadResult | { error: string }
   */
  private async handleRead(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { path } = await this.parseBody(req);

    if (typeof path !== 'string') {
      this.sendError(res, 400, 'Missing or invalid "path" parameter');
      return;
    }

    const result = this.vfs.read(path);

    if (result === null) {
      this.sendError(res, 404, 'File not found');
      return;
    }

    // Convert Buffer to base64 for JSON serialization
    const response: any = {
      sourcePath: result.sourcePath,
      size: result.size
    };

    if (result.content !== null) {
      response.content = result.content.toString('base64');
      response.contentEncoding = 'base64';
    }

    this.sendJson(res, response);
  }

  /**
   * POST /api/metadata
   * Get file metadata
   * Body: { path: string }
   * Response: HashMeta | { error: string }
   */
  private async handleMetadata(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { path } = await this.parseBody(req);

    if (typeof path !== 'string') {
      this.sendError(res, 400, 'Missing or invalid "path" parameter');
      return;
    }

    const metadata = this.vfs.getMetadata(path);

    if (metadata === null) {
      this.sendError(res, 404, 'Metadata not found');
      return;
    }

    this.sendJson(res, metadata);
  }

  /**
   * GET /api/tree
   * Get complete VFS tree
   */
  private handleTree(res: http.ServerResponse): void {
    const tree = this.vfs.getTree();
    this.sendJson(res, tree);
  }

  /**
   * GET /api/files
   * Get all file paths
   */
  private handleFiles(res: http.ServerResponse): void {
    const files = this.vfs.getAllFiles();
    this.sendJson(res, { files });
  }

  /**
   * GET /api/directories
   * Get all directory paths
   */
  private handleDirectories(res: http.ServerResponse): void {
    const directories = this.vfs.getAllDirectories();
    this.sendJson(res, { directories });
  }

  /**
   * POST /api/refresh
   * Refresh the VFS (no-op, VFS is updated by processing pipeline)
   */
  private async handleRefresh(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    await this.vfs.refresh();
    this.sendJson(res, { status: 'ok' });
  }
}
