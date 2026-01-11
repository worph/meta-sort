/**
 * TempIdGenerator
 *
 * Generates temporary IDs for files before content hash is computed.
 * Uses a deterministic approach based on file path, size, and mtime.
 */

import { createHash } from 'crypto';
import { Stats } from 'fs';

/**
 * Generate a temporary ID for a file based on its path and stats
 * This is deterministic - same file will always get same temp ID
 *
 * @param filePath - Absolute path to the file
 * @param stats - File stats from fs.stat()
 * @returns Temporary ID as MD5 hash (without prefix - prefix added by storage layer)
 */
export function generateTempId(filePath: string, stats: Stats): string {
  // Create deterministic input from file metadata (NOT content)
  const input = `${filePath}:${stats.size}:${stats.mtimeMs}`;

  // Fast MD5 hash of the input
  const hash = createHash('md5').update(input).digest('hex');

  // Return hash without prefix - storage layer adds "tmp:" prefix
  return hash;
}

