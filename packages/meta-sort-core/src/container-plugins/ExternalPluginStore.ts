/**
 * External plugins — enrichment plugins meta-sort did NOT spawn, reached by
 * URL (typically a MetaPlugin* store app found with the Plugins page's beacon
 * Scan card). Persisted as JSON next to the cache, because the store app
 * mounts plugins.yml read-only.
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';

export interface ExternalPluginEntry {
    /** The plugin's manifest id — its identity in the pipeline. */
    pluginId: string;
    /** Base URL of the plugin's HTTP contract (/manifest, /health, /process). */
    url: string;
    enabled: boolean;
    /** Name it was added under (the advertising instance), display only. */
    name?: string;
    addedAt?: string;
}

export class ExternalPluginStore {
    constructor(private readonly path: string) {}

    /** The persisted list; empty when the file is missing or unreadable. */
    async load(): Promise<ExternalPluginEntry[]> {
        let raw: string;
        try {
            raw = await fs.readFile(this.path, 'utf-8');
        } catch {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
            return list.filter(
                (e: Partial<ExternalPluginEntry>) => typeof e?.pluginId === 'string' && typeof e?.url === 'string'
            ).map((e: ExternalPluginEntry) => ({ ...e, enabled: e.enabled !== false }));
        } catch (error) {
            console.error(`[ExternalPluginStore] ${this.path} is not valid JSON; ignoring it:`, error);
            return [];
        }
    }

    /** Atomic write: a crash mid-save leaves the previous file intact. */
    async save(entries: ExternalPluginEntry[]): Promise<void> {
        await fs.mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ plugins: entries }, null, 2), 'utf-8');
        await fs.rename(tmp, this.path);
    }
}
