/**
 * Container Plugins Module
 *
 * Provides support for running plugins as Docker containers.
 */

// Types
export * from './types.js';

// Configuration
export {
    loadConfig,
    parseConfig,
    getEnabledPlugins,
    getDefaultConfigPath,
    ConfigParseError,
} from './ConfigParser.js';

// Docker Client
export { DockerClient, createDockerClient } from './DockerClient.js';

// Container Manager
export {
    ContainerManager,
    createContainerManager,
    type ContainerManagerEvents,
} from './ContainerManager.js';

// Container Plugin Scheduler
export {
    ContainerPluginScheduler,
    createContainerPluginScheduler,
    type ContainerSchedulerEvents,
} from './ContainerPluginScheduler.js';
