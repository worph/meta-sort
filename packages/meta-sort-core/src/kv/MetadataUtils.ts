/**
 * Utility functions for converting between nested JSON metadata and flat key-value pairs.
 * Implements the hierarchical nested key architecture for KV storage (Redis, etc.)
 */

import type { KeyValuePair } from './IKVClient.js';

/**
 * Flattens a nested metadata object into an array of key-value pairs.
 * Each property becomes a separate key with a hierarchical path.
 *
 * @param metadata - The nested metadata object to flatten
 * @param prefix - The key prefix (e.g., "/file/{hashId}")
 * @param excludeFields - Fields to exclude from flattening (e.g., internal tracking fields)
 * @returns Array of key-value pairs suitable for KV storage
 *
 * @example
 * flattenMetadata({ title: "Inception", video: { codec: "h265" } }, "/file/abc123")
 * // Returns:
 * // [
 * //   { key: "/file/abc123/title", value: "Inception" },
 * //   { key: "/file/abc123/video/codec", value: "h265" }
 * // ]
 */
export function flattenMetadata(
  metadata: any,
  prefix: string,
  excludeFields: string[] = []
): KeyValuePair[] {
  const pairs: KeyValuePair[] = [];

  function flatten(obj: any, path: string) {
    if (obj === null || obj === undefined) {
      // Store null/undefined as empty string
      pairs.push({ key: path, value: '' });
      return;
    }

    if (typeof obj !== 'object') {
      // Primitive value - store as string
      pairs.push({ key: path, value: String(obj) });
      return;
    }

    if (Array.isArray(obj)) {
      // Handle arrays with numeric indices
      obj.forEach((item, index) => {
        flatten(item, `${path}/${index}`);
      });
      return;
    }

    // Handle objects recursively
    Object.keys(obj).forEach((key) => {
      // Skip excluded fields
      if (excludeFields.includes(key)) {
        return;
      }

      const value = obj[key];
      const newPath = path ? `${path}/${key}` : key;

      flatten(value, newPath);
    });
  }

  flatten(metadata, prefix);
  return pairs;
}

/**
 * Reconstructs a nested metadata object from flat key-value pairs.
 * Reverses the flattening process to restore the original structure.
 *
 * @param pairs - Array of key-value pairs from KV storage
 * @param prefix - The key prefix to strip (e.g., "/file/{hashId}")
 * @returns Reconstructed nested metadata object
 *
 * @example
 * reconstructMetadata([
 *   { key: "/file/abc123/title", value: "Inception" },
 *   { key: "/file/abc123/video/codec", value: "h265" }
 * ], "/file/abc123")
 * // Returns: { title: "Inception", video: { codec: "h265" } }
 */
export function reconstructMetadata(
  pairs: KeyValuePair[],
  prefix: string
): any {
  const result: any = {};

  pairs.forEach(({ key, value }) => {
    // Strip the prefix to get the property path
    if (!key.startsWith(prefix)) {
      return; // Skip keys that don't match the prefix
    }

    const propertyPath = key.slice(prefix.length + 1); // +1 to skip the leading slash
    if (!propertyPath) {
      return; // Skip if no property path after prefix
    }

    const parts = propertyPath.split('/');
    let current = result;

    // Navigate/create the nested structure
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        // Last part - set the value
        current[part] = parseValue(value);
      } else {
        // Intermediate part - create object or array as needed
        const nextPart = parts[i + 1];
        const isNextPartNumeric = /^\d+$/.test(nextPart);

        if (!(part in current)) {
          // Create array if next part is numeric, otherwise create object
          current[part] = isNextPartNumeric ? [] : {};
        }

        current = current[part];
      }
    }
  });

  // Post-process: Convert objects with only numeric keys to arrays
  return convertNumericObjectsToArrays(result);
}

/**
 * Recursively converts objects with only numeric sequential keys to arrays.
 * This handles cases where arrays were stored with numeric indices.
 */
function convertNumericObjectsToArrays(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    // Already an array, recursively process elements
    return obj.map(convertNumericObjectsToArrays);
  }

  const keys = Object.keys(obj);

  // Check if all keys are numeric and sequential (0, 1, 2, ...)
  const allNumeric = keys.every(key => /^\d+$/.test(key));

  if (allNumeric && keys.length > 0) {
    // Sort keys numerically
    const sortedKeys = keys.map(Number).sort((a, b) => a - b);

    // Check if keys are sequential starting from 0
    const isSequential = sortedKeys.every((key, index) => key === index);

    if (isSequential) {
      // Convert to array
      const arr = sortedKeys.map(index =>
        convertNumericObjectsToArrays(obj[index.toString()])
      );
      return arr;
    }
  }

  // Regular object - recursively process values
  const result: any = {};
  for (const key of keys) {
    result[key] = convertNumericObjectsToArrays(obj[key]);
  }
  return result;
}

/**
 * Parses a string value from KV storage into the appropriate JavaScript type.
 * Handles numbers, booleans, null, and strings.
 *
 * @param value - The string value from KV storage
 * @returns Parsed value with appropriate type
 */
function parseValue(value: string): any {
  // Handle empty string as null
  if (value === '') {
    return null;
  }

  // Handle booleans
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Handle null
  if (value === 'null') return null;

  // Try to parse as number, but be conservative
  // Only parse as number if it's a valid integer or floating point without leading zeros
  // This preserves strings like "5.1" (channel layout), "23.976" (frame rate)
  // Note: In actual storage, these will be stored as strings, so this only matters
  // when the original value was numeric. For metadata consistency, we convert
  // what looks like numbers to numbers.
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value)) {
    return num;
  }

  // Return as string
  return value;
}

/**
 * Extracts the hash ID from a file key.
 *
 * @param key - Full key like "/file/{hashId}/property/path"
 * @returns The hash ID or null if not a valid file key
 *
 * @example
 * extractHashId("/file/sha256:abc123/title") // Returns "sha256:abc123"
 */
export function extractHashId(key: string): string | null {
  const match = key.match(/^\/file\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Builds a property key path.
 *
 * @param hashId - The file's hash ID
 * @param propertyPath - The property path (e.g., "video/codec")
 * @returns Full KV key path
 *
 * @example
 * buildPropertyKey("sha256:abc123", "video/codec")
 * // Returns "/file/sha256:abc123/video/codec"
 */
export function buildPropertyKey(hashId: string, propertyPath: string): string {
  return `/file/${hashId}/${propertyPath}`;
}

/**
 * Builds a file prefix for range queries.
 *
 * @param hashId - The file's hash ID
 * @returns Prefix for querying all properties of a file
 *
 * @example
 * buildFilePrefix("sha256:abc123") // Returns "/file/sha256:abc123"
 */
export function buildFilePrefix(hashId: string): string {
  return `/file/${hashId}`;
}

/**
 * Groups key-value pairs by hash ID.
 * Useful for batch processing multiple files' metadata.
 *
 * @param pairs - Array of key-value pairs
 * @returns Map of hash ID to array of key-value pairs
 */
export function groupByHashId(pairs: KeyValuePair[]): Map<string, KeyValuePair[]> {
  const grouped = new Map<string, KeyValuePair[]>();

  pairs.forEach((pair) => {
    const hashId = extractHashId(pair.key);
    if (hashId) {
      if (!grouped.has(hashId)) {
        grouped.set(hashId, []);
      }
      grouped.get(hashId)!.push(pair);
    }
  });

  return grouped;
}
