/**
 * Service Discovery using shared filesystem
 *
 * Each service registers itself in /meta-core/services/{service-name}-{hostname}.json
 * with its base URL, status, and heartbeat timestamp.
 *
 * Services can discover each other by reading these JSON files.
 * Stale detection: if lastHeartbeat > 60 seconds ago, service is considered stale.
 *
 * Note: meta-core (Go sidecar) handles actual service registration.
 * This class is primarily used for discovering other services.
 */

import { promises as fs } from 'fs';
import { hostname } from 'os';
import { join, basename } from 'path';
import type { ServiceInfo } from './IKVClient.js';
import { isNodeError } from '../types/ExtendedInterfaces.js';

interface ServiceDiscoveryConfig {
    /** Path to META_CORE_VOLUME (e.g., /meta-core) */
    metaCorePath: string;

    /** Service name */
    serviceName: string;

    /** Service version (optional, not used in simplified format) */
    version?: string;

    /** Base URL for the service */
    apiUrl: string;

    /** Heartbeat interval in ms (default: 30000) */
    heartbeatInterval?: number;

    /** Stale threshold in ms (default: 60000) */
    staleThreshold?: number;
}

export class ServiceDiscovery {
    private config: ServiceDiscoveryConfig;
    private servicesDir: string;
    private serviceFilePath: string;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private isShuttingDown = false;
    private currentHostname: string;

    constructor(config: ServiceDiscoveryConfig) {
        this.config = {
            heartbeatInterval: 30000,
            staleThreshold: 60000,
            ...config
        };

        this.currentHostname = hostname();
        this.servicesDir = `${this.config.metaCorePath}/services`;
        // Use hostname-based file naming
        this.serviceFilePath = `${this.servicesDir}/${this.config.serviceName}-${this.currentHostname}.json`;
    }

    /**
     * Ensure services directory exists
     */
    private async ensureServicesDir(): Promise<void> {
        await fs.mkdir(this.servicesDir, { recursive: true });
    }

    /**
     * Build service info for this service
     */
    private buildServiceInfo(status: ServiceInfo['status']): ServiceInfo {
        return {
            name: this.config.serviceName,
            hostname: this.currentHostname,
            baseUrl: this.config.apiUrl,
            status,
            lastHeartbeat: new Date().toISOString()
        };
    }

