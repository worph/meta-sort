# Meta-Sort Plugin System Architecture

This document describes the plugin system architecture for meta-sort, enabling extensible metadata extraction through dynamically loaded plugins.

## Overview

The plugin system provides a modular architecture for metadata extraction. Plugins are self-contained units that:

- Are discovered and loaded from a plugins directory at startup
- Can be activated/deactivated at runtime without restart
- Process files sequentially in dependency order
- Store metadata in a flat key-value format
- Have access to their own persistent cache folder

## Directory Structure

```
packages/meta-sort/packages/meta-sort-core/
├── plugins/                          # All plugins (shipped + custom)
│   ├── file-info/
│   │   ├── manifest.yml              # Plugin metadata & config schema
│   │   └── index.ts                  # Plugin implementation
│   ├── ffmpeg/
│   ├── filename-parser/
│   ├── anime-detector/
│   ├── jellyfin-nfo/
│   ├── subtitle/
│   ├── torrent/
│   ├── language/
│   ├── tmdb/
│   └── debug/
├── plugins.json                      # Runtime state (active/inactive + configs)
└── src/
    └── plugin/
        ├── types.ts                  # Type definitions
        ├── PluginLoader.ts           # Manifest parsing, dynamic import
        ├── PluginContext.ts          # Context factory
        ├── PluginManager.ts          # Lifecycle management
        └── PluginExecutor.ts         # Dependency-ordered execution
```

Cache folders are stored separately under `CACHE_FOLDER_PATH` (default `/data/cache/plugins/`):

```
/data/cache/plugins/
├── ffmpeg/
│   ├── {cid1}.json
│   └── {cid2}.json
├── tmdb/
│   ├── {cid1}.json
│   └── {cid2}.json
└── ...
```

## Plugin Manifest

Each plugin must have a `manifest.yml` file defining its metadata, dependencies, and configuration schema.

```yaml
# manifest.yml
id: tmdb                              # Unique identifier (matches folder name)
name: TMDB Enricher                   # Human-readable name
version: 1.0.0                        # Semantic version
description: Enriches metadata from The Movie Database API

# Plugins that must execute BEFORE this one
dependencies:
  - filename-parser                   # Needs parsed title/year

# Configuration schema (rendered in dashboard)
config:
  apiKey:
    type: string
    label: API Key
    required: true
    secret: true                      # Masked in UI
  language:
    type: string
    label: Language
    default: en-US
  includeAdult:
    type: boolean
    label: Include Adult Content
    default: false

# Metadata schema for editor UI (optional)
# Describes keys this plugin writes
schema:
  tmdb/id:
    label: TMDB ID
    type: string
    readonly: true
  tmdb/title:
    label: Title
    type: string
  tmdb/overview:
    label: Overview
    type: text
  tmdb/poster:
    label: Poster URL
    type: string
    format: url
  tmdb/genre/{n}:
    label: Genre
    type: string
    indexed: true                     # Indicates indexed keys (0, 1, 2...)
```

### Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique plugin identifier, must match folder name |
| `name` | Yes | Display name for dashboard |
| `version` | Yes | Semantic version string |
| `description` | No | Brief description |
| `dependencies` | No | Array of plugin IDs that must run before this one |
| `config` | No | Configuration schema for dashboard UI |
| `schema` | No | Metadata keys written by this plugin (for editor) |

### Config Field Types

```yaml
config:
  fieldName:
    type: string | number | boolean | select
    label: Display Label
    required: true | false            # Default: false
    default: <value>                  # Default value
    secret: true | false              # Mask in UI (default: false)
    options:                          # For type: select
      - value: opt1
        label: Option 1
      - value: opt2
        label: Option 2
```

## Plugin Interface

Plugins export a default object implementing the `Plugin` interface.

