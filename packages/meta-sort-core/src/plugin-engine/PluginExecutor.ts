/**
 * Plugin Executor
 *
 * Handles dependency resolution for the container-based plugin system.
 */

import type { PluginManifest } from './types.js';

// =============================================================================
// Dependency Resolution
// =============================================================================

/**
 * Result of dependency resolution
 */
export interface DependencyResolution {
    order: string[];
    errors: string[];
}

/**
 * Perform topological sort on plugins based on dependencies.
 * Returns execution order (plugins that must run first come first).
 *
 * @param plugins Map of plugin id to manifest
 * @param activePluginIds Set of active plugin ids to include in the order
 */
export function resolveDependencyOrder(
    plugins: Map<string, PluginManifest>,
    activePluginIds: Set<string>
): DependencyResolution {
    const errors: string[] = [];
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>(); // For cycle detection

    // Filter to only active plugins
    const activePlugins = new Map<string, PluginManifest>();
    activePluginIds.forEach(pluginId => {
        const manifest = plugins.get(pluginId);
        if (manifest) {
            activePlugins.set(pluginId, manifest);
        }
    });

    // DFS visit function
    function visit(pluginId: string): boolean {
        if (visited.has(pluginId)) {
            return true;
        }
        if (visiting.has(pluginId)) {
            errors.push(`Circular dependency detected involving plugin '${pluginId}'`);
            return false;
        }

        const manifest = activePlugins.get(pluginId);
        if (!manifest) {
            // Plugin not found or not active
            return true;
        }

        visiting.add(pluginId);

        // Visit dependencies first
        for (const depId of manifest.dependencies || []) {
            if (!activePlugins.has(depId)) {
                // Dependency is not active
                if (plugins.has(depId)) {
                    errors.push(`Plugin '${pluginId}' depends on '${depId}' which is not active`);
                } else {
                    errors.push(`Plugin '${pluginId}' depends on '${depId}' which does not exist`);
                }
                continue;
            }
            if (!visit(depId)) {
                return false;
            }
        }

        visiting.delete(pluginId);
        visited.add(pluginId);
        order.push(pluginId);

        return true;
    }

    // Visit all active plugins
    Array.from(activePluginIds).forEach(pluginId => {
        if (!visited.has(pluginId)) {
            visit(pluginId);
        }
    });

    return { order, errors };
}

/**
 * Check if a plugin can be activated (all dependencies are active)
 */
export function canActivate(
    pluginId: string,
    plugins: Map<string, PluginManifest>,
    activePluginIds: Set<string>
): { canActivate: boolean; missingDeps: string[] } {
    const manifest = plugins.get(pluginId);
    if (!manifest) {
        return { canActivate: false, missingDeps: [] };
    }

    const missingDeps: string[] = [];
    for (const depId of manifest.dependencies || []) {
        if (!activePluginIds.has(depId)) {
            missingDeps.push(depId);
        }
    }

    return {
        canActivate: missingDeps.length === 0,
        missingDeps,
    };
}

/**
 * Check if a plugin can be deactivated (no active plugins depend on it)
 */
export function canDeactivate(
    pluginId: string,
    plugins: Map<string, PluginManifest>,
    activePluginIds: Set<string>
): { canDeactivate: boolean; dependents: string[] } {
    const dependents: string[] = [];

    activePluginIds.forEach(activeId => {
        if (activeId === pluginId) return;

        const manifest = plugins.get(activeId);
        if (manifest?.dependencies?.includes(pluginId)) {
            dependents.push(activeId);
        }
    });

    return {
        canDeactivate: dependents.length === 0,
        dependents,
    };
}
