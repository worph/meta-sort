/**
 * Container Manager
 *
 * Manages the lifecycle of plugin containers including spawning,
 * health checking, configuration, and cleanup.
 */

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { join } from 'path';
import { DockerClient } from './DockerClient.js';
import {
    loadConfig,
    getEnabledPlugins,
    saveConfig,
} from './ConfigParser.js';
import type {
    ContainerPluginsConfig,
    ContainerPluginConfig,
    ContainerPluginManifest,
    ContainerPluginInstance,
    ContainerInstanceStatus,
    ContainerManagerStatus,
    PluginHealthResponse,
    PluginConfigureResponse,
} from './types.js';
import { config } from '../config/EnvConfig.js';

/**
 * Service info structure from meta-core service discovery
 */
interface ServiceInfo {
    name: string;
    api: string;
    endpoints: Record<string, string>;
}

/**
 * Container manager events
 */
export interface ContainerManagerEvents {
    'plugin:starting': { pluginId: string; instanceIndex: number };
    'plugin:started': { pluginId: string; instance: ContainerPluginInstance };
    'plugin:healthy': { pluginId: string; instance: ContainerPluginInstance };
    'plugin:unhealthy': { pluginId: string; instance: ContainerPluginInstance; error: string };
    'plugin:stopped': { pluginId: string; instanceIndex: number };
    'plugin:error': { pluginId: string; error: Error };
    'manager:initialized': { pluginCount: number };
    'manager:shutdown': {};
}

/**
 * Container naming helper
 */
function getContainerName(pluginId: string, instanceIndex: number): string {
    return `meta-plugin-${pluginId}-${instanceIndex}`;
}

/**
 * Container Manager
 */
/**
 * ============================================================================
 * PLUGIN FILE ACCESS ARCHITECTURE - WebDAV
 * ============================================================================
 *
 * Plugins access the /files directory via WebDAV served by meta-sort nginx:
 *
 *   /webdav (WebDAV endpoint) - Exposes /files with caching
 *     /files/watch    - Watch folder (media files)
 *     /files/test     - Test media folder
 *     /files/plugin/  - Plugin output (each plugin writes to /files/plugin/<name>/)
 *     /files/corn     - SMB mounts (mounted by rclone inside meta-sort)
 *
 * WebDAV configuration:
 *   - webdavUrl: Retrieved from meta-core /urls API via LeaderClient
 *
 * Benefits:
 *   - Works with Docker's overlay filesystem (no NFS file handle issues)
 *   - nginx caching for multiple plugins accessing same file
 *   - Range requests for streaming large files
 *   - Bidirectional (read/write) via standard HTTP methods
 *
 * ============================================================================
 */

export class ContainerManager extends EventEmitter {
    private dockerClient: DockerClient;
    private pluginsConfig: ContainerPluginsConfig | null = null;
    private instances: Map<string, ContainerPluginInstance[]> = new Map();
    private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map();
    private roundRobinCounters: Map<string, number> = new Map();
    private initialized: boolean = false;
    private shutdownInProgress: boolean = false;
    private webdavUrl?: string;
    private stackName?: string;
    private callbackUrl: string;
    private metaCoreUrl: string;

    constructor(
        private configPath: string = config.CONTAINER_PLUGINS_CONFIG,
        private network: string = config.CONTAINER_NETWORK,
        private filesPath: string = config.FILES_PATH,
        callbackUrl?: string,
        metaCoreUrl?: string,
        webdavUrl?: string,
        dockerClient?: DockerClient
    ) {
        super();
        this.dockerClient = dockerClient || new DockerClient(config.DOCKER_SOCKET_PATH);

        // Initialize with provided values or env vars as fallback
        this.callbackUrl = callbackUrl ?? config.CONTAINER_CALLBACK_URL;
        this.metaCoreUrl = metaCoreUrl ?? config.CONTAINER_META_CORE_URL;
        this.webdavUrl = webdavUrl;

        // Configure stack name for Docker Desktop grouping
        this.stackName = config.PLUGIN_STACK_NAME;
    }

