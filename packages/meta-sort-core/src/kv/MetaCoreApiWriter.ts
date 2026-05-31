/**
 * MetaCoreApiWriter — HTTP writer for metadata, replacing direct Redis writes.
 *
 * meta-core owns the Redis schema (UUID-rooted, reverse-indexed by CID). Any
 * service writing directly to Redis risks drifting the schema; the lockdown
 * plan (docs/api-mediated-access.md in meta-core) routes every write through
 * meta-core's HTTP /meta/{hash} family.
 *
 * This writer covers the three operations meta-sort actually performs in
 * production:
 *   - setMetadataFlat → PATCH /meta/{hash} (merge semantics)
 *   - setMetadataProperty → PUT /meta/{hash}/{key}
 *   - deleteMetadataFlat → DELETE /meta/{hash}
 *
 * Reads and stream consumption stay on Redis in PR B; PR C migrates those.
 */
import {
    flattenMetadata,
    buildFilePrefix,
} from './MetadataUtils.js';

export interface MetaCoreApiWriterConfig {
    /** Base URL for meta-core's HTTP API (e.g. http://metacore-app:9000) */
    apiUrl: string;

    /** Optional per-request timeout in ms (default: 30000) */
    timeoutMs?: number;
}

export class MetaCoreApiWriter {
    private apiUrl: string;
    private timeoutMs: number;

    constructor(config: MetaCoreApiWriterConfig) {
        // Trim trailing slash so we can join paths predictably.
        this.apiUrl = config.apiUrl.replace(/\/+$/, '');
        this.timeoutMs = config.timeoutMs ?? 30000;
    }

    /**
     * PATCH /meta/{hash}.
     *
     * meta-core's PATCH calls MergeMetadataFlat — merge semantics, matches
     * what setMetadataFlat used to do via Redis pipeline of SETs.
     */
    async setMetadataFlat(
        hashId: string,
        metadata: any,
        excludeFields: string[] = []
    ): Promise<void> {
        // Reuse the same flattening logic the Redis path used so the wire
        // payload matches what handler.MergeMetadataFlat expects (flat map
        // of "a/b/c" → string value).
        const prefix = buildFilePrefix(hashId);
        const pairs = flattenMetadata(metadata, prefix, excludeFields);
        if (pairs.length === 0) return;

        const flat: Record<string, string> = {};
        for (const pair of pairs) {
            // pair.key is "file:<hash>/<field>"; strip the prefix+slash.
            const field = pair.key.slice(prefix.length + 1);
            if (!field) continue;
            // Sibling CIDs are stored as a bare-CID key-set (cids/<cid> =
            // "true"), never as per-algorithm cid_* fields. Rewrite any
            // legacy cid_* field (e.g. the in-memory cid_midhash256 primary
            // id) into the key-set form so no deprecated field ever reaches a
            // record. The CID is self-describing, so the algorithm in the
            // field name is dropped. See METADATA_KEYS.md §2/§14.13.
            if (field.startsWith('cid_') && pair.value) {
                flat[`cids/${pair.value}`] = 'true';
            } else {
                flat[field] = pair.value;
            }
        }

        await this.fetchJson('PATCH', `/meta/${encodeURIComponent(hashId)}`, flat);
    }

    /**
     * PUT /meta/{hash}/{key}.
     *
     * meta-core accepts either JSON {"value":"..."} or plain text; we use
     * the JSON form to avoid ambiguity with values that happen to look like
     * JSON themselves.
     */
    async setMetadataProperty(hashId: string, property: string, value: string): Promise<void> {
        await this.fetchJson(
            'PUT',
            `/meta/${encodeURIComponent(hashId)}/${this.encodePropertyPath(property)}`,
            { value }
        );
    }

    /**
     * DELETE /meta/{hash}.
     *
     * Removes every property and unregisters the hashId from file:__index__.
     */
    async deleteMetadataFlat(hashId: string): Promise<number> {
        const body = await this.fetchJson(
            'DELETE',
            `/meta/${encodeURIComponent(hashId)}`,
            null
        );
        // meta-core's response is {success, hashId, deleted: N}.
        if (body && typeof body === 'object' && typeof (body as any).deleted === 'number') {
            return (body as any).deleted;
        }
        return 0;
    }

    /**
     * GET /meta/{hash}. Returns the flat metadata map (or null if absent).
     */
    async getMetadataFlat(hashId: string): Promise<any | null> {
        const path = `/meta/${encodeURIComponent(hashId)}`;
        const body = await this.fetchJsonAllowing404('GET', path);
        if (body === null) return null;
        // meta-core wraps the flat map under `metadata`.
        const flat = (body as any)?.metadata;
        if (!flat || typeof flat !== 'object') return null;
        return flat;
    }

    /**
     * GET /meta/{hash}/{propertyPath}. Returns the raw string value (or null
     * if absent). meta-core sends back text/plain.
     */
    async getMetadata(hashId: string, propertyPath: string): Promise<any | null> {
        const path = `/meta/${encodeURIComponent(hashId)}/${this.encodePropertyPath(propertyPath)}`;
        const url = `${this.apiUrl}${path}`;
        const response = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { Accept: 'text/plain' },
        });
        if (response.status === 404) return null;
        if (!response.ok) {
            throw new Error(`[MetaCoreApiWriter] GET ${path} → ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (!text) return null;
        // Mirror the legacy RedisClient: try JSON-parse first, fall back to raw string.
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    /**
     * GET /meta. Returns the list of all hashIds known to meta-core.
     */
    async getAllHashIds(): Promise<string[]> {
        const body = await this.fetchJson('GET', '/meta', null);
        const ids = (body as any)?.hashIds;
        return Array.isArray(ids) ? ids : [];
    }

    /**
     * GET /health on meta-core. Used as a write-path health probe.
     */
    async health(): Promise<boolean> {
        try {
            const response = await fetch(`${this.apiUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
                headers: { Accept: 'application/json' },
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    private async fetchJsonAllowing404(method: string, path: string): Promise<unknown> {
        const url = `${this.apiUrl}${path}`;
        const response = await fetch(url, {
            method,
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { Accept: 'application/json' },
        });
        if (response.status === 404) return null;
        if (!response.ok) {
            throw new Error(`[MetaCoreApiWriter] ${method} ${path} → ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
    }

    /**
     * Encode a slash-containing property path safely for the URL while still
     * letting meta-core's `{key:.*}` route match the multi-segment key.
     */
    private encodePropertyPath(property: string): string {
        return property
            .split('/')
            .map(segment => encodeURIComponent(segment))
            .join('/');
    }

    private async fetchJson(
        method: string,
        path: string,
        body: unknown
    ): Promise<unknown> {
        const url = `${this.apiUrl}${path}`;
        const init: RequestInit = {
            method,
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { Accept: 'application/json' },
        };
        if (body !== null && body !== undefined) {
            init.headers = { ...init.headers, 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }

        const response = await fetch(url, init);
        if (!response.ok) {
            // Surface meta-core's error envelope when it's structured.
            let detail = response.statusText;
            try {
                const errBody = await response.text();
                if (errBody) detail = `${detail}: ${errBody}`;
            } catch {
                /* ignore body-read errors; statusText still useful */
            }
            throw new Error(`[MetaCoreApiWriter] ${method} ${path} → ${response.status} ${detail}`);
        }

        // 204 / empty body — return null so callers don't choke on JSON parse.
        const text = await response.text();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
}
