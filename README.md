# meta-sort

File-watcher and metadata-extraction service for the MetaMesh ecosystem.
meta-sort consumes file events from meta-core (over SSE), drives metadata
through a streaming pipeline + container plugins, and writes results back
to Redis through meta-core's API. It exposes a Fastify REST API and serves
the `/files` volume over WebDAV so that other services and plugin
containers can read media without mounting the same volume.

> **Service role:** meta-sort is **Redis-consuming**, not Redis-managing.
> It does not run leader election, it does not spawn Redis, and it does
> not own `kv-leader.lock`. Those responsibilities belong to **meta-core**
> (a separate Go service). meta-sort reads
> `/meta-core/locks/kv-leader.info` via `LeaderClient` to discover the
> Redis URL, API URL, and WebDAV URLs, and registers its own URLs into
> `/meta-core/services/<hostname>.json`.

---

## Overview

What this service does:

1. **Subscribes** to meta-core's `/api/events/files` SSE stream (file
   discovery events: `add`, `change`, `delete`, `rename`, `reset`).
2. **Drives the streaming pipeline** (`StreamingPipeline`): extension
   filter → light phase (filename parse, basic stats, midhash256) → write
   to Redis → dispatch container plugins → background phase (SHA-256).
3. **Manages container plugins**: spawns plugin containers via the Docker
   socket, exposes a callback endpoint, lets plugins write metadata back
   into Redis via the meta-core-compatible `/meta/*` API on this service.
4. **Serves files over WebDAV** at `/webdav/*` so container plugins and
   sibling services (meta-fuse, meta-stremio) can read media without
   needing the underlying bind/SMB/rclone mounts.

What this service does **not** do (anymore):

- It does not run leader election.
- It does not spawn or supervise Redis.
- It does not watch the filesystem directly (chokidar lives in meta-core).
- It does not manage remote mounts (mounts are now in meta-core / rclone-smb).
- It does not have an in-process plugin runtime — all plugins are
  containerized.
- `/api/scan/trigger` and `/api/metadata/clear` no longer live here; use
  meta-core's endpoints instead.

---

## Architecture

### Two-volume layout

meta-sort consumes two host-side volumes via standard bind mounts:

| Volume | Container path | Owner | Purpose |
|--------|----------------|-------|---------|
| `META_CORE_VOLUME` | `/meta-core` | meta-core writes, all services read | Leader-info file, Redis data, service registry, SSE cursor |
| `FILES_VOLUME`     | `/files`     | meta-sort serves over WebDAV       | Watched media, plugin output, dynamic mounts |

File paths stored in Redis are **relative to `/files`**, which makes the
storage portable across hosts. See the root `CLAUDE.md` for the
authoritative volume layout description.

### Leader discovery (read-only)

```
meta-core (separate container)
   ├── runs Redis
   ├── runs file watcher (chokidar) and publishes file:events
   ├── runs HTTP API on /api/urls, /api/events/files, /meta/*, /api/services, ...
   └── writes /meta-core/locks/kv-leader.info
                       │
                       ▼
              meta-sort (this service)
              ├── LeaderClient reads kv-leader.info → Redis URL, API URL,
              │   WebDAV URLs, etc.
              ├── KVManager creates RedisKVClient (writes are routed
              │   through meta-core's HTTP API for the api-mediated-access
              │   model)
              ├── ServiceRegistration writes
              │   /meta-core/services/meta-sort-<hostname>.json
              └── FileEventConsumer subscribes to
                  ${apiUrl}/api/events/files (SSE)
```

Source: `packages/meta-sort-core/src/kv/{KVManager,LeaderClient,RedisClient,ServiceRegistration}.ts`,
`packages/meta-sort-core/src/events/{FileEventConsumer,SSEEventClient}.ts`.

### Processing pipeline

```
meta-core SSE  ─►  FileEventConsumer  ─►  StreamingPipeline
                                                │
                                                ├─ validationQueue (extension filter)
                                                │
                                                ├─ fastQueue
                                                │     processLightPhase:
                                                │       midhash256 (permanent ID)
                                                │       basic metadata
                                                │       write to Redis  ───►  file visible in VFS
                                                │       dispatchAllPlugins (containers)
                                                │
                                                └─ backgroundQueue
                                                      processHashPhase:
                                                        SHA-256, heavier hashes
                                                      await ContainerPluginScheduler
                                                      file:complete  ───►  DONE
```

`midhash256` is the **permanent** file identifier — there is no `tempId`
and no rename step when SHA-256 finishes. Full details in
[`docs/streaming-pipeline-architecture.md`](docs/streaming-pipeline-architecture.md).

### Container plugins

All plugins run as separate Docker containers. meta-sort orchestrates
them via the Docker socket and a callback endpoint:

