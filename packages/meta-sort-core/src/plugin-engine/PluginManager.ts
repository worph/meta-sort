/**
 * Plugin Manager
 *
 * Main orchestrator for the container-based plugin system.
 * Handles plugin manifests, lifecycle management, and state persistence.
 * All plugins run as Docker containers - there is no local plugin execution.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { EventEmitter } from 'events';
import type {
    PluginManifest,
    PluginState,
    PluginStateEntry,
    PluginInfo,
    LoadedPlugin,
    PluginManagerEvent,
    PluginKVStore,
} from './types.js';
import { KVStore } from './PluginContext.js';
import {
    resolveDependencyOrder,
    canActivate,
    canDeactivate,
} from './PluginExecutor.js';
import type { ContainerManager, ContainerPluginManifest } from '../container-plugins/index.js';

// =============================================================================
// Plugin Manager
// =============================================================================

export interface PluginManagerOptions {
    /** Path to plugins.json state file */
    statePath: string;
    /** Base directory for plugin caches */
    cacheDir: string;
    /** Container manager for containerized plugins (required) */
    containerManager?: ContainerManager;
}

export class PluginManager extends EventEmitter {
    private statePath: string;
    private cacheDir: string;

    // Runtime state
    private manifests: Map<string, PluginManifest> = new Map();
    private loadedPlugins: Map<string, LoadedPlugin> = new Map();
    private activePluginIds: Set<string> = new Set();
    private configs: Map<string, Record<string, unknown>> = new Map();
    private executionOrder: string[] = [];

    // Container plugins (all plugins are container-based)
    private containerManager: ContainerManager | null = null;