```typescript
// types.ts

export interface Plugin {
  /**
   * Called once when the plugin is loaded at startup.
   * Use for one-time initialization.
   */
  onLoad?(ctx: PluginLifecycleContext): Promise<void>;

  /**
   * Called when the plugin is activated.
   * Triggered at startup (if previously active) or from dashboard.
   */
  onActivate?(ctx: PluginLifecycleContext): Promise<void>;

  /**
   * Called when the plugin is deactivated from the dashboard.
   * Use for cleanup, releasing resources.
   */
  onDeactivate?(ctx: PluginLifecycleContext): Promise<void>;

  /**
   * Called when the plugin is unloaded at shutdown.
   */
  onUnload?(ctx: PluginLifecycleContext): Promise<void>;

  /**
   * Process a single file. Called for each file in the library.
   * Must be implemented by all plugins.
   */
  process(ctx: PluginContext): Promise<void>;
}

export interface PluginLifecycleContext {
  /** Plugin configuration from plugins.json */
  config: Record<string, unknown>;

  /** Absolute path to plugin's cache directory */
  cacheDir: string;

  /** Scoped logger */
  log: PluginLogger;
}
```

## Plugin Context

The `PluginContext` is injected into the `process()` function, providing access to file metadata and utilities.

```typescript
export interface PluginContext {
  /**
   * Key-value storage for the current file's metadata.
   * Keys use path notation: "video/codec", "audio/0/language"
   */
  kv: PluginKVStore;

  /** Absolute path to the file being processed */
  filePath: string;

  /** Plugin configuration values */
  config: Record<string, unknown>;

  /** Absolute path to plugin's cache directory */
  cacheDir: string;

  /** Cache utilities for persistent storage */
  cache: PluginCache;

  /** Scoped logger (prefixed with plugin name) */
  log: PluginLogger;
}
```

### KV Store Interface

```typescript
export interface PluginKVStore {
  /**
   * Get a value by key.
   * @param key Path-style key, e.g., "video/codec" or "audio/0/language"
   */
  get(key: string): string | undefined;

  /**
   * Set a value. Only string values are supported.
   * @param key Path-style key
   * @param value String value
   */
  set(key: string, value: string): void;

  /**
   * Delete a key.
   */
  delete(key: string): void;

  /**
   * Get all keys, optionally filtered by prefix.
   * @param prefix Optional prefix filter, e.g., "audio/" returns ["audio/0/codec", "audio/0/language", ...]
   */
  keys(prefix?: string): string[];

  /**
   * Get all key-value pairs, optionally filtered by prefix.
   */
  entries(prefix?: string): Array<[string, string]>;
}
```

### Cache Interface

```typescript
export interface PluginCache {
  /**
   * Get full path for a cache file.
   * @param filename Relative filename within cache directory
   */
  getPath(filename: string): string;

  /**
   * Read and parse a JSON cache file.
   * @returns Parsed data or null if not found
   */
  readJson<T>(filename: string): Promise<T | null>;

  /**
   * Write data as JSON to cache file.
   */
  writeJson(filename: string, data: unknown): Promise<void>;

  /**
   * Check if a cache file exists.
   */
  exists(filename: string): Promise<boolean>;

  /**
   * Delete a cache file.
   */
  delete(filename: string): Promise<void>;

  /**
   * Clear all files in the plugin's cache directory.
   */
  clear(): Promise<void>;
}
```

### Logger Interface

```typescript
export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
```

## Plugin Implementation Example

