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

  /**
   * The record address: the file's midhash256 CID, computed in the light phase
   * and used as the `hashId` throughout meta-sort and as the key of the
   * `/file/{hashId}` record.
   *
   * This replaces the old `cid_midhash256` field. The rename is the point: that
   * name was a *metadata property* name, and it leaked — a `cid_*` field written
   * to a record is stored but never reverse-indexed by meta-core, leaving the
   * record unresolvable by its own CID. meta-core now rejects such fields with a
   * 400. See METADATA_KEYS.md §1/§14.13.
   */
  hashId?: string;

  /**
   * Every digest known for this file, as **bare CIDv1 strings** — the midhash
   * included. Persisted as the key-set `cids/<cid> = "true"`, which is the only
   * shape meta-core indexes.
   *
   * A CIDv1 is self-describing, so a specific digest is recovered by decoding
   * the multicodec (`pickCidByAlgorithm` from `@metazla/meta-hash`), never by a
   * field name.
   */
  cids?: string[];
}
