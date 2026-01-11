/**
 * Docker Client
 *
 * Wrapper around the Docker Engine API for container management.
 * Requires: npm install dockerode @types/dockerode
 */

import Docker from 'dockerode';
import type { Container, ContainerInfo, ContainerCreateOptions } from 'dockerode';
import type { Readable } from 'stream';
import type { ContainerSpawnOptions, ContainerResourceLimits } from './types.js';

/**
 * Docker client for container operations
 */
export class DockerClient {
    private docker: Docker;
    private initialized: boolean = false;

    constructor(socketPath: string = '/var/run/docker.sock') {
        this.docker = new Docker({ socketPath });
    }

    /**
     * Initialize and verify Docker connection
     */
    async initialize(): Promise<void> {
        try {
            await this.docker.ping();
            this.initialized = true;
        } catch (error) {
            throw new Error(`Failed to connect to Docker: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Check if Docker is connected
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Get Docker info
     */
    async getInfo(): Promise<any> {
        return this.docker.info();
    }

    /**
     * Pull a Docker image
     */
    async pullImage(imageName: string, onProgress?: (event: any) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            this.docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
                if (err) {
                    reject(err);
                    return;
                }

                this.docker.modem.followProgress(
                    stream,
                    (err: Error | null) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    },
                    onProgress
                );
            });
        });
    }

    /**
     * Check if an image exists locally
     */
    async imageExists(imageName: string): Promise<boolean> {
        try {
            await this.docker.getImage(imageName).inspect();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create a container
     */
    async createContainer(options: ContainerSpawnOptions): Promise<string> {
        // Build labels, adding Docker Compose labels if stackName is provided
        const labels: Record<string, string> = {
            'meta-mesh.plugin': 'true',
            ...options.labels,
        };

        // Add compose labels for Docker Desktop grouping
        if (options.stackName) {
            labels['com.docker.compose.project'] = options.stackName;
            if (options.serviceName) {
                labels['com.docker.compose.service'] = options.serviceName;
            }
        }

        const createOptions: ContainerCreateOptions = {
            Image: options.image,
            name: options.name,
            Env: options.env
                ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
                : undefined,
            Labels: labels,
            HostConfig: {
                Binds: options.mounts?.map(m =>
                    `${m.source}:${m.target}:${m.readonly ? 'ro' : 'rw'}`
                ),
                NetworkMode: options.network,
                Memory: options.resources?.memory
                    ? parseMemoryLimit(options.resources.memory)
                    : undefined,
                NanoCpus: options.resources?.cpus
                    ? Math.floor(options.resources.cpus * 1e9)
                    : undefined,
                RestartPolicy: {
                    Name: 'unless-stopped',
                },
            },
            ExposedPorts: {
                '8080/tcp': {},
            },
        };

        const container = await this.docker.createContainer(createOptions);
        return container.id;
    }

    /**
     * Start a container
     */
    async startContainer(containerId: string): Promise<void> {
        const container = this.docker.getContainer(containerId);
        await container.start();
    }

    /**
     * Stop a container
     */
    async stopContainer(containerId: string, timeout: number = 10): Promise<void> {
        const container = this.docker.getContainer(containerId);
        await container.stop({ t: timeout });
    }

    /**
     * Remove a container
     */
    async removeContainer(containerId: string, force: boolean = false): Promise<void> {
        const container = this.docker.getContainer(containerId);
        await container.remove({ force });
    }

    /**
     * Get container info
     */
    async inspectContainer(containerId: string): Promise<Docker.ContainerInspectInfo> {
        const container = this.docker.getContainer(containerId);
        return container.inspect();
    }

    /**
     * Check if a container exists
     */
    async containerExists(containerId: string): Promise<boolean> {
        try {
            await this.inspectContainer(containerId);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if a container is running
     */
    async isContainerRunning(containerId: string): Promise<boolean> {
        try {
            const info = await this.inspectContainer(containerId);
            return info.State?.Running === true;
        } catch {
            return false;
        }
    }

    /**
     * Get container IP address on a specific network
     */
    async getContainerIP(containerId: string, network: string): Promise<string | null> {
        try {
            const info = await this.inspectContainer(containerId);
            const networkSettings = info.NetworkSettings?.Networks?.[network];
            return networkSettings?.IPAddress || null;
        } catch {
            return null;
        }
    }

    /**
     * List containers with optional filters
     */
    async listContainers(filters?: {
        label?: string[];
        name?: string[];
        status?: string[];
    }): Promise<ContainerInfo[]> {
        const dockerFilters: Record<string, string[]> = {};

        if (filters?.label) {
            dockerFilters.label = filters.label;
        }
        if (filters?.name) {
            dockerFilters.name = filters.name;
        }
        if (filters?.status) {
            dockerFilters.status = filters.status;
        }

        return this.docker.listContainers({
            all: true,
            filters: Object.keys(dockerFilters).length > 0 ? dockerFilters : undefined,
        });
    }

    /**
     * List plugin containers (created by meta-sort)
     */
    async listPluginContainers(): Promise<ContainerInfo[]> {
        return this.listContainers({
            label: ['meta-mesh.plugin=true'],
        });
    }

    /**
     * Get container logs
     */
    async getContainerLogs(
        containerId: string,
        options?: {
            tail?: number;
            since?: number;
            stdout?: boolean;
            stderr?: boolean;
        }
    ): Promise<string> {
        const container = this.docker.getContainer(containerId);
        const logs = await container.logs({
            stdout: options?.stdout ?? true,
            stderr: options?.stderr ?? true,
            tail: options?.tail ?? 100,
            since: options?.since,
        });

        // Convert buffer to string
        if (Buffer.isBuffer(logs)) {
            return logs.toString('utf-8');
        }
        return logs as unknown as string;
    }

    /**
     * Stream container logs
     */
    async streamContainerLogs(
        containerId: string,
        onLog: (log: string) => void,
        options?: {
            stdout?: boolean;
            stderr?: boolean;
        }
    ): Promise<() => void> {
        const container = this.docker.getContainer(containerId);
        const stream = await container.logs({
            stdout: options?.stdout ?? true,
            stderr: options?.stderr ?? true,
            follow: true,
            tail: 0,
        });

        const readable = stream as Readable;
        readable.on('data', (chunk: Buffer) => {
            onLog(chunk.toString('utf-8'));
        });

        return () => {
            readable.destroy();
        };
    }

    /**
     * Check if a network exists
     */
    async networkExists(networkName: string): Promise<boolean> {
        try {
            const networks = await this.docker.listNetworks({
                filters: { name: [networkName] },
            });
            return networks.some(n => n.Name === networkName);
        } catch {
            return false;
        }
    }

    /**
     * Create a network if it doesn't exist
     */
    async ensureNetwork(networkName: string): Promise<void> {
        if (await this.networkExists(networkName)) {
            return;
        }

        await this.docker.createNetwork({
            Name: networkName,
            Driver: 'bridge',
            Labels: {
                'meta-mesh': 'true',
            },
        });
    }

    /**
     * Connect container to network
     */
    async connectToNetwork(containerId: string, networkName: string): Promise<void> {
        const network = this.docker.getNetwork(networkName);
        await network.connect({ Container: containerId });
    }

    /**
     * Disconnect container from network
     */
    async disconnectFromNetwork(containerId: string, networkName: string): Promise<void> {
        const network = this.docker.getNetwork(networkName);
        await network.disconnect({ Container: containerId });
    }

    /**
     * Execute a command in a container
     */
    async exec(
        containerId: string,
        cmd: string[],
        options?: { workingDir?: string }
    ): Promise<{ exitCode: number; output: string }> {
        const container = this.docker.getContainer(containerId);

        const exec = await container.exec({
            Cmd: cmd,
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: options?.workingDir,
        });

        const stream = await exec.start({ Detach: false });

        return new Promise((resolve, reject) => {
            let output = '';

            stream.on('data', (chunk: Buffer) => {
                output += chunk.toString('utf-8');
            });

            stream.on('end', async () => {
                try {
                    const info = await exec.inspect();
                    resolve({
                        exitCode: info.ExitCode ?? -1,
                        output,
                    });
                } catch (err) {
                    reject(err);
                }
            });

            stream.on('error', reject);
        });
    }
}

/**
 * Parse memory limit string to bytes
 * Supports: '512m', '1g', '1024k'
 */
function parseMemoryLimit(limit: string): number {
    const match = limit.toLowerCase().match(/^(\d+)([kmg]?)$/);
    if (!match) {
        throw new Error(`Invalid memory limit format: ${limit}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || '';

    switch (unit) {
        case 'k':
            return value * 1024;
        case 'm':
            return value * 1024 * 1024;
        case 'g':
            return value * 1024 * 1024 * 1024;
        default:
            return value;
    }
}

/**
 * Create a new Docker client instance
 */
export function createDockerClient(socketPath?: string): DockerClient {
    return new DockerClient(socketPath);
}
