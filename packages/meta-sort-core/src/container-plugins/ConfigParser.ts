/**
 * Container Plugin Configuration Parser
 *
 * Parses plugins.yml configuration files for container plugins.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import YAML from 'yaml';
import type {
    ContainerPluginsConfig,
    ContainerPluginConfig,
    ContainerResourceLimits,
    ContainerMount,
    ContainerHealthCheck,
} from './types.js';
import type { TaskQueueType } from '../plugin-engine/types.js';

/**
 * Parse error with context
 */
export class ConfigParseError extends Error {
    constructor(
        message: string,
        public readonly filePath: string,
        public readonly cause?: Error
    ) {
        super(`${message} (file: ${filePath})`);
        this.name = 'ConfigParseError';
    }
}

/**
 * Default configuration values
 */
const DEFAULTS = {
    version: '1.0',
    instances: 1,
    enabled: true,
    network: false,
    healthCheck: {
        interval: '30s',
        timeout: '5s',
        retries: 3,
    },
} as const;

/**
 * Substitute environment variables in a string
 * Supports: ${VAR}, ${VAR:-default}, ${VAR:=default}
 */
function substituteEnvVars(value: string): string {
    // Match ${VAR}, ${VAR:-default}, or ${VAR:=default}
    const envPattern = /\$\{([A-Z_][A-Z0-9_]*)(?:(:?[-=])([^}]*))?\}/gi;

    return value.replace(envPattern, (match, varName, operator, defaultValue) => {
        const envValue = process.env[varName];

        if (envValue !== undefined && envValue !== '') {
            return envValue;
        }

        // Handle default values
        if (operator === ':-' || operator === ':=') {
            return defaultValue || '';
        }
        if (operator === '-' || operator === '=') {
            // Only use default if variable is unset (not if empty)
            if (envValue === undefined) {
                return defaultValue || '';
            }
            return '';
        }

        // No default, return empty string
        return '';
    });
}

/**
 * Recursively substitute env vars in an object
 */
function substituteEnvVarsInObject(obj: unknown): unknown {
    if (typeof obj === 'string') {
        return substituteEnvVars(obj);
    }

    if (Array.isArray(obj)) {
        return obj.map(item => substituteEnvVarsInObject(item));
    }

    if (obj !== null && typeof obj === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = substituteEnvVarsInObject(value);
        }
        return result;
    }

    return obj;
}

/**
 * Validate resource limits
 */