    /**
     * Discover service URLs from meta-core service discovery file
     * WebDAV URL should be passed via constructor (from LeaderClient/meta-core API)
     * Service discovery is used for callback URL fallback
     */
    private async discoverServiceUrls(): Promise<void> {
        // Log WebDAV URL (should be set from meta-core API via LeaderClient)
        if (this.webdavUrl) {
            console.log(`[ContainerManager] Using WebDAV URL from meta-core: ${this.webdavUrl}`);
        }

        // Check if callback URL is already set
        const explicitCallbackUrl = config.CONTAINER_CALLBACK_URL;
        if (explicitCallbackUrl) {
            this.callbackUrl = explicitCallbackUrl;
            console.log(`[ContainerManager] Using explicit callback URL: ${this.callbackUrl}`);
        }

        // If both are set, skip service discovery
        if (this.callbackUrl && this.webdavUrl) {
            console.log('[ContainerManager] All URLs configured, skipping service discovery');
            return;
        }

        // Fall back to service discovery for any missing URLs
        const serviceFile = join(config.META_CORE_PATH, 'services', 'meta-sort.json');

        try {
            const content = await fs.readFile(serviceFile, 'utf-8');
            const serviceInfo: ServiceInfo = JSON.parse(content);

            // Extract URLs from service info
            const api = serviceInfo.api;
            const endpoints = serviceInfo.endpoints || {};

            // Use service discovery for callback URL if not set
            if (!this.callbackUrl) {
                if (endpoints.callback) {
                    this.callbackUrl = endpoints.callback;
                    console.log(`[ContainerManager] Discovered callback URL: ${this.callbackUrl}`);
                } else if (api) {
                    // Fallback: construct from api base
                    this.callbackUrl = `${api}/api/plugins/callback`;
                    console.log(`[ContainerManager] Constructed callback URL: ${this.callbackUrl}`);
                }
            }

            // Use service discovery for WebDAV URL if not set (fallback)
            if (!this.webdavUrl) {
                if (endpoints.webdav) {
                    this.webdavUrl = endpoints.webdav;
                    console.log(`[ContainerManager] Discovered WebDAV URL: ${this.webdavUrl}`);
                } else if (api) {
                    // Fallback: construct from api base
                    this.webdavUrl = `${api}/webdav`;
                    console.log(`[ContainerManager] Constructed WebDAV URL: ${this.webdavUrl}`);
                }
            }

            if (endpoints.health) {
                // Extract meta-core URL from health endpoint
                const healthUrl = new URL(endpoints.health);
                this.metaCoreUrl = `${healthUrl.protocol}//${healthUrl.host}`;
                console.log(`[ContainerManager] Discovered meta-core URL: ${this.metaCoreUrl}`);
            }

            console.log('[ContainerManager] Service discovery successful');
        } catch (error) {
            console.warn(`[ContainerManager] Service discovery failed: ${error}`);
            console.log(`[ContainerManager] Using callback URL: ${this.callbackUrl}`);
            console.log(`[ContainerManager] Using WebDAV URL: ${this.webdavUrl || 'not set'}`);
        }
    }

