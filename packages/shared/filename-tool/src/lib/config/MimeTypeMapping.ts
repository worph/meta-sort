import {SimpleFileType} from "../SimpleFileType.js";

/**
 * MIME type → `fileType`. The other half of the canonical classification
 * table (see {@link extensionMappings} and METADATA_KEYS.md §1).
 *
 * ⚠ Resolution is conservative on purpose: when a sniffed MIME maps to a
 * definite value that *disagrees* with the extension's value,
 * `FileTypeConfigurable.getFileType` returns `undefined` rather than guessing
 * — a wrong `fileType` routes a file to a handler that cannot open it. Adding
 * a mapping here therefore also creates a new way to disagree; only add ones
 * whose extension counterpart agrees.
 */
export const mimeTypeMappings: { [key: string]: SimpleFileType } = {
    'text/plain': 'undefined',//text could be anything document or subtitle or other
    // Audio MIME types
    'audio/mpeg': 'audio',
    'audio/wav': 'audio',
    'audio/x-wav': 'audio',
    'audio/flac': 'audio',
    'audio/ogg': 'audio',
    'audio/opus': 'audio',
    'audio/aac': 'audio',
    // ftyp brands `M4A `/`M4B ` sniff as audio/mp4 while a real video mp4
    // sniffs as video/mp4, so this does not collide with the `mp4` extension.
    'audio/mp4': 'audio',
    'audio/x-ms-wma': 'audio',
    'audio/x-aiff': 'audio',
    'audio/x-ape': 'audio',
    // Video MIME types
    'video/mp4': 'video',
    'video/mpeg': 'video',
    'video/quicktime': 'video',
    'video/x-msvideo': 'video',
    'video/x-flv': 'video',
    'video/x-ms-wmv': 'video',
    'video/x-ms-asf': 'video',
    'video/x-matroska': 'video',
    'video/webm': 'video',
    'video/ogg': 'video',
    'video/3gpp': 'video',
    'video/mp2t': 'video',
    // Document MIME types
    'application/pdf': 'document',
    'application/msword': 'document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
    'application/vnd.ms-powerpoint': 'document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
    'application/vnd.ms-excel': 'document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
    'application/vnd.oasis.opendocument.text': 'document',
    'application/vnd.oasis.opendocument.spreadsheet': 'document',
    'application/vnd.oasis.opendocument.presentation': 'document',
    'application/rtf': 'document',
    // Literature containers (METADATA_KEYS.md §14.15)
    'application/epub+zip': 'document',
    'application/x-mobipocket-ebook': 'document',
    'image/vnd.djvu': 'document',
    'text/markdown': 'document',
    // Image MIME types — no longer folded into `document` (§14.15)
    'image/jpeg': 'image',
    'image/png': 'image',
    'image/gif': 'image',
    'image/webp': 'image',
    'image/bmp': 'image',
    'image/tiff': 'image',
    'image/svg+xml': 'image',
    'image/avif': 'image',
    'image/heic': 'image',
    'image/x-icon': 'image',
    // Archive MIME types
    'application/zip': 'archive',
    'application/x-rar-compressed': 'archive',
    'application/vnd.rar': 'archive',
    'application/x-7z-compressed': 'archive',
    'application/gzip': 'archive',
    'application/x-bzip2': 'archive',
    'application/x-xz': 'archive',
    'application/zstd': 'archive',
    'application/x-tar': 'archive',
    // Comic containers sniff as their underlying zip/rar, which agrees with
    // the `cbz`/`cbr` extensions — both say `archive`.
    'application/vnd.comicbook+zip': 'archive',
    'application/vnd.comicbook-rar': 'archive',
    //torrent
    'application/x-bittorrent': 'torrent',
    //subtitles
    'text/vtt': 'subtitle',
    'text/srt': 'subtitle',
    'text/ssa': 'subtitle',
    'text/x-ssa': 'subtitle',
    'text/sub': 'subtitle',
    'application/x-subrip': 'subtitle',
};
