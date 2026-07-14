import { useState, useEffect } from 'react';
import { FileMetadata, PluginSchema, PluginsResponse } from '../types';
import { MetadataAPI } from '../api/metadataApi';
import { DynamicPluginSection } from './DynamicPluginSection';
import './MetadataEditor.css';

interface PluginAccordionProps {
  plugin: PluginSchema;
  metadata: FileMetadata;
  onChange: (field: string, value: any) => void;
  isExpanded: boolean;
  onToggle: () => void;
}

function PluginAccordion({ plugin, metadata, onChange, isExpanded, onToggle }: PluginAccordionProps) {
  return (
    <div className={`plugin-accordion ${isExpanded ? 'expanded' : ''}`}>
      <button
        className="plugin-accordion-header"
        onClick={onToggle}
        style={{ borderLeftColor: plugin.color || '#646cff' }}
      >
        <span className="plugin-accordion-title">{plugin.name}</span>
        <span className="plugin-accordion-icon">{isExpanded ? '▼' : '▶'}</span>
      </button>
      {isExpanded && (
        <div className="plugin-accordion-content">
          <DynamicPluginSection
            plugin={plugin}
            metadata={metadata}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

interface MetadataEditorProps {
  hashId: string;
  onSaved?: () => void;
}

export function MetadataEditor({ hashId, onSaved }: MetadataEditorProps) {
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [editedMetadata, setEditedMetadata] = useState<FileMetadata | null>(null);
  const [plugins, setPlugins] = useState<PluginSchema[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());

  // Fetch plugins schema on mount
  useEffect(() => {
    fetchPlugins();
  }, []);

  // Fetch metadata when hashId changes
  useEffect(() => {
    loadMetadata();
  }, [hashId]);

  const fetchPlugins = async () => {
    try {
      const response = await fetch('/api/plugins');
      if (response.ok) {
        const data: PluginsResponse = await response.json();
        // Sort by priority (lower = higher priority)
        const sorted = [...data.plugins].sort((a, b) =>
          (a.priority ?? 100) - (b.priority ?? 100)
        );
        setPlugins(sorted);
      }
    } catch (err) {
      console.error('Failed to fetch plugin schemas:', err);
    }
  };

  const loadMetadata = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await MetadataAPI.getMetadata(hashId);
      // API returns { hashId, metadata: {...} } - extract the metadata object
      const data = (response as any).metadata || response;
      setMetadata(data);
      setEditedMetadata(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFieldChange = (field: string, value: any) => {
    if (!editedMetadata) return;

    // Handle path-style keys like "stream/duration" or "nfo/title"
    const parts = field.split('/');

    if (parts.length === 1) {
      // Simple key
      setEditedMetadata({
        ...editedMetadata,
        [field]: value,
      });
    } else {
      // Nested key - need to update nested structure
      const newMetadata = { ...editedMetadata };
      let current: any = newMetadata;

      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) {
          current[parts[i]] = {};
        } else {
          current[parts[i]] = { ...current[parts[i]] };
        }
        current = current[parts[i]];
      }

      current[parts[parts.length - 1]] = value;
      setEditedMetadata(newMetadata);
    }
  };

  const handleSave = async () => {
    if (!editedMetadata) return;

    try {
      setIsSaving(true);
      setError(null);
      setSuccessMessage(null);

      await MetadataAPI.updateMetadata(hashId, editedMetadata);
      setMetadata(editedMetadata);
      setSuccessMessage('Metadata saved successfully!');

      if (onSaved) {
        onSaved();
      }

      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setEditedMetadata(metadata);
    setError(null);
    setSuccessMessage(null);
  };

  const togglePlugin = (pluginId: string) => {
    setExpandedPlugins(prev => {
      const next = new Set(prev);
      if (next.has(pluginId)) {
        next.delete(pluginId);
      } else {
        next.add(pluginId);
      }
      return next;
    });
  };

  const scrollToPlugin = (pluginId: string) => {
    // Expand the plugin if not already expanded
    if (!expandedPlugins.has(pluginId)) {
      setExpandedPlugins(prev => new Set(prev).add(pluginId));
    }
    // Scroll to the plugin after a short delay to allow expansion
    setTimeout(() => {
      const element = document.getElementById(`plugin-${pluginId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  };

  if (isLoading) {
    return <div className="metadata-editor-loading">Loading metadata...</div>;
  }

  if (error && !metadata) {
    return (
      <div className="metadata-editor-error">
        <p>Error loading metadata: {error}</p>
        <button onClick={loadMetadata}>Retry</button>
      </div>
    );
  }

  if (!metadata || !editedMetadata) {
    return <div className="metadata-editor-empty">No metadata available</div>;
  }

  const hasChanges = JSON.stringify(metadata) !== JSON.stringify(editedMetadata);

  // Filter plugins that have data
  const pluginsWithData = plugins.filter(plugin => {
    if (!plugin.metadataSchema) return false;
    return hasPluginData(plugin, editedMetadata);
  });

  // Get file path for download
  const filePath = editedMetadata?.filePath as string | undefined;
  const downloadUrl = filePath ? `/api/file/download?path=${encodeURIComponent(filePath)}` : null;

  return (
    <div className="metadata-editor">
      <div className="metadata-editor-header">
        <h2>Edit Metadata</h2>
        <div className="metadata-editor-actions">
          {downloadUrl && (
            <a
              href={downloadUrl}
              className="download-button"
              title={`Download: ${filePath}`}
              download
            >
              ⬇ Download
            </a>
          )}
          {hasChanges && (
            <button onClick={handleReset} disabled={isSaving}>
              Reset
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            className="primary"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {successMessage && (
        <div className="metadata-editor-message success">{successMessage}</div>
      )}
      {error && <div className="metadata-editor-message error">{error}</div>}

      <div className="metadata-editor-hashes">
        <div className="hashes-header">
          <h3>Content Identifiers</h3>
        </div>
        <div className="hashes-grid">
          <HashValue label="midhash256" value={hashId} primary />
          {getHashValues(editedMetadata).map(({ key, label, value }) => (
            <HashValue key={key} label={label} value={value} />
          ))}
        </div>
      </div>

      {pluginsWithData.length > 0 && (
        <div className="metadata-editor-chips">
          {pluginsWithData.map((plugin) => (
            <button
              key={plugin.id}
              className={`plugin-chip ${expandedPlugins.has(plugin.id) ? 'active' : ''}`}
              style={{
                '--chip-color': plugin.color || '#646cff',
                backgroundColor: expandedPlugins.has(plugin.id) ? plugin.color || '#646cff' : 'transparent'
              } as React.CSSProperties}
              onClick={() => scrollToPlugin(plugin.id)}
            >
              {plugin.name}
            </button>
          ))}
        </div>
      )}

      <div className="metadata-editor-form">
        {pluginsWithData.length === 0 ? (
          <div className="metadata-editor-empty">
            No metadata found for this file
          </div>
        ) : (
          pluginsWithData.map((plugin) => (
            <div key={plugin.id} id={`plugin-${plugin.id}`}>
              <PluginAccordion
                plugin={plugin}
                metadata={editedMetadata}
                onChange={handleFieldChange}
                isExpanded={expandedPlugins.has(plugin.id)}
                onToggle={() => togglePlugin(plugin.id)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Check if a plugin has any data in the metadata
 */
function hasPluginData(plugin: PluginSchema, metadata: FileMetadata): boolean {
  const schema = plugin.metadataSchema;
  if (!schema) return false;

  for (const fieldKey of Object.keys(schema)) {
    const fieldSchema = schema[fieldKey];

    // For JSON type with pattern, check if any matching keys exist
    if (fieldSchema.type === 'json' && fieldSchema.pattern) {
      const patternPrefix = fieldSchema.pattern.replace(/\{n\}.*$/, '').replace(/\/$/, '');
      if (hasKeyWithPrefix(metadata, patternPrefix)) {
        return true;
      }
      continue;
    }

    // For regular fields, check if value exists
    if (getNestedValue(metadata, fieldKey) !== undefined) {
      return true;
    }
  }
  return false;
}

function getNestedValue(obj: any, path: string): any {
  if (!obj) return undefined;

  // First, check if the key exists as a flat key (e.g., "fileinfo/duration")
  if (path in obj) {
    return obj[path];
  }

  // Fall back to nested traversal
  const parts = path.split('/');
  let value = obj;
  for (const part of parts) {
    if (value === undefined || value === null) return undefined;
    value = value[part];
  }
  return value;
}

function hasKeyWithPrefix(obj: any, prefix: string, currentPath: string = ''): boolean {
  if (!obj || typeof obj !== 'object') return false;

  for (const key of Object.keys(obj)) {
    // Check flat keys that contain '/' (e.g., "stream/0", "fileinfo/duration")
    if (key.startsWith(prefix + '/') || key === prefix) {
      return true;
    }

    const newPath = currentPath ? `${currentPath}/${key}` : key;
    if (newPath.startsWith(prefix)) {
      return true;
    }
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (hasKeyWithPrefix(obj[key], prefix, newPath)) {
        return true;
      }
    }
  }
  return false;
}

// Human label per multihash code / CID codec. Source of truth for codes:
// meta-hash MultiHashData + METADATA_KEYS.md §2.
const CID_LABELS: Record<number, string> = {
  0x12: 'SHA-256',
  0x16: 'SHA3-256',
  0x15: 'SHA3-384',
  0x11: 'SHA-1',
  0xd5: 'MD5',
  0x132: 'CRC32',
  0x1000: 'MidHash256',
  0xb702: 'BT Pieces Root',
  0x70: 'IPFS (dag-pb)',
  0x10b7: 'BitTorrent v2',
  0x1001: 'BitTorrent v1 (file)',
  0x1002: 'BitTorrent v2 (file)',
  0x1005: 'Usenet release',
  0x1006: 'URL',
};

/**
 * Display order for a record's CIDs. This mirrors the canonical rank ladder
 * (`packages/meta-core/internal/cid/rank.go`, the two `cid_rank.rs`, and the
 * `/cid-rank-vectors.json` golden fixture) — same ordering, scaled down.
 *
 * It used to be its own invented ladder (5/4/3/2) with no dag-pb entry at all,
 * which meant an IPFS root fell through to 0 and sorted *below* MD5. Display-only,
 * so it never broke anything — but it was a seventh, silently divergent copy of a
 * rule that already has too many. Keep it in step: a code with no entry sorts last.
 */
const RANK_BY_LABEL: Record<string, number> = {
  'IPFS (dag-pb)': 6,
  'SHA-256': 5, 'SHA3-256': 5, 'SHA3-384': 5,
  'BitTorrent v2': 4, 'BitTorrent v1 (file)': 4, 'BitTorrent v2 (file)': 4,
  MidHash256: 3,
  'Usenet release': 2, URL: 2,
  'SHA-1': 1, MD5: 1, CRC32: 1,
};

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function decodeBase32(s: string): Uint8Array | null {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function readUvarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0, shift = 0, p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, p];
    shift += 7;
  }
  return [0, pos];
}

/**
 * Decode a bare multibase-base32 CIDv1 into [codec, multihashCode], or null.
 * The algorithm is recovered from these — sibling CIDs are stored as a
 * key-set (cids/<cid>) with no per-algorithm field name.
 */
function decodeCid(cid: string): { codec: number; mh: number } | null {
  if (!cid.startsWith('b')) return null;
  const bytes = decodeBase32(cid.slice(1));
  if (!bytes || bytes.length < 3) return null;
  let v: number, pos = 0;
  [v, pos] = readUvarint(bytes, pos);
  if (v !== 1) return null;
  let codec: number;
  [codec, pos] = readUvarint(bytes, pos);
  let mh: number;
  [mh, pos] = readUvarint(bytes, pos);
  return { codec, mh };
}

function cidLabel(cid: string): string {
  const d = decodeCid(cid);
  if (!d) return 'CID';
  // Per-file BitTorrent codecs are carried on the CID codec, not the mh code.
  return CID_LABELS[d.codec] ?? CID_LABELS[d.mh] ?? 'CID';
}

/**
 * Extract all sibling CIDs from the record's bare-CID key-set (cids/<cid>),
 * labelling each by its multicodec. Replaces the old per-algorithm cid_*
 * fields. See METADATA_KEYS.md §2/§14.13.
 */
function getHashValues(metadata: FileMetadata): { key: string; label: string; value: string }[] {
  const out: { key: string; label: string; value: string }[] = [];
  for (const key of Object.keys(metadata as any)) {
    if (!key.startsWith('cids/')) continue;
    const cid = key.slice('cids/'.length);
    if (!cid) continue;
    out.push({ key, label: cidLabel(cid), value: cid });
  }
  // Most useful first (sha/ipfs > btih > midhash > weak digests), then by label.
  out.sort((a, b) => (RANK_BY_LABEL[b.label] ?? 0) - (RANK_BY_LABEL[a.label] ?? 0) || a.label.localeCompare(b.label));
  return out;
}

/**
 * Display a single hash value with copy functionality
 */
function HashValue({ label, value, primary }: { label: string; value: string; primary?: boolean }) {
  const handleCopy = () => {
    navigator.clipboard.writeText(value);
  };

  return (
    <div className={`hash-value ${primary ? 'hash-value-primary' : ''}`}>
      <span className="hash-label">{label}</span>
      <code className="hash-code" onClick={handleCopy} title="Click to copy">
        {value}
      </code>
    </div>
  );
}