    /**
     * Initialize the container manager
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        console.log('[ContainerManager] Initializing...');

        // Discover service URLs from meta-core service discovery
        await this.discoverServiceUrls();

        // Log WebDAV configuration
        console.log('[ContainerManager] Plugin file access configuration (WebDAV):');
        if (this.webdavUrl) {
            console.log(`  WebDAV URL: ${this.webdavUrl}`);
            console.log('    /files/watch    - Watch folder (media files)');
            console.log('    /files/test     - Test media folder');
            console.log('    /files/plugin/  - Plugin output (per-plugin subdirs)');
            console.log('    /files/corn     - SMB mounts (visible via WebDAV)');
        } else {
            console.warn('  WebDAV not configured.');
            console.warn('  Plugins will not have access to files.');
        }

        // Initialize Docker client
        await this.dockerClient.initialize();

        // Ensure network exists
        await this.dockerClient.ensureNetwork(this.network);

        // Load configuration
        this.pluginsConfig = await loadConfig(this.configPath);

        // Get enabled plugins
        const enabledPlugins = getEnabledPlugins(this.pluginsConfig);

        console.log(`[ContainerManager] Found ${enabledPlugins.length} enabled plugins`);

        // Clean up any stale containers from previous runs
        await this.cleanupStaleContainers();

        // Spawn containers for each enabled plugin
        for (const { id, config: pluginConfig } of enabledPlugins) {
            try {
                await this.spawnPlugin(id, pluginConfig);
            } catch (error) {
                console.error(`[ContainerManager] Failed to spawn plugin '${id}':`, error);
                this.emit('plugin:error', {
                    pluginId: id,
                    error: error instanceof Error ? error : new Error(String(error)),
                });
            }
        }

        this.initialized = true;
        this.emit('manager:initialized', { pluginCount: enabledPlugins.length });

        console.log('[ContainerManager] Initialization complete');
    }

    /**
     * Shutdown the container manager
     */
    async shutdown(): Promise<void> {
        if (this.shutdownInProgress) {
            return;
        }

        this.shutdownInProgress = true;
        console.log('[ContainerManager] Shutting down...');

        // Stop health checks
        for (const interval of this.healthCheckIntervals.values()) {
            clearInterval(interval);
        }
        this.healthCheckIntervals.clear();

        // Stop all plugin containers
        for (const [pluginId, instances] of this.instances) {
            for (const instance of instances) {
                try {
                    await this.stopInstance(instance);
                } catch (error) {
                    console.error(
                        `[ContainerManager] Error stopping ${instance.containerName}:`,
                        error
                    );
                }
            }
        }

        this.instances.clear();
        this.initialized = false;
        this.shutdownInProgress = false;
        this.emit('manager:shutdown', {});

        console.log('[ContainerManager] Shutdown complete');
    }

    /**
     * Spawn all instances for a plugin
     */
    async spawnPlugin(pluginId: string, pluginConfig: ContainerPluginConfig): Promise<void> {
        const instanceCount = pluginConfig.instances || 1;
        const instances: ContainerPluginInstance[] = [];

        console.log(
            `[ContainerManager] Spawning ${instanceCount} instance(s) for plugin '${pluginId}'`
        );

        // Pull image if needed
        const imageExists = await this.dockerClient.imageExists(pluginConfig.image);
        if (!imageExists) {
            console.log(`[ContainerManager] Pulling image ${pluginConfig.image}...`);
            await this.dockerClient.pullImage(pluginConfig.image, (event) => {
                if (event.status) {
                    console.log(`[ContainerManager] Pull: ${event.status}`);
                }
            });
        }

        // Spawn each instance
        for (let i = 0; i < instanceCount; i++) {
            this.emit('plugin:starting', { pluginId, instanceIndex: i });

            const instance = await this.spawnInstance(pluginId, pluginConfig, i);
            instances.push(instance);

            this.emit('plugin:started', { pluginId, instance });
        }

        this.instances.set(pluginId, instances);

        // Start health checking
        this.startHealthCheck(pluginId);

        // Wait for at least one instance to be healthy
        await this.waitForHealthy(pluginId, 30000);

        // Fetch manifest from first healthy instance
        const healthyInstance = this.getHealthyInstance(pluginId);
        if (healthyInstance) {
            try {
                const manifest = await this.fetchManifest(healthyInstance);
                // Update all instances with manifest
                for (const inst of instances) {
                    inst.manifest = manifest;
                }
            } catch (error) {
                console.warn(
                    `[ContainerManager] Failed to fetch manifest for '${pluginId}':`,
                    error
                );
            }

            // Send configuration
            if (pluginConfig.config) {
                try {
                    await this.sendConfig(healthyInstance, pluginConfig.config);
                } catch (error) {
                    console.warn(
                        `[ContainerManager] Failed to configure '${pluginId}':`,
                        error
                    );
                }
            }
        }
    }

