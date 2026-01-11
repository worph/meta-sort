/**
 * FUSE API for meta-mesh
 *
 * This API provides a virtual filesystem interface that can be consumed by a FUSE driver.
 * It exposes the computed folder structure without creating actual hardlinks.
 */

import { HashMeta } from '@metazla/meta-interface';
import { Stats } from 'fs';

/**
 * Represents a file or directory in the virtual filesystem
 */
export interface VirtualNode {
  /** Virtual path in the output filesystem */
  path: string;
  /** Node type */
  type: 'file' | 'directory';
  /** File name */
  name: string;
  /** Parent directory path */
  parent: string;
}

/**
 * Represents a regular file in the virtual filesystem
 */
export interface VirtualFile extends VirtualNode {
  type: 'file';
  /** Source file path on the real filesystem (null for virtual files like .meta) */
  sourcePath: string | null;
  /** File size in bytes */
  size: number;
  /** Last modified time */
  mtime: Date;
  /** Creation time */
  ctime: Date;
  /** File permissions (octal) */
  mode: number;
  /** Associated metadata */
  metadata?: HashMeta;
}

/**
 * Represents a directory in the virtual filesystem
 */
export interface VirtualDirectory extends VirtualNode {
  type: 'directory';
  /** Child nodes (file/directory names) */
  children: string[];
  /** Directory permissions (octal) */
  mode: number;
  /** Last modified time */
  mtime: Date;
}

/**
 * File attributes returned by getattr() - compatible with FUSE stat structure
 */
export interface FileAttributes {
  /** File size in bytes */
  size: number;
  /** File mode (permissions + type) */
  mode: number;
  /** Last modified time (Unix timestamp in seconds) */
  mtime: number;
  /** Last access time (Unix timestamp in seconds) */
  atime: number;
  /** Creation/change time (Unix timestamp in seconds) */
  ctime: number;
  /** Number of hard links */
  nlink: number;
  /** User ID */
  uid: number;
  /** Group ID */
  gid: number;
}

/**
 * Read result for file content
 */
export interface ReadResult {
  /** For regular files: source path to read from. For virtual files: null */
  sourcePath: string | null;
  /** For virtual files: generated content. For regular files: null */
  content: Buffer | null;
  /** Total file size */
  size: number;
}

/**
 * FUSE API operations
 */
export interface IFuseAPI {
  /**
   * List directory contents
   * @param path Virtual directory path (e.g., "/Anime/Naruto/Season 1")
   * @returns Array of file/directory names in the directory, or null if not found
   */
  readdir(path: string): string[] | null;

  /**
   * Get file or directory attributes
   * @param path Virtual file or directory path
   * @returns File attributes, or null if not found
   */
  getattr(path: string): FileAttributes | null;

  /**
   * Check if a path exists
   * @param path Virtual path
   * @returns true if path exists, false otherwise
   */
  exists(path: string): boolean;

  /**
   * Get read information for a file
   * @param path Virtual file path
   * @returns Read result with source path or content, or null if not found
   */
  read(path: string): ReadResult | null;

  /**
   * Get metadata for a file
   * @param path Virtual file path
   * @returns HashMeta if available, null otherwise
   */
  getMetadata(path: string): HashMeta | null;

  /**
   * Get the complete virtual filesystem tree
   * @returns Root directory node
   */
  getTree(): VirtualDirectory;

  /**
   * Refresh the virtual filesystem from current state
   * Called after processing completes to update the VFS
   */
  refresh(): Promise<void>;
}

/**
 * Events emitted by the FUSE API
 */
export interface FuseAPIEvents {
  /** Emitted when the virtual filesystem is updated */
  'vfs-updated': () => void;
  /** Emitted when a file is added */
  'file-added': (path: string) => void;
  /** Emitted when a file is updated (e.g., metadata changed) */
  'file-updated': (path: string) => void;
  /** Emitted when a file is removed */
  'file-removed': (path: string) => void;
  /** Emitted when a directory is added */
  'directory-added': (path: string) => void;
}

/**
 * Configuration for FUSE API
 */
export interface FuseAPIConfig {
  /** Base path for the virtual filesystem (default: "/") */
  basePath?: string;
  /** Default file permissions (default: 0o644) */
  fileMode?: number;
  /** Default directory permissions (default: 0o755) */
  directoryMode?: number;
  /** User ID for files (default: process.getuid()) */
  uid?: number;
  /** Group ID for files (default: process.getgid()) */
  gid?: number;
}
