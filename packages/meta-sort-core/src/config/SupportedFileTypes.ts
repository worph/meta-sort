/**
 * Supported file extensions for Meta Mesh
 * Application-specific configuration
 */

export const SUPPORTED_VIDEO_EXTENSIONS = new Set([
    '.mkv',
    '.mp4',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.m4v',
    '.mpg',
    '.mpeg',
    '.m2ts',
    '.ts',
    '.vob',
    '.3gp',
    '.ogv',
    '.divx',
    '.xvid',
    '.rm',
    '.rmvb'
]);

export const SUPPORTED_SUBTITLE_EXTENSIONS = new Set([
    '.srt',
    '.ass',
    '.ssa',
    '.sub',
    '.vtt',
    '.idx'
]);

export const SUPPORTED_METADATA_EXTENSIONS = new Set([
    '.torrent'
]);

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.bmp',
    '.tiff',
    '.tif'
]);

/**
 * All supported file extensions
 */
export const SUPPORTED_EXTENSIONS = new Set([
    ...SUPPORTED_VIDEO_EXTENSIONS,
    ...SUPPORTED_SUBTITLE_EXTENSIONS,
    ...SUPPORTED_METADATA_EXTENSIONS,
    ...SUPPORTED_IMAGE_EXTENSIONS
]);

/**
 * Check if file extension is supported
 */
export function isSupportedExtension(filePath: string): boolean {
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
}