    /**
     * Spawn a single container instance
     */
    private async spawnInstance(
        pluginId: string,
        pluginConfig: ContainerPluginConfig,
        instanceIndex: number
    ): Promise<ContainerPluginInstance> {
        const containerName = getContainerName(pluginId, instanceIndex);

        // Check if container already exists
        const existingContainers = await this.dockerClient.listContainers({
            name: [containerName],
        });

        if (existingContainers.length > 0) {
            const existing = existingContainers[0];
            // Remove existing container
            console.log(`[ContainerManager] Removing existing container ${containerName}`);
            await this.dockerClient.removeContainer(existing.Id, true);
        }

        /**
         * PLUGIN FILE ACCESS ARCHITECTURE - WebDAV:
         *   Plugins access files via WebDAV URL (no container mounts needed)
         *   Plugin output goes to /files/plugin/<plugin-id>/ via WebDAV PUT
         *   Sees all mounts including SMB via rclone
         *
         * Note: No volume mounts for /files - plugins use HTTP/WebDAV client
         * Cache: Each plugin gets a dedicated cache folder mounted at /cache
         */
        const mounts: Array<{ source: string; target: string; readonly: boolean }> = [];

        // Add cache mount for plugin persistence (survives container restarts)
        // Use PLUGIN_CACHE_HOST_PATH if set (host filesystem path for Docker bind mounts)
        // Otherwise fall back to internal path (only works if container shares filesystem)
        if (config.PLUGIN_CACHE_HOST_PATH) {
            const pluginCacheDir = `${config.PLUGIN_CACHE_HOST_PATH}/${pluginId}`;
            // Create directory on internal path (which maps to host path)
            const internalCacheDir = `${config.CACHE_FOLDER_PATH}/plugin-cache/${pluginId}`;
            await fs.mkdir(internalCacheDir, { recursive: true });
            mounts.push({
                source: pluginCacheDir,
                target: '/cache',
                readonly: false,
            });
        } else {
            console.warn(`[ContainerManager] PLUGIN_CACHE_HOST_PATH not set. Plugin '${pluginId}' cache will not persist across restarts.`);
        }

        // NOTE: Plugin output files are written via WebDAV (WEBDAV_URL/plugin/<pluginId>/)
        // No output mount needed - plugins use HTTP PUT to write files

        // Add any additional mounts from plugin config
        if (pluginConfig.mounts) {
            for (const mount of pluginConfig.mounts) {
                mounts.push({
                    source: mount.source,
                    target: mount.target,
                    readonly: mount.readonly ?? true,
                });
            }
        }

        // No file mounts needed - plugins access files via WebDAV
        if (!this.webdavUrl) {
            console.warn(`[ContainerManager] WARNING: WebDAV not configured. Plugin '${pluginId}' won't have access to files. Ensure meta-core is running and accessible.`);
        }

        // Create container
        const containerId = await this.dockerClient.createContainer({
            image: pluginConfig.image,
            name: containerName,
            network: this.network,
            resources: pluginConfig.resources,
            mounts,
            labels: {
                'meta-mesh.plugin': 'true',
                'meta-mesh.plugin.id': pluginId,
                'meta-mesh.plugin.instance': String(instanceIndex),
            },
            env: {
                PLUGIN_ID: pluginId,
                META_CORE_URL: this.metaCoreUrl,
                CALLBACK_URL: this.callbackUrl,
                WEBDAV_URL: this.webdavUrl || '',
                FILES_PATH: '/files', // Virtual path - files accessed via WebDAV
            },
            // Docker Desktop grouping
            stackName: this.stackName,
            serviceName: pluginId,
        });

        // Start container
        await this.dockerClient.startContainer(containerId);

        // Create instance record
        const instance: ContainerPluginInstance = {
            pluginId,
            containerId,
            containerName,
            baseUrl: `http://${containerName}:8080`,
            instanceIndex,
            status: 'starting',
            tasksProcessed: 0,
            tasksFailed: 0,
        };

        console.log(`[ContainerManager] Started container ${containerName}`);

        return instance;
    }

