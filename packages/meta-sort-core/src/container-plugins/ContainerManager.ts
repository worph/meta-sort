/**
 * Container Manager
 *
 * Manages the lifecycle of plugin containers including spawning,
 * health checking, configuration, and cleanup.
 */

import { EventEmitter } from 'events';
import { DockerClient } from './DockerClient.js';
import {
    loadConfig,
    getEnabledPlugins,
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
 * PLUGIN MOUNT ARCHITECTURE - HARDCODED PATHS
 * ============================================================================
 *
 * Each plugin container has exactly 3 mount points (hardcoded):
 *
 *   /files   (READ-ONLY)  - Files to process, same structure as meta-sort
 *   /output  (READ-WRITE) - Plugin-generated files
 *   /cache   (READ-WRITE) - Plugin-specific cache
 *
 * Host paths are configured via environment variables:
 *   - PLUGIN_FILE_MOUNTS: Maps subpaths under /files to host paths
 *     Format: "subpath:host_path,subpath2:host_path2"
 *     Example: "watch:/data/media,test:/app/test/media"
 *     Results in: /files/watch, /files/test mounted in container
 *
 *   - PLUGIN_CACHE_FOLDER: Base path for /cache mounts
 *   - PLUGIN_OUTPUT_FOLDER: Base path for /output mounts
 *
 * SECURITY: Plugins have read-only access to /files.
 * Only /cache and /output are writable.
 *
 * ============================================================================
 */

/**
 * File mount configuration - maps container path to host path
 */
interface FileMountConfig {
    containerPath: string;
    hostPath: string;
}

/**
 * Parse PLUGIN_FILE_MOUNTS env var into mount configs
 * Format: "container_path:host_path,container_path2:host_path2"
 */
function parseFileMounts(mountsStr?: string): FileMountConfig[] {
    if (!mountsStr) {
        return [];
    }

    const mounts: FileMountConfig[] = [];
    const pairs = mountsStr.split(',').map(s => s.trim()).filter(s => s);

    for (const pair of pairs) {
        const [containerPath, hostPath] = pair.split(':').map(s => s.trim());
        if (containerPath && hostPath) {
            mounts.push({ containerPath, hostPath });
        } else {
            console.warn(`[ContainerManager] Invalid mount format: "${pair}" - expected "container_path:host_path"`);
        }
    }

    return mounts;
}

export class ContainerManager extends EventEmitter {
    private dockerClient: DockerClient;
    private pluginsConfig: ContainerPluginsConfig | null = null;
    private instances: Map<string, ContainerPluginInstance[]> = new Map();
    private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map();
    private roundRobinCounters: Map<string, number> = new Map();
    private initialized: boolean = false;
    private shutdownInProgress: boolean = false;
    private fileMounts: FileMountConfig[] = [];
    private pluginCacheFolder?: string;
    private pluginOutputFolder?: string;
    private stackName?: string;

    constructor(
        private configPath: string = config.CONTAINER_PLUGINS_CONFIG,
        private network: string = config.CONTAINER_NETWORK,
        private filesPath: string = config.FILES_PATH,
        private callbackUrl: string = config.CONTAINER_CALLBACK_URL,
        private metaCoreUrl: string = config.CONTAINER_META_CORE_URL,
        dockerClient?: DockerClient
    ) {
        super();
        this.dockerClient = dockerClient || new DockerClient(config.DOCKER_SOCKET_PATH);

        // Parse file mounts from PLUGIN_FILE_MOUNTS env var
        this.fileMounts = parseFileMounts(config.PLUGIN_FILE_MOUNTS);

        // Configure plugin cache folder (READ-WRITE)
        this.pluginCacheFolder = config.PLUGIN_CACHE_FOLDER;

        // Configure plugin output folder (READ-WRITE for /plugin-files)
        this.pluginOutputFolder = config.PLUGIN_OUTPUT_FOLDER;

        // Configure stack name for Docker Desktop grouping
        this.stackName = config.PLUGIN_STACK_NAME;
    }

    /**
     * Initialize the container manager
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        console.log('[ContainerManager] Initializing...');

        // Log configured host mounts
        console.log('[ContainerManager] Plugin mount configuration (hardcoded paths):');
        console.log('  /files   (RO) - Files to process:');
        if (this.fileMounts.length > 0) {
            for (const mount of this.fileMounts) {
                const targetPath = mount.containerPath.startsWith('/files')
                    ? mount.containerPath
                    : `/files/${mount.containerPath}`;
                console.log(`    ${targetPath} -> ${mount.hostPath}`);
            }
        } else {
            console.warn('    (not configured) - Set PLUGIN_FILE_MOUNTS');
        }
        console.log(`  /cache  (RW) - Plugin cache:    ${this.pluginCacheFolder || '(not configured)'}`);
        console.log(`  /output (RW) - Plugin output:   ${this.pluginOutputFolder || '(not configured)'}`)

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
         * PLUGIN MOUNT ARCHITECTURE - HARDCODED PATHS:
         *   /files   (READ-ONLY)  - Files to process
         *   /output  (READ-WRITE) - Plugin-generated files
         *   /cache   (READ-WRITE) - Plugin-specific cache
         */
        const mounts: Array<{ source: string; target: string; readonly: boolean }> = [];

        // /files/* (READ-ONLY) - Mount each configured subpath under /files
        for (const fileMount of this.fileMounts) {
            // fileMount.containerPath is the subpath (e.g., "watch", "test")
            // Mount at /files/{subpath}
            const targetPath = fileMount.containerPath.startsWith('/files')
                ? fileMount.containerPath
                : `/files/${fileMount.containerPath}`;
            mounts.push({
                source: fileMount.hostPath,
                target: targetPath,
                readonly: true,
            });
        }

        if (this.fileMounts.length === 0) {
            console.warn(`[ContainerManager] WARNING: No file mounts configured. Plugin '${pluginId}' won't have access to files.`);
        }

        // /cache (READ-WRITE) - Plugin-specific cache
        if (this.pluginCacheFolder) {
            mounts.push({
                source: `${this.pluginCacheFolder}/${pluginId}`,
                target: '/cache',
                readonly: false,
            });
        }

        // /output (READ-WRITE) - Plugin-generated files
        if (this.pluginOutputFolder) {
            mounts.push({
                source: `${this.pluginOutputFolder}/${pluginId}`,
                target: '/output',
                readonly: false,
            });
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
}

/**
 * Create a container manager instance
 */
export function createContainerManager(
    configPath?: string,
    network?: string
): ContainerManager {
    return new ContainerManager(configPath, network);
}
