import {SimpleFileType} from "../SimpleFileType.js";

export const mimeTypeMappings: { [key: string]: SimpleFileType } = {
    'text/plain': 'undefined',//text could be anything document or subtitle or other
    // Audio MIME types
    'audio/mpeg': 'audio',
    'audio/wav': 'audio',
    'audio/flac': 'audio',
    // Video MIME types
    'video/mp4': 'video',
    'video/mpeg': 'video',
    'video/quicktime': 'video',
    'video/x-msvideo': 'video',
    'video/x-flv': 'video',
    'video/x-ms-wmv': 'video',
    'video/x-matroska': 'video',
    'video/webm': 'video',
    // Document MIME types
    'application/pdf': 'document',
    'application/msword': 'document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
    'application/vnd.ms-powerpoint': 'document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
    'application/vnd.ms-excel': 'document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
    'image/jpeg': 'document',
    'image/png': 'document',
    'image/gif': 'document',
    // Archive MIME types
    'application/zip': 'archive',
    'application/x-rar-compressed': 'archive',
    'application/x-7z-compressed': 'archive',
    'application/gzip': 'archive',
    'application/x-tar': 'archive',
    //torrent
    'application/x-bittorrent': 'torrent',
    //subtitles
    'text/vtt': 'subtitle',
    'text/srt': 'subtitle',
    'text/ssa': 'subtitle',
    'text/sub': 'subtitle',
};