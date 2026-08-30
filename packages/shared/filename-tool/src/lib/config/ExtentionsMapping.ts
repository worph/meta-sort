import {SimpleFileType} from "../SimpleFileType.js";

/**
 * Extension → `fileType`. Half of the canonical classification table
 * documented in METADATA_KEYS.md §1 (the other half is
 * {@link mimeTypeMappings}); this file is the source of truth and the doc
 * mirrors it.
 *
 * An extension absent from this map resolves to `other`, which makes the file
 * invisible to every typed query — so a missing entry is not a cosmetic gap.
 */
export const extensionMappings: { [key: string]: SimpleFileType } = {
    // Audio
    'mp3': 'audio',
    'wav': 'audio',
    'flac': 'audio',
    'aac': 'audio',
    'ogg': 'audio',
    'oga': 'audio',
    'opus': 'audio',
    'm4a': 'audio',
    // `m4b` is the audiobook container — without it `contentKind=audiobook`
    // had no extension that resolved to `audio` (METADATA_KEYS.md §14.15).
    'm4b': 'audio',
    'wma': 'audio',
    'aiff': 'audio',
    'aif': 'audio',
    'ape': 'audio',
    'wv': 'audio',
    'dsf': 'audio',
    'mka': 'audio',
    // Video
    'mp4': 'video',
    'mkv': 'video',
    'webm': 'video',
    'avi': 'video',
    'mov': 'video',
    'wmv': 'video',
    'flv': 'video',
    'm4v': 'video',
    'mpg': 'video',
    'mpeg': 'video',
    '3gp': 'video',
    '3g2': 'video',
    'f4v': 'video',
    'm2ts': 'video',
    'mts': 'video',
    'ts': 'video',
    'vob': 'video',
    'ogm': 'video',
    'ogv': 'video',
    'asf': 'video',
    'divx': 'video',
    'xvid': 'video',
    // Document
    'pdf': 'document',
    'doc': 'document',
    'docx': 'document',
    'ppt': 'document',
    'pptx': 'document',
    'xls': 'document',
    'xlsx': 'document',
    'odt': 'document',
    'ods': 'document',
    'odp': 'document',
    'txt': 'document',
    'md': 'document',
    'rtf': 'document',
    // Document — literature formats. Their absence blocked meta-read outright
    // (METADATA_KEYS.md §14.15).
    'epub': 'document',
    'mobi': 'document',
    'azw': 'document',
    'azw3': 'document',
    'djvu': 'document',
    // Images
    // ⚠ These used to map to `document` ("Images (are document)"), which meant
    // the `image` bucket was unreachable from this table while Rust feeders
    // wrote it anyway. A consumer asking for documents must not receive
    // posters — see METADATA_KEYS.md §14.15.
    'jpg': 'image',
    'jpeg': 'image',
    'png': 'image',
    'gif': 'image',
    'bmp': 'image',
    'tif': 'image',
    'tiff': 'image',
    'svg': 'image',
    'webp': 'image',
    'avif': 'image',
    'heic': 'image',
    'heif': 'image',
    'ico': 'image',
    // Archive
    'zip': 'archive',
    'rar': 'archive',
    '7z': 'archive',
    'tar': 'archive',
    'tgz': 'archive',
    'gz': 'archive',
    'bz2': 'archive',
    'xz': 'archive',
    'zst': 'archive',
    // Archive — comic containers. A `.cbz` is literally a zip, so `archive` is
    // the honest byte-level answer; `contentKind=comic` + `domain=literature`
    // are what route it to meta-read (METADATA_KEYS.md §14.16).
    'cbz': 'archive',
    'cbr': 'archive',
    //subtitles
    'srt': 'subtitle',
    'sub': 'subtitle',
    'sbv': 'subtitle',
    'vtt': 'subtitle',
    // ⚠ ASS/SSA is what meta-watch renders through libass — the client's
    // primary subtitle format was the one this classifier did not know.
    'ass': 'subtitle',
    'ssa': 'subtitle',
    'ttml': 'subtitle',
    'dfxp': 'subtitle',
    'smi': 'subtitle',
    //torrent
    'torrent': 'torrent',
};
