/**
 * FileMetadata - Extended metadata for file processing
 *
 * Wraps HashMeta with application-specific fields for tracking
 * file processing state.
 */

import { HashMeta } from '@metazla/meta-interface';

export type ProcessingStatus = 'pending' | 'processing' | 'complete' | 'error';

/**
 * Extended file metadata that includes processing state
 * Extends the generic HashMeta with meta-mesh specific fields
 *
 * Note: No longer uses tempId - midhash256 is computed immediately and serves as permanent ID
 */
export interface FileMetadata extends HashMeta {
  /** Current status of file processing */
  processingStatus?: ProcessingStatus;
}
