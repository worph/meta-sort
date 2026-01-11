import {FileAnalyzerInterface} from "../fileProcessor/FileAnalyzerInterface.js";
import {UnifiedProcessingStateManager} from "../UnifiedProcessingStateManager.js";
import type {IKVClient} from "../../kv/IKVClient.js";
import {VirtualFileSystem} from "../../api/VirtualFileSystem.js";
import {MetaDataToFolderStruct} from "../MetaDataToFolderStruct.js";
import type {ContainerPluginScheduler} from "../../container-plugins/ContainerPluginScheduler.js";

/**
 * Configuration for StreamingPipeline
 */
export interface PipelineConfig {
    /**
     * Supported file extensions (application-specific)
     */
    supportedExtensions: Set<string>;

    /**
     * Concurrency for validation stage (extension + optional MIME check)
     * Default: 32 (I/O bound - fast checks)
     */
    validationConcurrency: number;

    /**
     * Concurrency for fast queue stage (filename parsing, stats)
     * Default: 16 (CPU/I/O balanced)
     */
    fastQueueConcurrency: number;

    /**
     * Concurrency for background queue stage (hash computation, FFmpeg)
     * Default: 16 (CPU bound)
     */
    backgroundQueueConcurrency: number;

    /**
     * Enable strict MIME validation (reads file header)
     * Default: false (skip for performance)
     */
    strictMimeValidation: boolean;

    /**
     * File processor (handles light and heavy processing)
     */
    fileProcessor: FileAnalyzerInterface;

    /**
     * State manager (tracks processing states)
     */
    stateManager: UnifiedProcessingStateManager;

    /**
     * Optional KV client for metadata storage
     */
    kvClient?: IKVClient;

    /**
     * Virtual filesystem (for instant file visibility)
     */
    virtualFileSystem: VirtualFileSystem;

    /**
     * Metadata to folder structure converter (for virtual path generation)
     */
    metaDataToFolderStruct: MetaDataToFolderStruct;

    /**
     * Optional container plugin scheduler for dispatching tasks to containerized plugins
     */
    containerPluginScheduler?: ContainerPluginScheduler;
}

/**
 * Default pipeline configuration
 */
export const DEFAULT_PIPELINE_CONFIG: Partial<PipelineConfig> = {
    validationConcurrency: 32,
    fastQueueConcurrency: 16,
    backgroundQueueConcurrency: 16,
    strictMimeValidation: false
};