```typescript
// plugins/tmdb/index.ts
import type { Plugin, PluginContext, PluginLifecycleContext } from '../../src/plugin/types';

interface TmdbConfig {
  apiKey: string;
  language: string;
  includeAdult: boolean;
}

const plugin: Plugin = {
  async onLoad(ctx: PluginLifecycleContext) {
    ctx.log.info('TMDB plugin loaded');
  },

  async onActivate(ctx: PluginLifecycleContext) {
    const config = ctx.config as TmdbConfig;
    if (!config.apiKey) {
      ctx.log.warn('No API key configured, plugin will skip processing');
    }
  },

  async onDeactivate(ctx: PluginLifecycleContext) {
    ctx.log.info('TMDB plugin deactivated');
  },

  async process(ctx: PluginContext) {
    const config = ctx.config as TmdbConfig;

    // Skip if not configured
    if (!config.apiKey) return;

    // Get data from previous plugins
    const title = ctx.kv.get('filename/title');
    const year = ctx.kv.get('filename/year');
    const videoType = ctx.kv.get('video/type');

    if (!title) return;

    // Check cache first (keyed by title+year)
    const cacheKey = `${sanitize(title)}-${year || 'unknown'}.json`;
    const cached = await ctx.cache.readJson<TmdbResult>(cacheKey);

    if (cached) {
      applyResult(ctx.kv, cached);
      return;
    }

    // Fetch from TMDB API
    try {
      const result = await fetchTmdb(title, year, videoType, config);
      if (result) {
        await ctx.cache.writeJson(cacheKey, result);
        applyResult(ctx.kv, result);
      }
    } catch (error) {
      ctx.log.error('TMDB fetch failed', error);
    }
  }
};

function applyResult(kv: PluginContext['kv'], result: TmdbResult) {
  kv.set('tmdb/id', String(result.id));
  kv.set('tmdb/title', result.title);
  kv.set('tmdb/overview', result.overview);
  kv.set('tmdb/poster', result.poster_path);
  kv.set('tmdb/backdrop', result.backdrop_path);
  kv.set('tmdb/rating', String(result.vote_average));
  kv.set('tmdb/year', result.release_date?.slice(0, 4) || '');

  // Genres as indexed keys
  result.genres?.forEach((genre, i) => {
    kv.set(`tmdb/genre/${i}`, genre.name);
  });
}

export default plugin;
```

## Metadata Key Format

All metadata is stored as flat key-value pairs with string values only. Keys use path notation with `/` as separator.

### Key Naming Convention

```
{plugin-id}/{field}                   # Simple field
{plugin-id}/{group}/{field}           # Grouped field
{plugin-id}/{group}/{index}/{field}   # Indexed field (for lists)
```

### Examples

```
# File info plugin
file/name                             = "Movie.2024.1080p.mkv"
file/size                             = "4294967296"
file/type                             = "video"
file/mime                             = "video/x-matroska"

# FFmpeg plugin
video/codec                           = "h264"
video/width                           = "1920"
video/height                          = "1080"
video/duration                        = "7200.5"
video/bitrate                         = "8000000"
audio/0/codec                         = "aac"
audio/0/language                      = "eng"
audio/0/channels                      = "6"
audio/1/codec                         = "dts"
audio/1/language                      = "fra"
audio/1/channels                      = "6"
subtitle/0/language                   = "eng"
subtitle/0/format                     = "subrip"
subtitle/1/language                   = "fra"
subtitle/1/format                     = "subrip"

# Filename parser plugin
filename/title                        = "Movie Title"
filename/year                         = "2024"
filename/quality                      = "1080p"
filename/source                       = "bluray"

# TMDB plugin
tmdb/id                               = "12345"
tmdb/title                            = "Movie Title"
tmdb/overview                         = "A movie about..."
tmdb/poster                           = "/path/to/poster.jpg"
tmdb/genre/0                          = "Action"
tmdb/genre/1                          = "Adventure"
```

### Key Constraints

- Keys must be non-empty strings
- Keys use `/` as path separator
- Values must be strings (numbers converted via `String()`)
- No nested objects or arrays (use indexed keys instead)
- Keys are case-sensitive
- Recommended: use lowercase with hyphens for multi-word keys

## Plugin Manager

The `PluginManager` handles plugin lifecycle and orchestration.

