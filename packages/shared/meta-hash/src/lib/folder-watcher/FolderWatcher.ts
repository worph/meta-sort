import * as path from 'path';
import chokidar from 'chokidar';
import {readdir} from "fs/promises";

/**
 * Generic file discovery utility
 * Discovers files in directory trees and emits paths as async generator
 * No filtering logic - just pure file discovery
 */
export class FolderWatcher {
    /**
     * Discover all files in given directories
     * Returns async generator that yields file paths as they're discovered
     *
     * @param directories - Array of directory paths to scan
     * @returns AsyncGenerator yielding file paths
     */
    async *discoverFiles(directories: string[]): AsyncGenerator<string> {
        for (const dir of directories) {
            const normalizedDir = path.normalize(dir);
            yield* this.walkDirectory(normalizedDir);
        }
    }

    /**
     * Recursively walk directory tree
     * Yields file paths as they're discovered
     *
     * @param directory - Directory to walk
     * @returns AsyncGenerator yielding file paths
     */
    private async *walkDirectory(directory: string): AsyncGenerator<string> {
        try {
            const entries = await readdir(directory, {withFileTypes: true});

            // Collect subdirectories for parallel processing
            const subdirs: string[] = [];

            for (const entry of entries) {
                const fullPath = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    subdirs.push(fullPath);
                } else {
                    // Yield file path immediately
                    yield fullPath;
                }
            }

            // Process subdirectories (yields naturally to event loop)
            for (const subdir of subdirs) {
                yield* this.walkDirectory(subdir);
            }
        } catch (error: any) {
            // Handle permission errors gracefully
            if (error.code === 'EACCES' || error.code === 'EPERM') {
                console.warn(`[FolderWatcher] Permission denied: ${directory} - skipping`);
            } else if (error.code === 'ENOENT') {
                console.warn(`[FolderWatcher] Directory not found: ${directory} - skipping`);
            } else if (error.code === 'ENOTDIR') {
                console.warn(`[FolderWatcher] Not a directory: ${directory} - skipping`);
            } else {
                console.error(`[FolderWatcher] Error reading directory ${directory}:`, error.message);
            }
            // Continue processing - don't let one bad directory stop the scan
        }
    }

    /**
     * Watch directories for file changes using chokidar
     *
     * @param directories - Directories to watch
     * @param callbacks - Event callbacks
     * @param options - Chokidar options
     */
    watch(directories: string[], callbacks: {
        onAdd?: (filePath: string) => void | Promise<void>;
        onChange?: (filePath: string) => void | Promise<void>;
        onUnlink?: (filePath: string) => void | Promise<void>;
        onReady?: () => void | Promise<void>;
        onError?: (error: Error) => void | Promise<void>;
    }, options?: {
        interval?: number;
        stabilityThreshold?: number;
        pollInterval?: number;
    }): chokidar.FSWatcher {
        const chokidarConfig: chokidar.WatchOptions = {
            ignoreInitial: true,  // Don't emit events for initial scan
            persistent: true,
            depth: Infinity,
            awaitWriteFinish: {
                stabilityThreshold: options?.stabilityThreshold || 30000,
                pollInterval: options?.pollInterval || 5000
            }
        };

        let watcher: chokidar.FSWatcher;
        if ((options?.interval || 0) <= 0) {
            watcher = chokidar.watch(directories, chokidarConfig);
        } else {
            watcher = chokidar.watch(directories, {
                ...chokidarConfig,
                usePolling: true,
                interval: options.interval
            });
        }

        if (callbacks.onAdd) {
            watcher.on('add', async (filePath) => {
                try {
                    await callbacks.onAdd!(filePath);
                } catch (error) {
                    console.error(`[FolderWatcher] Error in onAdd callback for ${filePath}:`, error);
                }
            });
        }

        if (callbacks.onChange) {
            watcher.on('change', async (filePath) => {
                try {
                    await callbacks.onChange!(filePath);
                } catch (error) {
                    console.error(`[FolderWatcher] Error in onChange callback for ${filePath}:`, error);
                }
            });
        }

        if (callbacks.onUnlink) {
            watcher.on('unlink', async (filePath) => {
                try {
                    await callbacks.onUnlink!(filePath);
                } catch (error) {
                    console.error(`[FolderWatcher] Error in onUnlink callback for ${filePath}:`, error);
                }
            });
        }

        watcher.on('error', (error: Error) => {
            if (callbacks.onError) {
                callbacks.onError(error);
            } else {
                // Default error handling
                const err = error as any;
                if (err.code === 'EACCES' || err.code === 'EPERM') {
                    console.warn(`[FolderWatcher] Permission denied for file watcher:`, error.message);
                } else if (err.code === 'ENOENT') {
                    console.warn(`[FolderWatcher] Watched path no longer exists:`, error.message);
                } else if (err.code === 'ENOSPC') {
                    console.error(`[FolderWatcher] CRITICAL: No space left on device or inotify watch limit reached:`, error.message);
                    console.error(`[FolderWatcher] Try increasing fs.inotify.max_user_watches: sysctl fs.inotify.max_user_watches=524288`);
                } else {
                    console.error(`[FolderWatcher] Watcher error:`, error.message || error);
                }
            }
        });

        if (callbacks.onReady) {
            watcher.on('ready', async () => {
                try {
                    console.log(`[FolderWatcher] Watching for file changes on ${directories.join(', ')}`);
                    await callbacks.onReady!();
                } catch (error) {
                    console.error(`[FolderWatcher] Error in onReady callback:`, error);
                }
            });
        }

        return watcher;
    }
}