    constructor(options: PluginManagerOptions) {
        super();
        this.statePath = options.statePath;
        this.cacheDir = options.cacheDir;
        this.containerManager = options.containerManager || null;

        // Ensure cache directory exists
        if (!existsSync(this.cacheDir)) {
            mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    /**
     * Initialize the plugin manager with container plugins.
     * This loads plugin manifests from the ContainerManager and sets up the execution order.
     */
    async initialize(): Promise<void> {
        if (!this.containerManager) {
            console.warn('[PluginManager] No container manager set, no plugins will be available');
            return;
        }

        await this.loadContainerPlugins();
        console.log(`[PluginManager] Initialized with ${this.manifests.size} container plugins`);
    }

    // =========================================================================
    // Lifecycle Management
    // =========================================================================

    /**
     * Activate a plugin
     */
    async activate(pluginId: string): Promise<void> {
        const manifest = this.manifests.get(pluginId);
        if (!manifest) {
            throw new Error(`Plugin '${pluginId}' not found`);
        }
        if (this.activePluginIds.has(pluginId)) {
            return; // Already active
        }

        // Check dependencies
        const { canActivate: can, missingDeps } = canActivate(
            pluginId,
            this.manifests,
            this.activePluginIds
        );
        if (!can) {
            throw new Error(
                `Cannot activate '${pluginId}': missing dependencies: ${missingDeps.join(', ')}`
            );
        }

        // Mark as active
        this.activePluginIds.add(pluginId);
        this.rebuildExecutionOrder();

        // Save state
        await this.saveState();

        // Emit event
        this.emit('plugin:activated', { pluginId });
    }

    /**
     * Deactivate a plugin
     */
    async deactivate(pluginId: string): Promise<void> {
        if (!this.activePluginIds.has(pluginId)) {
            return; // Already inactive
        }

        // Check if other plugins depend on this one
        const { canDeactivate: can, dependents } = canDeactivate(
            pluginId,
            this.manifests,
            this.activePluginIds
        );
        if (!can) {
            throw new Error(
                `Cannot deactivate '${pluginId}': other plugins depend on it: ${dependents.join(', ')}`
            );
        }

        // Mark as inactive
        this.activePluginIds.delete(pluginId);
        this.rebuildExecutionOrder();

        // Save state
        await this.saveState();

        // Emit event
        this.emit('plugin:deactivated', { pluginId });
    }

    /**
     * Update plugin configuration
     */
    async updateConfig(pluginId: string, config: Record<string, unknown>): Promise<void> {
        const manifest = this.manifests.get(pluginId);
        if (!manifest) {
            throw new Error(`Plugin '${pluginId}' not found`);
        }

        // Store the config
        this.configs.set(pluginId, config);

        // Save state
        await this.saveState();

        // Send config to running container plugin
        if (this.containerManager) {
            const instance = this.containerManager.getHealthyInstance(pluginId);
            if (instance) {
                try {
                    await this.containerManager.sendConfig(instance, config);
                    console.log(`[PluginManager] Sent config update to container plugin '${pluginId}'`);
                } catch (error) {
                    console.warn(`[PluginManager] Failed to send config to plugin '${pluginId}':`, error);
                }
            }
        }

        // Emit event
        this.emit('plugin:config-changed', { pluginId, config });
    }

    // =========================================================================
    // Container Plugin Support
    // =========================================================================

    /**
     * Set the container manager (can be set after construction)
     */
    setContainerManager(containerManager: ContainerManager): void {
        this.containerManager = containerManager;
        console.log('[PluginManager] Container manager set');
    }

    /**
     * Check if a plugin is a containerized plugin (all plugins are container-based)
     */
    isContainerPlugin(pluginId: string): boolean {
        return this.manifests.has(pluginId);
    }

    /**
     * Load plugin manifests from ContainerManager
     * Should be called after container plugins are initialized
     */
    async loadContainerPlugins(): Promise<void> {
        if (!this.containerManager) {
            return;
        }

        const status = this.containerManager.getStatus();
        if (!status.initialized) {
            console.warn('[PluginManager] Container manager not initialized, skipping plugins');
            return;
        }

        // Load state for plugin active status
        const state = await this.loadState();

        // Track plugins that need config sent
        const pluginsWithPersistedConfig: Array<{ pluginId: string; config: Record<string, unknown> }> = [];

        for (const pluginStatus of status.plugins) {
            const manifest = this.containerManager.getPluginManifest(pluginStatus.pluginId);
            if (!manifest) continue;

            const pluginId = pluginStatus.pluginId;

            // Convert container manifest to local manifest format
            const localManifest: PluginManifest = {
                id: manifest.id,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description || '',
                author: manifest.author,
                dependencies: manifest.dependencies || [],
                schema: manifest.schema || {},
                config: manifest.config,
                priority: manifest.priority || 100,
                color: manifest.color,
                defaultQueue: manifest.defaultQueue || 'background',
            };

            this.manifests.set(pluginId, localManifest);

            // Container plugins are always "loaded" but execution is remote
            this.loadedPlugins.set(pluginId, {
                manifest: localManifest,
                instance: null as any, // No local instance for container plugins
                status: 'loaded',
                pluginDir: '', // No local dir
            });

            // Check if should be active
            const stateEntry = state.plugins[pluginId];
            if (stateEntry?.active !== false) {
                // Default to active for plugins
                this.activePluginIds.add(pluginId);
            }

            // Store config from persisted state
            const persistedConfig = stateEntry?.config || {};
            this.configs.set(pluginId, persistedConfig);

            // If there's persisted config, queue it for sending to the container
            if (Object.keys(persistedConfig).length > 0) {
                pluginsWithPersistedConfig.push({ pluginId, config: persistedConfig });
            }

            console.log(`[PluginManager] Loaded plugin: ${pluginId}`);
        }

        // Rebuild execution order
        this.rebuildExecutionOrder();
        await this.saveState();

        // Send persisted configs to running containers
        // This ensures configs saved via API are applied after container restart
        for (const { pluginId, config } of pluginsWithPersistedConfig) {
            const instance = this.containerManager.getHealthyInstance(pluginId);
            if (instance) {
                try {
                    await this.containerManager.sendConfig(instance, config);
                    console.log(`[PluginManager] Sent persisted config to plugin '${pluginId}'`);
                } catch (error) {
                    console.warn(`[PluginManager] Failed to send persisted config to plugin '${pluginId}':`, error);
                }
            }
        }
    }

    /**
     * Get the container manager instance
     */
    getContainerManager(): ContainerManager | null {
        return this.containerManager;
    }

    // =========================================================================
    // State Management
    // =========================================================================

    /**
     * Get all discovered plugins
     */
    getPlugins(): PluginInfo[] {
        const plugins: PluginInfo[] = [];

        this.manifests.forEach((manifest, pluginId) => {
            const loaded = this.loadedPlugins.get(pluginId);
            const config = this.configs.get(pluginId) || {};

            plugins.push({
                id: pluginId,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
                priority: manifest.priority,
                color: manifest.color,
                dependencies: manifest.dependencies || [],
                active: this.activePluginIds.has(pluginId),
                config,
                configSchema: manifest.config,
                metadataSchema: manifest.schema,
                status: loaded?.status || 'unloaded',
                error: loaded?.error,
                isContainer: true, // All plugins are container-based
            });
        });

        return plugins;
    }

    /**
     * Get only active plugins
     */
    getActivePlugins(): PluginInfo[] {
        return this.getPlugins().filter(p => p.active);
    }

    /**
     * Get execution order (dependency-sorted active plugin IDs)
     */
    getExecutionOrder(): string[] {
        return [...this.executionOrder];
    }

    /**
     * Create a new KV store for file processing
     */
    createKVStore(initialData?: Record<string, string>): KVStore {
        return new KVStore(initialData);
    }

    // =========================================================================
    // Shutdown
    // =========================================================================

    /**
     * Shutdown: clear plugin state
     */
    async shutdown(): Promise<void> {
        this.manifests.clear();
        this.loadedPlugins.clear();
        this.activePluginIds.clear();
        this.executionOrder = [];
        console.log('[PluginManager] Shutdown complete');
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    private rebuildExecutionOrder(): void {
        const { order, errors } = resolveDependencyOrder(
            this.manifests,
            this.activePluginIds
        );

        if (errors.length > 0) {
            for (const error of errors) {
                console.warn(`Dependency resolution warning: ${error}`);
            }
        }

        this.executionOrder = order;
    }

    private async loadState(): Promise<PluginState> {
        try {
            if (existsSync(this.statePath)) {
                const content = await fs.readFile(this.statePath, 'utf8');
                return JSON.parse(content) as PluginState;
            }
        } catch (error) {
            console.error('Failed to load plugin state:', error);
        }
        return { plugins: {} };
    }

    private async saveState(): Promise<void> {
        const state: PluginState = { plugins: {} };

        this.manifests.forEach((_, pluginId) => {
            state.plugins[pluginId] = {
                active: this.activePluginIds.has(pluginId),
                config: this.configs.get(pluginId) || {},
            };
        });

        const dir = path.dirname(this.statePath);
        if (!existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true });
        }

        await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8');
    }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a plugin manager with default paths based on config
 */
export function createPluginManager(
    statePath: string,
    cacheDir: string
): PluginManager {
    return new PluginManager({
        statePath,
        cacheDir,
    });
}