```typescript
export class PluginManager extends EventEmitter {
  /**
   * Scan plugins directory and load manifests.
   * Called once at startup.
   */
  async scanPlugins(): Promise<PluginInfo[]>;

  /**
   * Load all plugins and activate those marked active in state.
   * Called once at startup after scanning.
   */
  async loadAll(): Promise<void>;

  /**
   * Activate a plugin (hot, no restart required).
   * Calls plugin.onActivate(), rebuilds execution order, saves state.
   * Emits 'plugin:activated' event.
   */
  async activate(pluginId: string): Promise<void>;

  /**
   * Deactivate a plugin (hot, no restart required).
   * Calls plugin.onDeactivate(), rebuilds execution order, saves state.
   * Emits 'plugin:deactivated' event.
   */
  async deactivate(pluginId: string): Promise<void>;

  /**
   * Update plugin configuration.
   * Saves to plugins.json.
   * Emits 'plugin:config-changed' event.
   */
  async updateConfig(pluginId: string, config: Record<string, unknown>): Promise<void>;

  /**
   * Clear a plugin's cache directory.
   */
  async clearCache(pluginId: string): Promise<void>;

  /**
   * Get all discovered plugins.
   */
  getPlugins(): PluginInfo[];

  /**
   * Get only active plugins.
   */
  getActivePlugins(): PluginInfo[];

  /**
   * Get execution order (dependency-sorted active plugin IDs).
   */
  getExecutionOrder(): string[];

  /**
   * Process a file through all active plugins.
   */
  async processFile(filePath: string, kv: KVStore): Promise<ProcessingResult>;

  /**
   * Shutdown: deactivate and unload all plugins.
   */
  async shutdown(): Promise<void>;
}
```

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `plugin:activated` | `{ pluginId: string }` | Plugin was activated |
| `plugin:deactivated` | `{ pluginId: string }` | Plugin was deactivated |
| `plugin:config-changed` | `{ pluginId: string, config: object }` | Plugin config updated |
| `plugin:error` | `{ pluginId: string, error: Error }` | Plugin error occurred |

### Plugin Info

```typescript
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  dependencies: string[];
  active: boolean;
  config: Record<string, unknown>;
  configSchema?: ConfigSchema;
  metadataSchema?: MetadataSchema;
  status: 'loaded' | 'error' | 'unloaded';
  error?: string;
}
```

## State Management

Plugin state is persisted in `plugins.json` located in the meta-sort-core package root.

```json
{
  "plugins": {
    "file-info": {
      "active": true,
      "config": {}
    },
    "ffmpeg": {
      "active": true,
      "config": {}
    },
    "tmdb": {
      "active": true,
      "config": {
        "apiKey": "your-api-key",
        "language": "en-US",
        "includeAdult": false
      }
    },
    "custom-plugin": {
      "active": false,
      "config": {}
    }
  }
}
```

### State Behavior

- **New plugins**: Discovered plugins not in state file are added with `active: false`
- **Removed plugins**: Plugins in state but not on disk are kept (preserves config for reinstall)
- **Config merge**: Default values from manifest are merged with saved config
- **Persistence**: State is saved immediately on any change

## Execution Pipeline

### Startup Sequence

```
1. PluginManager.scanPlugins()
   └── Scan plugins/ directory
   └── Parse each manifest.yml
   └── Validate manifest structure

2. PluginManager.loadAll()
   └── Load plugins.json state
   └── For each discovered plugin:
       ├── Dynamic import(plugin/index.js)
       ├── Validate Plugin interface
       ├── Call plugin.onLoad()
       └── If active in state:
           └── Call plugin.onActivate()
   └── Resolve execution order (topological sort)
```

### File Processing Sequence

```
1. Create KVStore for file

2. For each active plugin (in dependency order):
   ├── Create PluginContext
   ├── Start timing
   ├── try:
   │   └── await plugin.process(ctx)
   └── catch:
       └── Log error, continue to next plugin

3. Persist KV to Redis
```

### Activation Sequence (Hot)

