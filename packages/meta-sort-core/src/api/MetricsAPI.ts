/**
 * HTTP REST API Server for Performance Metrics
 *
 * Provides a dedicated endpoint for exposing application performance metrics.
 * Separate from FUSE API to maintain proper separation of concerns.
 */

import * as http from 'http';
import { performanceMetrics } from '../metrics/PerformanceMetrics.js';

export interface MetricsAPIConfig {
  /** Port to listen on (default: 3001) */
  port?: number;
  /** Host to bind to (default: 'localhost') */
  host?: string;
  /** Enable CORS (default: true for metrics) */
  enableCors?: boolean;
  /** Mount path for metrics endpoint (default: '/metrics') */
  mountPath?: string;
}

export class MetricsAPI {
  private server: http.Server | null = null;
  private config: Required<MetricsAPIConfig>;

  constructor(config: MetricsAPIConfig = {}) {
    this.config = {
      port: config.port ?? 3001,
      host: config.host ?? 'localhost',
      enableCors: config.enableCors ?? true,
      mountPath: config.mountPath ?? '/metrics'
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
        console.log(`Metrics API listening on http://${this.config.host}:${this.config.port}${this.config.mountPath}`);
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
          console.log('Metrics API stopped');
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
        this.handleMetrics(res);
      } else if (method === 'GET' && pathname === '/health') {
        this.handleHealth(res);
      } else if (method === 'POST' && pathname === '/reset') {
        this.handleReset(res);
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
   * GET /metrics
   * Get performance metrics
   */
  private handleMetrics(res: http.ServerResponse): void {
    const metrics = performanceMetrics.getMetrics();
    this.sendJson(res, metrics);
  }

  /**
   * GET /health
   * Health check endpoint
   */
  private handleHealth(res: http.ServerResponse): void {
    this.sendJson(res, {
      status: 'ok',
      service: 'metrics-api',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * POST /reset
   * Reset all metrics
   */
  private handleReset(res: http.ServerResponse): void {
    performanceMetrics.reset();
    this.sendJson(res, {
      status: 'ok',
      message: 'Metrics reset successfully'
    });
  }
}
