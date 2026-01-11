/**
 * Formatting utilities for meta-sort-ui
 */

/**
 * Format bytes to human readable string
 * @param bytes - Number of bytes
 * @returns Formatted string like "5.2 GB"
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Format number with thousand separators
 * @param num - Number to format
 * @returns Formatted string like "1,250,000"
 */
export function formatNumber(num: number): string {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format milliseconds to human readable duration
 * @param ms - Milliseconds
 * @returns Formatted string like "45ms" or "2.5s"
 */
export function formatMs(ms: number): string {
    if (ms === 0) return '0ms';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
}

/**
 * Format uptime in hours:minutes format
 * @param ms - Uptime in milliseconds
 * @returns Formatted string like "2:45"
 */
export function formatUptime(ms: number): string {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Format timestamp to relative "time ago" string
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted string like "45s ago" or "5m ago"
 */
export function formatTimeAgo(timestamp: number | undefined): string {
    if (!timestamp) return '-';
    const seconds = Math.round((Date.now() - timestamp) / 1000);
    if (seconds < 0) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
}

/**
 * Format duration from start to now
 * @param startTime - Start timestamp in milliseconds
 * @returns Formatted string like "45s" or "2m"
 */
export function formatDurationFromStart(startTime: number | undefined): string {
    if (!startTime) return '-';
    const ms = Date.now() - startTime;
    return formatMs(ms);
}

/**
 * Get filename from full path
 * @param filePath - Full file path
 * @returns Filename only
 */
export function getFilename(filePath: string): string {
    return filePath.split('/').pop() || filePath;
}

/**
 * Truncate string in the middle with ellipsis
 * @param str - String to truncate
 * @param maxLength - Maximum length
 * @returns Truncated string
 */
export function truncateMiddle(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    const half = Math.floor((maxLength - 3) / 2);
    return str.slice(0, half) + '...' + str.slice(-half);
}
