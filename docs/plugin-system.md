# Plugin System (Deprecated — See Container Plugins)

> **This document is a historical pointer.** The in-process plugin system it
> originally described — `plugins/<id>/{manifest.yml,index.ts}` directories
> loaded via dynamic `import()` inside meta-sort-core — has been removed.
> All plugins now run as Docker containers and communicate over HTTP.

For the current design, read:

- **[containerized-plugin-architecture.md](./containerized-plugin-architecture.md)** — full container plugin design (HTTP contract, lifecycle, callbacks, KV access).
- **[plugin-task-queue-architecture.md](./plugin-task-queue-architecture.md)** — how plugin work is dispatched across the fast / background queues.
- Root **`CLAUDE.md`** (`Plugin Development` and `Runtime Plugin Configuration` sections) — operational quickstart.
- Plugin sources at **`packages/plugins/metamesh-plugin-*`** (separate submodules) — `file-info`, `ffmpeg`, `filename-parser`, `jellyfin-nfo`, `tmdb`, `anime-detector`, `language`, `subtitle`, `subtitle-extractor`, `torrent`, `fullhash`.

## What survived from the old design

The `Plugin` / `PluginContext` / `PluginLifecycleContext` / `PluginKVStore`
interfaces in `src/plugin-engine/types.ts` are still exported, but the
container-only `PluginManager` (`src/plugin-engine/PluginManager.ts`) never
constructs an in-process `Plugin` instance — manifests, lifecycle, and
execution are owned by `ContainerManager` and `ContainerPluginScheduler`
under `src/container-plugins/`. Treat the `Plugin`-interface types as
vestigial and do not write new code against them.

## Why the change

| Limitation of in-process plugins | Container model |
|----------------------------------|-----------------|
| Heavy native deps (FFmpeg, Whisper, ML libs) inflated the meta-sort image | Each plugin ships its own image |
| All plugins had to be TypeScript / Node | Any language with an HTTP server |
| A crashing plugin took down meta-sort | Plugin crashes are isolated; meta-sort restarts the container |
| Plugin updates required redeploying meta-sort | Plugins are versioned and pulled independently |

See `containerized-plugin-architecture.md` for the migration rationale and
the HTTP contract container plugins must implement.