- **Built-in plugins** (each is a separate git submodule under
  `packages/plugins/metamesh-plugin-*` at the repo root): `file-info`,
  `ffmpeg`, `filename-parser`, `jellyfin-nfo`, `tmdb`, `anime-detector`,
  `language`, `subtitle`, `subtitle-extractor`, `torrent`, `fullhash`.
- **Dispatch:** `ContainerPluginScheduler.dispatchAllPlugins(hashId,
  filePath, metaFlat)` — fire-and-forget. The scheduler keeps its own
  fast / background queues based on each plugin manifest's
  `defaultQueue`.
- **Plugin → meta-sort:** plugins POST results to
  `/api/plugins/callback`, and they can read/write Redis metadata
  through the meta-core-compatible `/meta/:hash` routes that meta-sort
  also exposes (so plugins only need one HTTP target).
- **Plugins access files** by hitting meta-sort's WebDAV
  (`http://metasort-app/webdav/...` inside the docker network).

For the plugin HTTP contract, see
[`docs/containerized-plugin-architecture.md`](docs/containerized-plugin-architecture.md)
and [`docs/plugin-task-queue-architecture.md`](docs/plugin-task-queue-architecture.md).

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `META_CORE_PATH` | `/meta-core` | Mount of META_CORE_VOLUME. Required — startup fails fast if absent. |
| `FILES_PATH` | `/files` | Mount of FILES_VOLUME. |
| `CACHE_FOLDER_PATH` | `/data/cache` | Local cache root. |
| `SERVICE_NAME` | `meta-sort` | Identifier used for service registration. |
| `SERVICE_VERSION` | `1.0.0` | Recorded in the service registry. |
| `FUSE_API_PORT` | `3000` | HTTP API port (legacy name; this is the Fastify API). |
| `FUSE_API_HOST` | `0.0.0.0` | API bind host. |
| `BASE_URL` | — | External base URL recorded in service registration. |
| `ADVERTISE_HOST` | — | Hostname to advertise to other services. Falls back to auto-detected IP. |
| `MAX_WORKER_THREADS` | `os.cpus().length` | If set, overrides all pipeline concurrencies to `(M*2, M, M)`. |
| `FAST_QUEUE_CONCURRENCY` | `32` | Container-plugin fast queue concurrency (see plugin-task-queue-architecture.md). |
| `FILE_LIGHT_SLOTS` | `16` | Max files concurrently in the light phase. |
| `FILE_BG_SLOTS` | `16` | Max files concurrently in the background phase. |
| `METADATA_FORMATS` | `meta` | Comma-separated list. `meta` = `.meta` YAML files; `jellyfin` = `.nfo` XML; empty disables sidecar generation. |
| `CONTAINER_PLUGINS_CONFIG` | `/app/plugins.yml` | Path to plugin manifest YAML. If missing, container plugins are skipped. |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | Docker socket for container management. |
| `CONTAINER_CALLBACK_URL` | `http://meta-sort:8180` | URL plugins POST callbacks to. |
| `CONTAINER_META_CORE_URL` | `http://meta-sort` | URL plugins use for meta-core-compatible `/meta/*` routes (served by meta-sort itself for now). |
| `CONTAINER_NETWORK` | `meta-network` | Docker network to attach plugin containers to. |
| `PLUGIN_STACK_NAME` | — | Docker Compose project label so plugin containers group together in Docker Desktop. |
| `PLUGIN_CACHE_HOST_PATH` | — | Host path bind-mounted into each plugin for persistent caches. |

Source of truth: `packages/meta-sort-core/src/config/EnvConfig.ts`.