function validateResourceLimits(
    resources: unknown,
    pluginId: string
): ContainerResourceLimits | undefined {
    if (!resources || typeof resources !== 'object') {
        return undefined;
    }

    const r = resources as Record<string, unknown>;
    const result: ContainerResourceLimits = {};

    if (r.memory !== undefined) {
        if (typeof r.memory !== 'string') {
            throw new Error(`Plugin '${pluginId}': resources.memory must be a string (e.g., '512m', '2g')`);
        }
        // Validate format
        if (!/^\d+[kmgKMG]?$/.test(r.memory)) {
            throw new Error(`Plugin '${pluginId}': invalid memory format '${r.memory}' (use e.g., '512m', '2g')`);
        }
        result.memory = r.memory;
    }

    if (r.cpus !== undefined) {
        const cpus = Number(r.cpus);
        if (isNaN(cpus) || cpus <= 0) {
            throw new Error(`Plugin '${pluginId}': resources.cpus must be a positive number`);
        }
        result.cpus = cpus;
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Validate volume mounts
 */
function validateMounts(mounts: unknown, pluginId: string): ContainerMount[] | undefined {
    if (!mounts) {
        return undefined;
    }

    if (!Array.isArray(mounts)) {
        throw new Error(`Plugin '${pluginId}': mounts must be an array`);
    }

    return mounts.map((mount, index) => {
        if (!mount || typeof mount !== 'object') {
            throw new Error(`Plugin '${pluginId}': mount[${index}] must be an object`);
        }

        const m = mount as Record<string, unknown>;

        if (typeof m.source !== 'string' || !m.source) {
            throw new Error(`Plugin '${pluginId}': mount[${index}].source is required`);
        }

        if (typeof m.target !== 'string' || !m.target) {
            throw new Error(`Plugin '${pluginId}': mount[${index}].target is required`);
        }

        return {
            source: m.source,
            target: m.target,
            readonly: m.readonly !== false, // Default to true
        };
    });
}

/**
 * Validate health check config
 */
function validateHealthCheck(
    healthCheck: unknown,
    pluginId: string
): ContainerHealthCheck | undefined {
    if (!healthCheck || typeof healthCheck !== 'object') {
        return undefined;
    }

    const h = healthCheck as Record<string, unknown>;
    const result: ContainerHealthCheck = {};

    if (h.interval !== undefined) {
        if (typeof h.interval !== 'string') {
            throw new Error(`Plugin '${pluginId}': healthCheck.interval must be a string (e.g., '30s')`);
        }
        result.interval = h.interval;
    }

    if (h.timeout !== undefined) {
        if (typeof h.timeout !== 'string') {
            throw new Error(`Plugin '${pluginId}': healthCheck.timeout must be a string (e.g., '5s')`);
        }
        result.timeout = h.timeout;
    }

    if (h.retries !== undefined) {
        const retries = Number(h.retries);
        if (isNaN(retries) || retries < 0 || !Number.isInteger(retries)) {
            throw new Error(`Plugin '${pluginId}': healthCheck.retries must be a non-negative integer`);
        }
        result.retries = retries;
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Validate a single plugin configuration
 */
function validatePluginConfig(
    pluginId: string,
    config: unknown
): ContainerPluginConfig {
    if (!config || typeof config !== 'object') {
        throw new Error(`Plugin '${pluginId}': configuration must be an object`);
    }

    const c = config as Record<string, unknown>;

    // Required: image
    if (typeof c.image !== 'string' || !c.image) {
        throw new Error(`Plugin '${pluginId}': 'image' is required and must be a non-empty string`);
    }

    // Optional: enabled (default: true)
    const enabled = c.enabled !== false;

    // Optional: instances (default: 1)
    let instances: number = DEFAULTS.instances;
    if (c.instances !== undefined) {
        instances = Number(c.instances);
        if (isNaN(instances) || instances < 1 || !Number.isInteger(instances)) {
            throw new Error(`Plugin '${pluginId}': 'instances' must be a positive integer`);
        }
    }

    // Optional: defaultQueue
    let defaultQueue: TaskQueueType | undefined;
    if (c.defaultQueue !== undefined) {
        if (c.defaultQueue !== 'fast' && c.defaultQueue !== 'background') {
            throw new Error(`Plugin '${pluginId}': 'defaultQueue' must be 'fast' or 'background'`);
        }
        defaultQueue = c.defaultQueue;
    }

    // Optional: network (default: false)
    const network = c.network === true;

    return {
        enabled,
        image: c.image,
        instances,
        resources: validateResourceLimits(c.resources, pluginId),
        config: c.config && typeof c.config === 'object'
            ? c.config as Record<string, unknown>
            : undefined,
        network,
        mounts: validateMounts(c.mounts, pluginId),
        healthCheck: validateHealthCheck(c.healthCheck, pluginId),
        defaultQueue,
    };
}

/**
 * Parse and validate container plugins configuration
 */
export function parseConfig(rawConfig: unknown, filePath: string): ContainerPluginsConfig {
    if (!rawConfig || typeof rawConfig !== 'object') {
        throw new ConfigParseError('Configuration must be an object', filePath);
    }

    const config = rawConfig as Record<string, unknown>;

    // Optional: version
    const version = typeof config.version === 'string'
        ? config.version
        : DEFAULTS.version;

    // Required: plugins
    if (!config.plugins || typeof config.plugins !== 'object') {
        throw new ConfigParseError("'plugins' section is required and must be an object", filePath);
    }

    const plugins: Record<string, ContainerPluginConfig> = {};

    for (const [pluginId, pluginConfig] of Object.entries(config.plugins)) {
        // Validate plugin ID format
        if (!/^[a-z][a-z0-9-]*$/.test(pluginId)) {
            throw new ConfigParseError(
                `Invalid plugin ID '${pluginId}': must be lowercase alphanumeric with hyphens, starting with a letter`,
                filePath
            );
        }

        try {
            plugins[pluginId] = validatePluginConfig(pluginId, pluginConfig);
        } catch (error) {
            throw new ConfigParseError(
                error instanceof Error ? error.message : String(error),
                filePath
            );
        }
    }

    return { version, plugins };
}

/**
 * Load and parse plugins.yml configuration file
 */
export async function loadConfig(configPath: string): Promise<ContainerPluginsConfig> {
    // Check if file exists
    try {
        await fs.access(configPath, fs.constants.R_OK);
    } catch {
        throw new ConfigParseError(`Configuration file not found or not readable`, configPath);
    }

    // Read file
    let content: string;
    try {
        content = await fs.readFile(configPath, 'utf-8');
    } catch (error) {
        throw new ConfigParseError(
            'Failed to read configuration file',
            configPath,
            error instanceof Error ? error : undefined
        );
    }

    // Parse YAML
    let rawConfig: unknown;
    try {
        rawConfig = YAML.parse(content);
    } catch (error) {
        throw new ConfigParseError(
            'Invalid YAML syntax',
            configPath,
            error instanceof Error ? error : undefined
        );
    }

    // Substitute environment variables
    const substituted = substituteEnvVarsInObject(rawConfig);

    // Validate and return
    return parseConfig(substituted, configPath);
}

/**
 * Get enabled plugins from config
 */
export function getEnabledPlugins(
    config: ContainerPluginsConfig
): Array<{ id: string; config: ContainerPluginConfig }> {
    return Object.entries(config.plugins)
        .filter(([, pluginConfig]) => (pluginConfig as ContainerPluginConfig).enabled !== false)
        .map(([id, pluginConfig]) => ({ id, config: pluginConfig as ContainerPluginConfig }));
}

/**
 * Get default config path
 */
export function getDefaultConfigPath(): string {
    return process.env.CONTAINER_PLUGINS_CONFIG || '/app/plugins.yml';
}

/**
 * Convert ContainerPluginConfig back to YAML-friendly format
 */
function configToYamlObject(config: ContainerPluginConfig): Record<string, unknown> {
    const obj: Record<string, unknown> = {
        enabled: config.enabled,
        image: config.image,
        instances: config.instances,
    };

    if (config.resources) {
        obj.resources = config.resources;
    }

    if (config.config && Object.keys(config.config).length > 0) {
        obj.config = config.config;
    }

    if (config.network) {
        obj.network = config.network;
    }

    if (config.mounts && config.mounts.length > 0) {
        obj.mounts = config.mounts;
    }

    if (config.healthCheck) {
        obj.healthCheck = config.healthCheck;
    }

    if (config.defaultQueue) {
        obj.defaultQueue = config.defaultQueue;
    }

    return obj;
}

/**
 * Save container plugins configuration to YAML file
 */
export async function saveConfig(
    configPath: string,
    config: ContainerPluginsConfig
): Promise<void> {
    // Convert config to YAML-friendly format
    const yamlConfig: Record<string, unknown> = {
        version: config.version || '1.0',
        plugins: {} as Record<string, unknown>,
    };

    for (const [pluginId, pluginConfig] of Object.entries(config.plugins)) {
        (yamlConfig.plugins as Record<string, unknown>)[pluginId] = configToYamlObject(pluginConfig);
    }

    // Stringify to YAML
    const yamlContent = YAML.stringify(yamlConfig, {
        indent: 2,
        lineWidth: 0, // Disable line wrapping
    });

    // Write to file
    try {
        await fs.writeFile(configPath, yamlContent, 'utf-8');
    } catch (error) {
        throw new ConfigParseError(
            'Failed to write configuration file',
            configPath,
            error instanceof Error ? error : undefined
        );
    }
}
