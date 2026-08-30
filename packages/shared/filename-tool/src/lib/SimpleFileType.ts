/**
 * The `fileType` vocabulary — see METADATA_KEYS.md §1.
 *
 * ⚠ INVARIANT: a value belongs here only if an `(extension, mimeType)` lookup
 * can decide it on its own. Nothing that requires knowing what the content
 * *is* goes in this field — that is `contentKind`'s job — and nothing that
 * decides *which app gets the record* depends on it — that is `domain`'s job
 * (METADATA_KEYS.md §14.16).
 *
 * `card` is the one deliberate exception: it describes no bytes at all and is
 * therefore never produced by the tables here, only stamped by a card feeder.
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