    /**
     * Stop a container instance
     */
    private async stopInstance(instance: ContainerPluginInstance): Promise<void> {
        console.log(`[ContainerManager] Stopping ${instance.containerName}...`);

        try {
            await this.dockerClient.stopContainer(instance.containerId, 10);
        } catch (error) {
            // Container might already be stopped
        }

        try {
            await this.dockerClient.removeContainer(instance.containerId, true);
        } catch (error) {
            // Container might already be removed
        }

        instance.status = 'stopped';
        this.emit('plugin:stopped', {
            pluginId: instance.pluginId,
            instanceIndex: instance.instanceIndex,
        });
    }

    /**
     * Start health check loop for a plugin
     */
    private startHealthCheck(pluginId: string, intervalMs: number = 30000): void {
        // Clear existing interval if any
        const existing = this.healthCheckIntervals.get(pluginId);
        if (existing) {
            clearInterval(existing);
        }

        const checkHealth = async () => {
            const instances = this.instances.get(pluginId);
            if (!instances) return;

            for (const instance of instances) {
                if (instance.status === 'stopped') continue;

                try {
                    const healthy = await this.checkHealth(instance);
                    const previousStatus = instance.status;

                    if (healthy) {
                        instance.status = 'healthy';
                        instance.lastHealthCheck = Date.now();

                        if (previousStatus !== 'healthy') {
                            this.emit('plugin:healthy', { pluginId, instance });
                        }
                    } else {
                        instance.status = 'unhealthy';
                        instance.lastError = 'Health check failed';

                        if (previousStatus === 'healthy') {
                            this.emit('plugin:unhealthy', {
                                pluginId,
                                instance,
                                error: 'Health check failed',
                            });
                        }
                    }
                } catch (error) {
                    instance.status = 'unhealthy';
                    instance.lastError = error instanceof Error ? error.message : String(error);

                    this.emit('plugin:unhealthy', {
                        pluginId,
                        instance,
                        error: instance.lastError,
                    });
                }
            }
        };

        // Initial check
        checkHealth();

        // Schedule periodic checks
        const interval = setInterval(checkHealth, intervalMs);
        this.healthCheckIntervals.set(pluginId, interval);
    }

    /**
     * Check health of a container instance
     */
    async checkHealth(instance: ContainerPluginInstance): Promise<boolean> {
        try {
            const response = await fetch(`${instance.baseUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
                return false;
            }

            const data = (await response.json()) as PluginHealthResponse;
            return data.status === 'healthy' && data.ready === true;
        } catch {
            return false;
        }
    }

    /**
     * Wait for at least one healthy instance
     */
    private async waitForHealthy(pluginId: string, timeoutMs: number): Promise<void> {
        const startTime = Date.now();
        const checkInterval = 1000;

        while (Date.now() - startTime < timeoutMs) {
            const instances = this.instances.get(pluginId);
            if (!instances) return;

            for (const instance of instances) {
                const healthy = await this.checkHealth(instance);
                if (healthy) {
                    instance.status = 'healthy';
                    instance.lastHealthCheck = Date.now();
                    this.emit('plugin:healthy', { pluginId, instance });
                    return;
                }
            }

            await new Promise((resolve) => setTimeout(resolve, checkInterval));
        }

        console.warn(`[ContainerManager] Timeout waiting for healthy instance of '${pluginId}'`);
    }

    /**
     * Fetch manifest from a container instance
     */
    async fetchManifest(instance: ContainerPluginInstance): Promise<ContainerPluginManifest> {
        const response = await fetch(`${instance.baseUrl}/manifest`, {
            method: 'GET',
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch manifest: ${response.status}`);
        }

        return response.json() as Promise<ContainerPluginManifest>;
    }