The Redis URL and WebDAV URLs are **not** configured via environment
variables — meta-sort discovers them from `kv-leader.info` (or its
in-memory equivalent fetched through meta-core's `/api/urls`).

### Concurrency defaults

Computed in `src/index.ts` at startup:

```
cpuCount = os.cpus().length
defaultBackgroundWorkers = max(1, floor(cpuCount / 2))

validationConcurrency = MAX_WORKER_THREADS ? M*2 : cpuCount * 2
fastQueueConcurrency  = MAX_WORKER_THREADS ?? cpuCount
backgroundQueueConcurrency = MAX_WORKER_THREADS ?? defaultBackgroundWorkers
```

The pipeline logs the chosen values at startup — check container logs if
you need to know what was selected.

### Plugin configuration

Container plugins are described in `dev/config/plugins.yml` (copy from
`plugins.yml.example`). Plugin runtime config (API keys, language, etc.)
is set through meta-sort's REST API, **not** in YAML. See the root
`CLAUDE.md` "Plugin Development" section for examples.

---

## REST API

Defined in `packages/meta-sort-core/src/api/UnifiedAPIServer.ts`.

### Health

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness check. |
| `GET /api/health` | Liveness + KV connectivity. |
| `GET /meta-health` | meta-core-compatible health probe. |

### Processing

| Endpoint | Description |
|----------|-------------|
| `GET /api/processing/status` | Counters + state-manager snapshot. |
| `GET /api/processing/queue`  | Per-queue depths (validation / fast / background). |
| `GET /api/processing/failed` | Failed-file roster. |
| `POST /api/processing/retry` | Retry a single failed file (`{ filePath }`). |
| `POST /api/processing/retry-all` | Retry every failed file. |
| `POST /api/processing/wait-empty` | Block until queues drain (with optional `timeout` query). |

> Note: `/api/scan/trigger` and `/api/metadata/clear` were removed —
> they now live on **meta-core**. The `setupScanRoutes()` method in the
> source is intentionally a no-op left as a marker.

### Plugins

| Endpoint | Description |
|----------|-------------|
| `GET /api/plugins` | Discovered plugins (manifest + status + execution order). |
| `GET /api/plugins/timings` | Plugin processing-time stats. |
| `POST /api/plugins/:pluginId/activate` | Activate a plugin. |
| `POST /api/plugins/:pluginId/deactivate` | Deactivate a plugin. |
| `PUT /api/plugins/:pluginId/config` | Set runtime config (e.g. `{ apiKey: "..." }`). |
| `POST /api/plugins/:pluginId/clear-cache` | Clear a single plugin's cache. |
| `POST /api/plugins/clear-cache` | Clear every plugin's cache. |
| `POST /api/plugins/rescan` | Re-scan plugin manifests. |
| `POST /api/plugins/:pluginId/recompute` | Recompute this plugin for all files. |
| `POST /api/plugins/callback` | Container plugin task-complete callback (used by plugins, not humans). |
| `GET /api/plugins/containers` | Container-plugin status (health, instances, queue depths). |
| `GET /api/plugins/containers/:pluginId/manifest` | Plugin manifest. |
| `POST /api/plugins/containers/:pluginId/restart` | Restart instances. |
| `POST /api/plugins/containers/restart-all` | Restart all. |
| `POST /api/plugins/containers` | Add a new plugin (image, instances, resources, config, defaultQueue). |
| `PUT /api/plugins/containers/:pluginId` | Update plugin spec. |
| `DELETE /api/plugins/containers/:pluginId` | Remove plugin. |

### Files and metadata

| Endpoint | Description |
|----------|-------------|
| `GET /api/file/download?path=...` | Download a file via the configured WebDAV backend. |
| `POST /file/cid` | Compute the CID (midhash256) for a path (`{ path }`). |
| `GET /webdav/*` (and `PUT`, `DELETE`, `MKCOL`, `PROPFIND`) | WebDAV view of `/files`. Unauthenticated. |

### meta-core-compatible KV (for container plugins)

These mirror meta-core's `/meta/*` so plugin containers can talk to a
single host. They are only registered when the KV client is up.

| Endpoint | Description |
|----------|-------------|
| `GET /meta/:hash` | All metadata for a file. |
| `GET /meta/:hash/*` | Single property. |
| `PUT /meta/:hash/*` | Set single property (`{ value }`). |
| `DELETE /meta/:hash/*` | Delete single property. |
| `PATCH /meta/:hash` | Merge partial metadata. |
| `POST /meta/:hash/_add/:key` | Append to a comma-separated set field. |

### Other

| Endpoint | Description |
|----------|-------------|
| `GET /api/metrics` | Performance metrics. |
| `GET /api/stats` | Redis stats summary (only when KV is up). |
| `GET /api/services` | Proxy to meta-core's `/api/services` via the LeaderClient. |

---

## Operations

### Dev URLs

- Behind Caddy (auth enforced, self-signed cert):
  `https://metasort-dev.localhost:8180`
- Debug-direct backend (no auth, no TLS): `http://localhost:18180`
- Container name (backend): `metasort-app`
- Container name (hash-lock proxy): `metasort`

### Logs

```bash
docker compose -f dev/docker-compose.yml logs -f metasort-app
docker exec metasort-app supervisorctl status
```

### Reload after a code change

Use the reload script (in-container build via supervisord). Do **not**
`docker restart metasort-app`.

```bash
cd dev
./scripts/reload-meta-sort.sh            # full rebuild
./scripts/reload-meta-sort.sh --backend  # backend only
./scripts/reload-meta-sort.sh --ui       # UI only
./scripts/reload-meta-sort.sh --no-deps  # skip dependency rebuild
```

### Running tests

```bash
docker exec meta-test-runner /app/test/test.sh sort
```

See the root `CLAUDE.md` "Running Tests" section for the full matrix.

---

## Package layout

This service is a nested pnpm workspace. Top-level structure:

```
packages/meta-sort/
├── Dockerfile
├── docker/                       # nginx, redis (legacy), supervisord configs
│   ├── nginx.conf
│   ├── redis.conf
│   └── supervisord.conf
├── docs/                         # See "Further reading" below
├── package.json                  # Nested workspace root
├── packages/
│   ├── meta-sort-core/           # @meta-sort/core - main service
│   │   ├── src/
│   │   │   ├── api/              # UnifiedAPIServer.ts (Fastify)
│   │   │   ├── config/           # EnvConfig.ts, SupportedFileTypes.ts
│   │   │   ├── container-plugins/# ContainerManager, ContainerPluginScheduler, ...
│   │   │   ├── events/           # FileEventConsumer, SSEEventClient
│   │   │   ├── jellyfin/         # Jellyfin / NFO output helpers
│   │   │   ├── kv/               # KVManager, LeaderClient, RedisClient
│   │   │   ├── logic/            # StreamingPipeline, state managers, fileProcessor
│   │   │   ├── metrics/          # PerformanceMetrics
│   │   │   ├── plugin-engine/    # Vestigial in-process types + TaskScheduler glue
│   │   │   ├── types/            # Shared TypeScript types
│   │   │   ├── utils/            # Utilities
│   │   │   ├── webdav/           # WebDAV client + endpoint configuration
│   │   │   └── index.ts          # Entry point
│   │   └── package.json
│   ├── meta-sort-ui/             # @meta-sort/ui - React dashboard (Vite)
│   ├── meta-sort-editor/         # Metadata editor UI (Vite)
│   ├── async-utils/              # @worph/async-utils - MultiQueue, etc.
│   └── shared/                   # Symlinks to filename-tool, meta-hash, meta-interface
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

> Built-in container plugins **do not live here.** They live at the
> repo root as separate submodules:
> `packages/plugins/metamesh-plugin-{file-info,ffmpeg,filename-parser,jellyfin-nfo,tmdb,anime-detector,language,subtitle,subtitle-extractor,torrent,fullhash}`.

### Key components

| Component | File | Purpose |
|-----------|------|---------|
| Entry point | `src/index.ts` | Wires KVManager → API server → plugin manager → ContainerManager → StreamingPipeline → FileEventConsumer. |
| Streaming pipeline | `src/logic/pipeline/StreamingPipeline.ts` | 3-queue (validation / fast / background) orchestrator. |
| State manager | `src/logic/UnifiedProcessingStateManager.ts` | Tracks `discovered → lightProcessing → hashProcessing → done`. |
| File processor | `src/logic/WatchedFileProcessor.ts` | Light + hash phase implementation. |
| SSE consumer | `src/events/FileEventConsumer.ts` | Translates meta-core events into pipeline calls. |
| SSE transport | `src/events/SSEEventClient.ts` | Long-lived HTTP SSE with cursor persistence. |
| KV manager | `src/kv/KVManager.ts` | Bootstraps RedisKVClient + ServiceRegistration from LeaderClient. |
| Leader client | `src/kv/LeaderClient.ts` | Reads `/meta-core/locks/kv-leader.info`, fetches `/api/urls`. |
| Container manager | `src/container-plugins/ContainerManager.ts` | Docker socket orchestration. |
| Container scheduler | `src/container-plugins/ContainerPluginScheduler.ts` | Plugin fast/background queues + callbacks. |
| API server | `src/api/UnifiedAPIServer.ts` | Fastify REST + WebDAV-facing meta routes. |
| Config | `src/config/EnvConfig.ts` | Environment variable parsing. |

---

## Further reading

In this directory:

- [`docs/streaming-pipeline-architecture.md`](docs/streaming-pipeline-architecture.md) — pipeline internals.
- [`docs/containerized-plugin-architecture.md`](docs/containerized-plugin-architecture.md) — current plugin design.
- [`docs/plugin-task-queue-architecture.md`](docs/plugin-task-queue-architecture.md) — fast/background queue scheduling for plugin tasks.
- [`docs/plugin-system.md`](docs/plugin-system.md) — pointer to current docs (the in-process plugin system is gone).
- [`docs/fast-hash-global-id.md`](docs/fast-hash-global-id.md) — midhash256 / fast hash design.

Repo-level docs of interest:

- Root `CLAUDE.md` — authoritative ground truth on the dev stack, ports,
  containers, and operational commands.
- `/METADATA_KEYS.md` — schema for the `/file/{cid}` Redis hash.
- `packages/meta-core/docs/` — leader election and Redis storage owner.

## License

MIT — see LICENSE.
