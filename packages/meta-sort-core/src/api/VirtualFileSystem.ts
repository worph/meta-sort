/**
 * VirtualFileSystem - In-memory representation of the virtual output filesystem
 *
 * This class maintains the virtual directory structure and provides FUSE-compatible operations.
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { HashMeta } from '@metazla/meta-interface';
import type { ExtendedHashMeta } from '../types/ExtendedInterfaces.js';
import {
  IFuseAPI,
  VirtualDirectory,
  VirtualFile,
  FileAttributes,
  ReadResult,
  FuseAPIConfig,
  FuseAPIEvents
} from './FuseAPI.js';
import { MetaMeshFormat } from '../logic/MetaMeshFormat.js';
import { MetadataFormatRegistry, IMetadataFormatHandler } from '../logic/MetadataFormatRegistry.js';
import { config } from '../config/EnvConfig.js';

interface VFSNode {
  type: 'file' | 'directory';
  name: string;
  parent: string | null;
  // For files
  sourcePath?: string | null;
  size?: number;
  mtime?: Date;
  ctime?: Date;
  metadata?: HashMeta;
  // For virtual metadata files
  formatHandler?: IMetadataFormatHandler;
  // For directories
  children?: Set<string>;
}

export class VirtualFileSystem extends EventEmitter implements IFuseAPI {
  private nodes: Map<string, VFSNode> = new Map();
  private config: Required<FuseAPIConfig>;
  private metaFormat: MetaMeshFormat = new MetaMeshFormat();
  private formatRegistry: MetadataFormatRegistry = new MetadataFormatRegistry();
  private activeFormatHandlers: IMetadataFormatHandler[] = [];

  // Cached stats - updated incrementally on each modification
  private cachedStats = {
    fileCount: 0,
    directoryCount: 0,
    totalSize: 0,
    metaFileCount: 0,
    metadataFileCount: 0
  };

  constructor(fuseConfig: FuseAPIConfig = {}) {
    super();
    this.config = {
      basePath: fuseConfig.basePath ?? '/',
      fileMode: fuseConfig.fileMode ?? 0o644,
      directoryMode: fuseConfig.directoryMode ?? 0o755,
      uid: fuseConfig.uid ?? process.getuid(),
      gid: fuseConfig.gid ?? process.getgid()
    };

    // Initialize active format handlers from configuration
    this.activeFormatHandlers = this.formatRegistry.getHandlersForFormats(config.METADATA_FORMATS);

    if (this.activeFormatHandlers.length > 0) {
      console.log(`VirtualFileSystem: Active metadata formats: ${this.activeFormatHandlers.map(h => h.formatType).join(', ')}`);
    } else {
      console.log('VirtualFileSystem: No metadata formats configured');
    }

    // Initialize root directory
    this.nodes.set('/', {
      type: 'directory',
      name: '',
      parent: null,
      children: new Set()
    });

    // Initialize cached stats with root directory
    this.cachedStats.directoryCount = 1;
  }

  /**
   * Build the virtual filesystem from a computed folder structure
   * @param computed Map of source paths to destination paths
   * @param metadata Map of source paths to HashMeta
   * @param basePath Base path to strip from destination paths (e.g., OUTPUT_FOLDER)
   */
  public buildFromComputed(
    computed: Map<string, string>,
    metadata: Map<string, HashMeta>,
    basePath?: string
  ): void {
    // Clear existing structure (except root)
    this.nodes.clear();
    this.nodes.set('/', {
      type: 'directory',
      name: '',
      parent: null,
      children: new Set()
    });

    // Reset cached stats (root directory will be counted)
    this.cachedStats = {
      fileCount: 0,
      directoryCount: 1, // Root directory
      totalSize: 0,
      metaFileCount: 0,
      metadataFileCount: 0
    };

    // Normalize basePath if provided
    const normalizedBasePath = basePath ? path.normalize(basePath) : null;

    // Add all files and their parent directories
    for (const [sourcePath, destPath] of computed.entries()) {
      // Strip basePath from destPath to create relative virtual path
      let virtualPath = destPath;
      if (normalizedBasePath && destPath.startsWith(normalizedBasePath)) {
        virtualPath = destPath.slice(normalizedBasePath.length);
        // Ensure path starts with /
        if (!virtualPath.startsWith('/')) {
          virtualPath = '/' + virtualPath;
        }
      }
      this.addFile(virtualPath, sourcePath, metadata.get(sourcePath));
    }

    this.emit('vfs-updated');
  }

  /**
   * Add a file to the virtual filesystem, creating parent directories as needed
   */
  public addFile(virtualPath: string, sourcePath: string, metadata?: HashMeta): void {
    // Normalize path
    virtualPath = this.normalizePath(virtualPath);

    // Create parent directories
    const dirname = path.dirname(virtualPath);
    this.ensureDirectory(dirname);

    // Try to use metadata for file stats (avoid disk I/O during fast load)
    let size: number;
    let mtime: Date;
    let ctime: Date;

    const extMeta = metadata as ExtendedHashMeta | undefined;
    if (extMeta && extMeta.sizeByte) {
      // Use cached metadata (fast path - no disk I/O)
      size = parseInt(String(extMeta.sizeByte), 10);
      // Use current time as placeholder for mtime/ctime (will be corrected on next scan)
      mtime = new Date();
      ctime = new Date();
    } else {
      // Fallback: stat the file (slow path - disk I/O)
      try {
        const stats = fs.statSync(sourcePath);
        size = stats.size;
        mtime = stats.mtime;
        ctime = stats.ctime;
      } catch (error) {
        console.warn(`Cannot stat source file: ${sourcePath}`, error);
        return;
      }
    }

    // Add the file node
    const filename = path.basename(virtualPath);
    this.nodes.set(virtualPath, {
      type: 'file',
      name: filename,
      parent: dirname,
      sourcePath,
      size,
      mtime,
      ctime,
      metadata
    });

    // Add to parent's children
    const parentNode = this.nodes.get(dirname);
    if (parentNode && parentNode.type === 'directory') {
      parentNode.children!.add(filename);
    }

    // Update cached stats
    this.cachedStats.fileCount++;
    this.cachedStats.totalSize += size;

    // Also add corresponding metadata files based on configured formats
    this.addMetadataFiles(virtualPath, metadata, mtime);

    this.emit('file-added', virtualPath);
  }

  /**
   * Add virtual metadata files for all configured formats
   */
  private addMetadataFiles(mediaPath: string, metadata: HashMeta | undefined, mtime: Date): void {
    if (!metadata) return;

    // Create a metadata file for each configured format
    for (const handler of this.activeFormatHandlers) {
      const metaPath = `${mediaPath}${handler.extension}`;
      const dirname = path.dirname(metaPath);
      const filename = path.basename(metaPath);

      // Pre-generate metadata content to calculate size
      const metaContent = handler.serialize(metadata);
      const metaBuffer = Buffer.from(metaContent, 'utf-8');

      // Add the virtual metadata file node
      this.nodes.set(metaPath, {
        type: 'file',
        name: filename,
        parent: dirname,
        sourcePath: null, // Virtual file, no source
        size: metaBuffer.length,
        mtime: mtime,
        ctime: mtime,
        metadata,
        formatHandler: handler
      });

      // Add to parent's children
      const parentNode = this.nodes.get(dirname);
      if (parentNode && parentNode.type === 'directory') {
        parentNode.children!.add(filename);
      }

      // Update cached stats
      this.cachedStats.fileCount++;
      this.cachedStats.totalSize += metaBuffer.length;
      this.cachedStats.metadataFileCount++;
      // Legacy: Count .meta files separately for backward compatibility
      if (handler.extension === '.meta') {
        this.cachedStats.metaFileCount++;
      }
    }
  }

  /**
   * Ensure a directory exists in the VFS, creating parent directories as needed
   */
  private ensureDirectory(dirPath: string): void {
    dirPath = this.normalizePath(dirPath);

    if (dirPath === '/' || this.nodes.has(dirPath)) {
      return;
    }

    // Recursively create parent
    const parentPath = path.dirname(dirPath);
    this.ensureDirectory(parentPath);

    // Create this directory
    const dirName = path.basename(dirPath);
    this.nodes.set(dirPath, {
      type: 'directory',
      name: dirName,
      parent: parentPath,
      children: new Set()
    });

    // Add to parent's children
    const parentNode = this.nodes.get(parentPath);
    if (parentNode && parentNode.type === 'directory') {
      parentNode.children!.add(dirName);
    }

    // Update cached stats
    this.cachedStats.directoryCount++;

    this.emit('directory-added', dirPath);
  }

  /**
   * Normalize path to use forward slashes and ensure leading slash
   */
  private normalizePath(p: string): string {
    // Convert to forward slashes
    p = p.split(path.sep).join('/');

    // Ensure leading slash
    if (!p.startsWith('/')) {
      p = '/' + p;
    }

    // Remove trailing slash (except for root)
    if (p !== '/' && p.endsWith('/')) {
      p = p.slice(0, -1);
    }

    return p;
  }

  // IFuseAPI implementation

  public readdir(dirPath: string): string[] | null {
    dirPath = this.normalizePath(dirPath);
    const node = this.nodes.get(dirPath);

    if (!node || node.type !== 'directory') {
      return null;
    }

    return Array.from(node.children!);
  }

  public getattr(filepath: string): FileAttributes | null {
    filepath = this.normalizePath(filepath);
    const node = this.nodes.get(filepath);

    if (!node) {
      return null;
    }

    if (node.type === 'directory') {
      return {
        size: 4096, // Standard directory size
        mode: 0o040000 | this.config.directoryMode, // S_IFDIR | permissions
        mtime: Date.now() / 1000,
        atime: Date.now() / 1000,
        ctime: Date.now() / 1000,
        nlink: 2, // . and ..
        uid: this.config.uid,
        gid: this.config.gid
      };
    } else {
      return {
        size: node.size!,
        mode: 0o100000 | this.config.fileMode, // S_IFREG | permissions
        mtime: node.mtime!.getTime() / 1000,
        atime: node.mtime!.getTime() / 1000,
        ctime: node.ctime!.getTime() / 1000,
        nlink: 1,
        uid: this.config.uid,
        gid: this.config.gid
      };
    }
  }

  public exists(filepath: string): boolean {
    filepath = this.normalizePath(filepath);
    return this.nodes.has(filepath);
  }

  public read(filepath: string): ReadResult | null {
    filepath = this.normalizePath(filepath);
    const node = this.nodes.get(filepath);

    if (!node || node.type !== 'file') {
      return null;
    }

    // Virtual metadata file (any format)
    if (node.sourcePath === null && node.metadata && node.formatHandler) {
      const metaContent = node.formatHandler.serialize(node.metadata);
      const metaBuffer = Buffer.from(metaContent, 'utf-8');

      return {
        sourcePath: null,
        content: metaBuffer,
        size: metaBuffer.length
      };
    }

    // Regular file - return source path for reading
    return {
      sourcePath: node.sourcePath!,
      content: null,
      size: node.size!
    };
  }

  public getMetadata(filepath: string): HashMeta | null {
    filepath = this.normalizePath(filepath);
    const node = this.nodes.get(filepath);

    if (!node || node.type !== 'file') {
      return null;
    }

    return node.metadata ?? null;
  }

  public getTree(): VirtualDirectory {
    const rootNode = this.nodes.get('/')!;

    return {
      path: '/',
      type: 'directory',
      name: '',
      parent: '',
      children: Array.from(rootNode.children!),
      mode: this.config.directoryMode,
      mtime: new Date()
    };
  }

  public async refresh(): Promise<void> {
    // Refresh is triggered by external calls after processing
    // The buildFromComputed method handles the actual refresh
    this.emit('vfs-updated');
  }

  /**
   * Get all file paths in the VFS
   */
  public getAllFiles(): string[] {
    const files: string[] = [];
    for (const [filepath, node] of this.nodes.entries()) {
      if (node.type === 'file') {
        files.push(filepath);
      }
    }
    return files;
  }

  /**
   * Get all directory paths in the VFS
   */
  public getAllDirectories(): string[] {
    const dirs: string[] = [];
    for (const [dirpath, node] of this.nodes.entries()) {
      if (node.type === 'directory') {
        dirs.push(dirpath);
      }
    }
    return dirs;
  }

  /**
   * Get statistics about the VFS (returns cached values, updated incrementally)
   */
  public getStats(): {
    fileCount: number;
    directoryCount: number;
    totalSize: number;
    metaFileCount: number;
    metadataFileCount: number;
  } {
    // Return cached stats - no iteration needed!
    return { ...this.cachedStats };
  }

  /**
   * Count files in VFS that have completed hash computation
   * A file is considered "done" if hashStatus === 'complete' (all hashes computed without errors)
   */
  public countFilesWithHash(): number {
    let count = 0;
    for (const [filepath, node] of this.nodes.entries()) {
      // Only count actual media files (not directories, not metadata files)
      if (node.type === 'file' && node.sourcePath && node.metadata) {
        // Check if file has completed processing (both light and hash phases)
        const extMeta = node.metadata as ExtendedHashMeta;
        if (extMeta.processingStatus === 'complete') {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Update metadata for an existing file in the VFS (e.g., when hash computation completes)
   * This also regenerates the metadata files with updated content
   */
  public updateFileMetadata(virtualPath: string, metadata: HashMeta): void {
    virtualPath = this.normalizePath(virtualPath);
    const node = this.nodes.get(virtualPath);

    if (!node || node.type !== 'directory') {
      // Update file metadata
      if (node) {
        node.metadata = metadata;

        // Regenerate metadata files with updated content
        if (node.mtime) {
          // Get old metadata file sizes before regenerating
          const oldSizes = new Map<string, number>();
          for (const handler of this.activeFormatHandlers) {
            const metaPath = `${virtualPath}${handler.extension}`;
            const oldMetaNode = this.nodes.get(metaPath);
            if (oldMetaNode) {
              oldSizes.set(metaPath, oldMetaNode.size ?? 0);
            }
          }

          // Regenerate metadata files (this will overwrite the nodes)
          this.addMetadataFilesUpdate(virtualPath, metadata, node.mtime, oldSizes);
        }

        this.emit('file-updated', virtualPath);
      }
    }
  }

  /**
   * Add/update virtual metadata files for all configured formats (used during updates)
   * This version adjusts cached stats based on size differences
   */
  private addMetadataFilesUpdate(
    mediaPath: string,
    metadata: HashMeta,
    mtime: Date,
    oldSizes: Map<string, number>
  ): void {
    // Create a metadata file for each configured format
    for (const handler of this.activeFormatHandlers) {
      const metaPath = `${mediaPath}${handler.extension}`;
      const dirname = path.dirname(metaPath);
      const filename = path.basename(metaPath);

      // Pre-generate metadata content to calculate size
      const metaContent = handler.serialize(metadata);
      const metaBuffer = Buffer.from(metaContent, 'utf-8');
      const newSize = metaBuffer.length;

      const oldSize = oldSizes.get(metaPath);
      const isNew = oldSize === undefined;

      // Update the virtual metadata file node
      this.nodes.set(metaPath, {
        type: 'file',
        name: filename,
        parent: dirname,
        sourcePath: null, // Virtual file, no source
        size: newSize,
        mtime: mtime,
        ctime: mtime,
        metadata,
        formatHandler: handler
      });

      // Add to parent's children (no-op if already exists)
      const parentNode = this.nodes.get(dirname);
      if (parentNode && parentNode.type === 'directory') {
        parentNode.children!.add(filename);
      }

      // Update cached stats
      if (isNew) {
        // New metadata file
        this.cachedStats.fileCount++;
        this.cachedStats.totalSize += newSize;
        this.cachedStats.metadataFileCount++;
        if (handler.extension === '.meta') {
          this.cachedStats.metaFileCount++;
        }
      } else {
        // Update existing - adjust size difference
        this.cachedStats.totalSize += (newSize - oldSize);
      }
    }
  }

  /**
   * Remove a file and its associated metadata files from the VFS
   */
  public removeFile(virtualPath: string): void {
    virtualPath = this.normalizePath(virtualPath);
    const node = this.nodes.get(virtualPath);

    if (!node || node.type !== 'file') {
      return;
    }

    // Update cached stats for main file
    this.cachedStats.fileCount--;
    this.cachedStats.totalSize -= node.size ?? 0;

    // Remove the main file
    this.nodes.delete(virtualPath);

    // Remove from parent's children
    const parentNode = this.nodes.get(node.parent!);
    if (parentNode && parentNode.type === 'directory') {
      parentNode.children!.delete(node.name);
    }

    // Remove associated metadata files (.nfo, .meta, etc.)
    for (const handler of this.activeFormatHandlers) {
      const metaPath = `${virtualPath}${handler.extension}`;
      const metaNode = this.nodes.get(metaPath);

      if (metaNode) {
        // Update cached stats for metadata file
        this.cachedStats.fileCount--;
        this.cachedStats.totalSize -= metaNode.size ?? 0;
        this.cachedStats.metadataFileCount--;
        if (handler.extension === '.meta') {
          this.cachedStats.metaFileCount--;
        }

        this.nodes.delete(metaPath);

        // Remove from parent's children
        const metaParent = this.nodes.get(metaNode.parent!);
        if (metaParent && metaParent.type === 'directory') {
          metaParent.children!.delete(metaNode.name);
        }
      }
    }

    this.emit('file-removed', virtualPath);
  }

  /**
   * Check if a file exists in the VFS and return its metadata
   */
  public getFileMetadata(virtualPath: string): HashMeta | undefined {
    virtualPath = this.normalizePath(virtualPath);
    const node = this.nodes.get(virtualPath);
    return node?.metadata;
  }
}

// Type-safe event emitter
export interface VirtualFileSystem {
  on<K extends keyof FuseAPIEvents>(event: K, listener: FuseAPIEvents[K]): this;
  emit<K extends keyof FuseAPIEvents>(event: K, ...args: Parameters<FuseAPIEvents[K]>): boolean;
}
