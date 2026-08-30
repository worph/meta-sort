/**
 * The `fileType` vocabulary — METADATA_KEYS.md §1. Kept in lockstep with
 * `filename-tool`'s `SimpleFileType`, which is the classifier that produces
 * these values; this copy is the wire/type-level mirror.
 */
export type SimpleFileType =
    'audio'
    | 'video'
    | 'image'
    | 'document'
    | 'archive'
    | 'subtitle'
    | 'torrent'
    | 'card'
    | 'other'
    | 'undefined';