```
1. PluginManager.activate(pluginId)
   ├── Validate plugin exists and is loaded
   ├── Check dependencies are active
   ├── Call plugin.onActivate()
   ├── Mark as active in memory
   ├── Rebuild execution order
   ├── Save plugins.json
   └── Emit 'plugin:activated' event

2. Caller receives event
   └── Trigger library rescan
```

### Deactivation Sequence (Hot)

```
1. PluginManager.deactivate(pluginId)
   ├── Check no active plugins depend on this one
   ├── Call plugin.onDeactivate()
   ├── Mark as inactive in memory
   ├── Rebuild execution order
   ├── Save plugins.json
   └── Emit 'plugin:deactivated' event

2. Caller receives event
   └── Trigger library rescan

Note: Metadata written by the plugin remains in Redis.
      A separate "clean metadata" feature can remove orphaned keys.
```

## Dependency Resolution

Plugins declare dependencies in their manifest. The system performs topological sort to determine execution order.

### Rules

1. A plugin cannot be activated if any of its dependencies are inactive
2. A plugin cannot be deactivated if any active plugin depends on it
3. Circular dependencies are detected and rejected at load time
4. Missing dependencies are logged as warnings; plugin can still load but may fail

### Example

```yaml
# filename-parser depends on file-info
# tmdb depends on filename-parser
# anime-detector depends on filename-parser

Resolved order: file-info → filename-parser → [tmdb, anime-detector]
```

Plugins at the same dependency level may execute in any order (or parallel in future).

## REST API

The plugin system exposes REST endpoints for dashboard integration.

### Endpoints

```
GET    /api/plugins                   # List all plugins
GET    /api/plugins/:id               # Get plugin details
POST   /api/plugins/:id/activate      # Activate plugin
POST   /api/plugins/:id/deactivate    # Deactivate plugin
PUT    /api/plugins/:id/config        # Update plugin config
DELETE /api/plugins/:id/cache         # Clear plugin cache
GET    /api/plugins/:id/schema        # Get metadata schema (for editor)
```

### Response Format

```typescript
// GET /api/plugins
interface PluginsResponse {
  plugins: PluginInfo[];
  executionOrder: string[];
}

// POST /api/plugins/:id/activate
interface ActivateResponse {
  success: boolean;
  error?: string;                     # e.g., "Dependency 'x' is not active"
}

// PUT /api/plugins/:id/config
interface ConfigUpdateRequest {
  config: Record<string, unknown>;
}
```

## Error Handling

### Plugin Load Errors

- Invalid manifest: Plugin marked as `status: 'error'`, logged, skipped
- Import failure: Plugin marked as `status: 'error'`, logged, skipped
- Missing dependencies: Warning logged, plugin can load but activation may fail

### Plugin Execution Errors

- Errors in `process()` are caught, logged, and execution continues to next plugin
- The file's metadata from previous plugins is preserved
- Error count is tracked per plugin for monitoring

### Lifecycle Hook Errors

- Errors in `onActivate()` prevent activation, error returned to caller
- Errors in `onDeactivate()` are logged but deactivation proceeds
- Errors in `onLoad()`/`onUnload()` are logged, plugin marked as error state

## Future Considerations

### Metadata Cleanup

A future feature will allow cleaning metadata keys written by a specific plugin:

```typescript
// Future API
await pluginManager.cleanMetadata(pluginId);
// Removes all keys matching "{pluginId}/*" from Redis
```

### Parallel Execution

Plugins at the same dependency level could execute in parallel:

```typescript
// Future: parallel execution of independent plugins
const level1 = ['file-info'];
const level2 = ['ffmpeg', 'filename-parser'];  // parallel
const level3 = ['tmdb', 'anime-detector'];     // parallel
```

### Plugin Hot Reload

Reloading a plugin's code without full restart (for development):

```typescript
// Future API
await pluginManager.reload(pluginId);
// Re-imports plugin code, preserves state
```