    /**
     * Send configuration to a container instance
     */
    async sendConfig(
        instance: ContainerPluginInstance,
        pluginConfig: Record<string, unknown>
    ): Promise<void> {
        const response = await fetch(`${instance.baseUrl}/configure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: pluginConfig }),
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            throw new Error(`Failed to configure plugin: ${response.status}`);
        }

        const data = (await response.json()) as PluginConfigureResponse;
        if (!data.success) {
            throw new Error(`Plugin configuration failed: ${data.error}`);
        }
    }

    /**
     * Get a healthy instance for a plugin (round-robin)
     */
    getHealthyInstance(pluginId: string): ContainerPluginInstance | null {
        const instances = this.instances.get(pluginId);
        if (!instances || instances.length === 0) {
            return null;
        }

        const healthyInstances = instances.filter((i) => i.status === 'healthy');
        if (healthyInstances.length === 0) {
            return null;
        }

        // Round-robin selection
        const counter = this.roundRobinCounters.get(pluginId) || 0;
        const selected = healthyInstances[counter % healthyInstances.length];
        this.roundRobinCounters.set(pluginId, counter + 1);

        return selected;
    }

    /**
     * Get all instances for a plugin
     */
    getInstances(pluginId: string): ContainerPluginInstance[] {
        return this.instances.get(pluginId) || [];
    }

    /**
     * Get all plugins
     */
    getPluginIds(): string[] {
        return Array.from(this.instances.keys());
    }

    /**
     * Check if a plugin is a container plugin
     */
    isContainerPlugin(pluginId: string): boolean {
        return this.instances.has(pluginId);
    }

    /**
     * Get plugin manifest
     */
    getPluginManifest(pluginId: string): ContainerPluginManifest | undefined {
        const instances = this.instances.get(pluginId);
        if (!instances || instances.length === 0) {
            return undefined;
        }
        return instances[0].manifest;
    }

    /**
     * Get manager status
     */
    getStatus(): ContainerManagerStatus {
        const plugins: ContainerManagerStatus['plugins'] = [];

        for (const [pluginId, instances] of this.instances) {
            const pluginConfig = this.pluginsConfig?.plugins[pluginId];
            const healthyCount = instances.filter((i) => i.status === 'healthy').length;

            plugins.push({
                pluginId,
                enabled: pluginConfig?.enabled !== false,
                image: pluginConfig?.image || 'unknown',
                instances: instances.length,
                healthyInstances: healthyCount,
                manifest: instances[0]?.manifest,
            });
        }

        const totalInstances = Array.from(this.instances.values()).reduce(
            (sum, instances) => sum + instances.length,
            0
        );

        const healthyInstances = Array.from(this.instances.values()).reduce(
            (sum, instances) => sum + instances.filter((i) => i.status === 'healthy').length,
            0
        );

        return {
            initialized: this.initialized,
            pluginCount: this.instances.size,
            runningContainers: totalInstances,
            healthyContainers: healthyInstances,
            plugins,
        };
    }

    /**
     * Restart a plugin (stop and respawn all instances)
     */
    async restartPlugin(pluginId: string): Promise<void> {
        console.log(`[ContainerManager] Restarting plugin '${pluginId}'...`);

        const instances = this.instances.get(pluginId);
        const pluginConfig = this.pluginsConfig?.plugins[pluginId];

        if (!instances || !pluginConfig) {
            throw new Error(`Plugin '${pluginId}' not found`);
        }

        // Stop health check
        const interval = this.healthCheckIntervals.get(pluginId);
        if (interval) {
            clearInterval(interval);
            this.healthCheckIntervals.delete(pluginId);
        }

        // Stop all instances
        for (const instance of instances) {
            await this.stopInstance(instance);
        }

        this.instances.delete(pluginId);

        // Respawn
        await this.spawnPlugin(pluginId, pluginConfig);
    }

    /**
     * Clean up stale containers from previous runs
     */
    private async cleanupStaleContainers(): Promise<void> {
        console.log('[ContainerManager] Cleaning up stale containers...');

        const staleContainers = await this.dockerClient.listPluginContainers();

        for (const container of staleContainers) {
            console.log(
                `[ContainerManager] Removing stale container ${container.Names?.[0] || container.Id}`
            );
            try {
                await this.dockerClient.removeContainer(container.Id, true);
            } catch (error) {
                console.warn(
                    `[ContainerManager] Failed to remove stale container:`,
                    error
                );
            }
        }
    }

    /**
     * Record task completion for statistics
     */
    recordTaskCompletion(pluginId: string, instanceName: string, success: boolean): void {
        const instances = this.instances.get(pluginId);
        if (!instances) return;

        const instance = instances.find((i) => i.containerName === instanceName);
        if (!instance) return;

        if (success) {
            instance.tasksProcessed++;
        } else {
            instance.tasksFailed++;
        }
    }

    /**
     * Add a new plugin dynamically
     */
    async addPlugin(
        pluginId: string,
        image: string,
        pluginConfig?: Partial<ContainerPluginConfig>
    ): Promise<void> {
        // Validate plugin ID format
        if (!/^[a-z][a-z0-9-]*$/.test(pluginId)) {
            throw new Error(
                `Invalid plugin ID '${pluginId}': must be lowercase alphanumeric with hyphens, starting with a letter`
            );
        }

        // Check if plugin already exists
        if (this.instances.has(pluginId)) {
            throw new Error(`Plugin '${pluginId}' already exists`);
        }

        console.log(`[ContainerManager] Adding new plugin '${pluginId}' with image '${image}'`);

        // Build full plugin config
        const fullConfig: ContainerPluginConfig = {
            enabled: pluginConfig?.enabled !== false,
            image,
            instances: pluginConfig?.instances ?? 1,
            resources: pluginConfig?.resources,
            config: pluginConfig?.config,
            network: pluginConfig?.network ?? false,
            mounts: pluginConfig?.mounts,
            healthCheck: pluginConfig?.healthCheck,
            defaultQueue: pluginConfig?.defaultQueue,
        };

        // Update in-memory config
        if (!this.pluginsConfig) {
            this.pluginsConfig = { version: '1.0', plugins: {} };
        }
        this.pluginsConfig.plugins[pluginId] = fullConfig;

        // Save to YAML file
        await saveConfig(this.configPath, this.pluginsConfig);

        // Spawn the plugin containers
        if (fullConfig.enabled) {
            await this.spawnPlugin(pluginId, fullConfig);
        }

        console.log(`[ContainerManager] Plugin '${pluginId}' added successfully`);
    }

    /**
     * Remove a plugin
     */
    async removePlugin(pluginId: string): Promise<void> {
        console.log(`[ContainerManager] Removing plugin '${pluginId}'...`);

        const instances = this.instances.get(pluginId);

        if (instances) {
            // Stop health check
            const interval = this.healthCheckIntervals.get(pluginId);
            if (interval) {
                clearInterval(interval);
                this.healthCheckIntervals.delete(pluginId);
            }

            // Stop all instances
            for (const instance of instances) {
                await this.stopInstance(instance);
            }

            this.instances.delete(pluginId);
        }

        // Remove from config
        if (this.pluginsConfig && this.pluginsConfig.plugins[pluginId]) {
            delete this.pluginsConfig.plugins[pluginId];

            // Save to YAML file
            await saveConfig(this.configPath, this.pluginsConfig);
        }

        // Reset round robin counter
        this.roundRobinCounters.delete(pluginId);

        console.log(`[ContainerManager] Plugin '${pluginId}' removed successfully`);
    }

    /**
     * Restart all plugins
     */
    async restartAllPlugins(): Promise<void> {
        console.log('[ContainerManager] Restarting all plugins...');

        const pluginIds = Array.from(this.instances.keys());

        for (const pluginId of pluginIds) {
            try {
                await this.restartPlugin(pluginId);
            } catch (error) {
                console.error(`[ContainerManager] Failed to restart plugin '${pluginId}':`, error);
            }
        }

        console.log('[ContainerManager] All plugins restarted');
    }

    /**
     * Update plugin image and restart
     */
    async updatePluginImage(pluginId: string, newImage: string): Promise<void> {
        console.log(`[ContainerManager] Updating plugin '${pluginId}' to image '${newImage}'...`);

        const pluginConfig = this.pluginsConfig?.plugins[pluginId];

        if (!pluginConfig) {
            throw new Error(`Plugin '${pluginId}' not found`);
        }

        // Update image in config
        pluginConfig.image = newImage;

        // Save to YAML file
        if (this.pluginsConfig) {
            await saveConfig(this.configPath, this.pluginsConfig);
        }

        // Restart the plugin to use the new image
        await this.restartPlugin(pluginId);

        console.log(`[ContainerManager] Plugin '${pluginId}' updated successfully`);
    }

    /**
     * Update plugin configuration
     */
    async updatePluginConfig(
        pluginId: string,
        updates: Partial<ContainerPluginConfig>
    ): Promise<void> {
        console.log(`[ContainerManager] Updating configuration for plugin '${pluginId}'...`);

        const pluginConfig = this.pluginsConfig?.plugins[pluginId];

        if (!pluginConfig) {
            throw new Error(`Plugin '${pluginId}' not found`);
        }

        // Apply updates
        if (updates.image !== undefined) {
            pluginConfig.image = updates.image;
        }
        if (updates.instances !== undefined) {
            pluginConfig.instances = updates.instances;
        }
        if (updates.resources !== undefined) {
            pluginConfig.resources = updates.resources;
        }
        if (updates.config !== undefined) {
            pluginConfig.config = updates.config;
        }
        if (updates.enabled !== undefined) {
            pluginConfig.enabled = updates.enabled;
        }
        if (updates.network !== undefined) {
            pluginConfig.network = updates.network;
        }
        if (updates.defaultQueue !== undefined) {
            pluginConfig.defaultQueue = updates.defaultQueue;
        }

        // Save to YAML file
        if (this.pluginsConfig) {
            await saveConfig(this.configPath, this.pluginsConfig);
        }

        // Restart the plugin to apply changes
        if (this.instances.has(pluginId)) {
            await this.restartPlugin(pluginId);
        }

        console.log(`[ContainerManager] Plugin '${pluginId}' configuration updated`);
    }

    /**
     * Get the current plugins configuration
     */
    getPluginsConfig(): ContainerPluginsConfig | null {
        return this.pluginsConfig;
    }

    /**
     * Get the discovered callback URL for plugins
     */
    getCallbackUrl(): string {
        return this.callbackUrl;
    }

    /**
     * Get the discovered meta-core URL
     */
    getMetaCoreUrl(): string {
        return this.metaCoreUrl;
    }

    /**
     * Get the discovered WebDAV URL for file access
     */
    getWebdavUrl(): string | undefined {
        return this.webdavUrl;
    }
}

/**
 * Create a container manager instance
 */
export function createContainerManager(
    configPath?: string,
    network?: string,
    webdavUrl?: string
): ContainerManager {
    return new ContainerManager(configPath, network, undefined, undefined, undefined, webdavUrl);
}