    /**
     * Register this service
     * Note: In the new architecture, meta-core handles registration.
     * This is kept for backwards compatibility and testing.
     */
    async register(): Promise<void> {
        await this.ensureServicesDir();

        const info = this.buildServiceInfo('running');
        await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));

        console.log(`[ServiceDiscovery] Registered ${this.config.serviceName}-${this.currentHostname}`);
    }

    /**
     * Update service status
     */
    async updateStatus(status: ServiceInfo['status']): Promise<void> {
        try {
            const content = await fs.readFile(this.serviceFilePath, 'utf-8');
            const info = JSON.parse(content) as ServiceInfo;

            info.status = status;
            info.lastHeartbeat = new Date().toISOString();

            await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));
        } catch (error) {
            console.error('[ServiceDiscovery] Failed to update status:', error);
        }
    }

    /**
     * Send heartbeat (update lastHeartbeat timestamp)
     */
    async heartbeat(): Promise<void> {
        try {
            const content = await fs.readFile(this.serviceFilePath, 'utf-8');
            const info = JSON.parse(content) as ServiceInfo;

            info.lastHeartbeat = new Date().toISOString();

            await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));
        } catch (error) {
            // If file was deleted, re-register
            if (isNodeError(error) && error.code === 'ENOENT') {
                await this.register();
            } else {
                console.error('[ServiceDiscovery] Heartbeat failed:', error);
            }
        }
    }

    /**
     * Start heartbeat loop
     */
    startHeartbeat(): void {
        this.heartbeatTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.heartbeat();
        }, this.config.heartbeatInterval);
    }

    /**
     * Stop heartbeat loop
     */
    stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Unregister this service (on shutdown)
     */
    async unregister(): Promise<void> {
        this.isShuttingDown = true;
        this.stopHeartbeat();

        try {
            // Remove the service file
            await fs.unlink(this.serviceFilePath);
            console.log(`[ServiceDiscovery] Unregistered ${this.config.serviceName}-${this.currentHostname}`);
        } catch (error) {
            if (!isNodeError(error) || error.code !== 'ENOENT') {
                console.error('[ServiceDiscovery] Failed to unregister:', error);
            }
        }
    }

    /**
     * Check if a service info is stale
     */
    private isStale(info: ServiceInfo): boolean {
        const lastHeartbeat = new Date(info.lastHeartbeat).getTime();
        return Date.now() - lastHeartbeat > this.config.staleThreshold!;
    }

    // ========================================================================
    // Discovery Methods
    // ========================================================================

    /**
     * Discover a service by name
     * Looks for files matching pattern: {name}-*.json (hostname-based naming)
     */
    async discoverService(name: string): Promise<ServiceInfo | null> {
        try {
            // First try exact match for backward compatibility
            const exactPath = join(this.servicesDir, `${name}.json`);
            try {
                const content = await fs.readFile(exactPath, 'utf-8');
                const service = JSON.parse(content) as ServiceInfo;

                if (this.isStale(service)) {
                    service.status = 'stale';
                }

                return service.status === 'running' ? service : null;
            } catch {
                // Try hostname-based files
            }

            // Search for hostname-based files: name-*.json
            const files = await fs.readdir(this.servicesDir);
            const matchingFiles = files.filter(f =>
                f.startsWith(`${name}-`) && f.endsWith('.json')
            );

            // Return first valid (non-stale) service
            for (const file of matchingFiles) {
                const filePath = join(this.servicesDir, file);
                const content = await fs.readFile(filePath, 'utf-8');
                const service = JSON.parse(content) as ServiceInfo;

                if (this.isStale(service)) {
                    service.status = 'stale';
                    continue; // Skip stale services
                }

                if (service.status === 'running') {
                    return service;
                }
            }

            return null;
        } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') {
                return null; // Service not registered
            }
            throw error;
        }
    }

    /**
     * Discover all registered services
     */
    async discoverAllServices(): Promise<ServiceInfo[]> {
        try {
            const files = await fs.readdir(this.servicesDir);
            const services: ServiceInfo[] = [];

            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                const filePath = join(this.servicesDir, file);
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const service = JSON.parse(content) as ServiceInfo;

                    if (this.isStale(service)) {
                        service.status = 'stale';
                    }

                    services.push(service);
                } catch (error) {
                    console.error(`[ServiceDiscovery] Failed to read ${file}:`, error);
                }
            }

            return services;
        } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') {
                return []; // Services directory doesn't exist yet
            }
            throw error;
        }
    }

    /**
     * Wait for a service to become available
     */
    async waitForService(
        name: string,
        timeoutMs: number = 30000,
        pollInterval: number = 1000
    ): Promise<ServiceInfo> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const service = await this.discoverService(name);
            if (service && service.status === 'running') {
                return service;
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        throw new Error(`Service ${name} not available after ${timeoutMs}ms`);
    }

    /**
     * Check if a service is healthy
     */
    async isServiceHealthy(name: string): Promise<boolean> {
        const service = await this.discoverService(name);
        if (!service) return false;

        // Try to ping the service's health endpoint
        const url = `${service.baseUrl}/health`;

        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Full startup sequence
     * Note: In the new architecture, meta-core handles registration.
     */
    async start(): Promise<void> {
        await this.register();
        this.startHeartbeat();
    }

    /**
     * Full shutdown sequence
     */
    async stop(): Promise<void> {
        await this.unregister();
    }

    // ========================================================================
    // Getters
    // ========================================================================

    getServiceFilePath(): string {
        return this.serviceFilePath;
    }

    getServicesDir(): string {
        return this.servicesDir;
    }
}
