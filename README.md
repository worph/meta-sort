# meta-sort

File-watcher and metadata-extraction service for the MetaMesh ecosystem.
meta-sort consumes file events from meta-core (over SSE), drives metadata
through a streaming pipeline + container plugins, and writes results back
to Redis through meta-core's HTTP API. It exposes a Fastify REST API and
reads media exclusively over **meta-core's WebDAV** — it mounts neither
`/meta-core` nor `/files`.

> **Service role:** meta-sort is **Redis-consuming**, not Redis-managing.
> It does not run leader election, it does not spawn Redis, and it has
> no direct Redis connection: every read and write goes through
> **meta-core** (a separate Go service) over HTTP. meta-sort locates
> meta-core over UDP multicast (**beacon v2**,
> `239.255.99.1:9099`) — meta-core's announce carries its API and WebDAV
> URLs — and announces itself on the same group so sibling dashboards can
> list it. `META_CORE_URL` pins meta-core and disables wire selection.

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
4. **Computes file identity**: `midhash256` in the light phase, full-file
   digests (sha1, sha256, md5, sha3, crc32, btih v2) in the background
   phase. Digests are persisted only as the bare-CID key-set
   (`cids/<cid>`), never as per-algorithm `cid_*` fields
   (`src/config/TargetHash.ts`, `src/kv/MetaCoreApiWriter.ts`).

What this service does **not** do (anymore):

- It does not run leader election.
- It does not spawn or supervise Redis, nor talk to it directly.
- It does not serve WebDAV — files are read from meta-core's WebDAV, and
  plugin containers get that same URL (`WEBDAV_URL`).
- It does not watch the filesystem directly (chokidar lives in meta-core).
- It does not manage remote mounts (mounts are now in meta-core / rclone-smb).
- It does not have an in-process plugin runtime — all plugins are
  containerized.
- `/api/scan/trigger` and `/api/metadata/clear` no longer live here; use
  meta-core's endpoints instead.

---

## Architecture

### Volumes

meta-sort needs **no shared volume**. Media lives on meta-core's
`FILES_VOLUME` and is read over meta-core's WebDAV; file paths stored in
Redis are **relative to `/files`**, which keeps storage portable across
hosts. The only mounts are its own cache (`/data/cache`), the Docker
socket (for plugin containers) and `plugins.yml`.

### Locating meta-core (beacon v2)

```
meta-core (separate container)
   ├── runs Redis, the file watcher, and the WebDAV server for /files
   ├── HTTP API: /urls, /api/events/files (SSE), /meta/*, ...
   └── advertises metamesh.core on 239.255.99.1:9099 (UDP multicast),
       carrying its /urls payload (apiUrl, webdavUrl, webdavUrlInternal)
                       │
                       ▼
              meta-sort (this service)
              ├── LeaderClient → MetaCoreLocator (src/discovery/meshdisco.ts)
              │   picks up the core announce (or GET {META_CORE_URL}/urls
              │   when pinned) and announces meta-sort on the same group
              ├── KVManager builds an HTTP-only RedisKVClient against
              │   meta-core's API and configures the WebDAV client
              ├── GET /api/neighbors serves the UDP neighbour map (nav menu)
              └── FileEventConsumer subscribes to
                  ${apiUrl}/api/events/files (SSE)
```

Source: `packages/meta-sort-core/src/discovery/meshdisco.ts`,
`packages/meta-sort-core/src/kv/{KVManager,LeaderClient,RedisClient,MetaCoreApiWriter}.ts`,
`packages/meta-sort-core/src/events/{FileEventConsumer,SSEEventClient}.ts`.
The protocol spec is `docs/project-architecture/beacon-v2.md` in
the meta-root. The `meshdisco.ts` port is mirrored across services and
guarded by the meta-root's `scripts/check-mirrors.sh` — change it there in
lockstep.

The SSE cursor is persisted to `/meta-core/cursors/meta-sort-files.cursor`
(`FileEventConsumer.ts` default); since `/meta-core` is no longer mounted,
that path is container-local and does not survive a container recreate.

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
  `language`, `subtitle`, `subtitle-extractor`, `still-extractor`,
  `opensubtitle`, `torrent`, `fullhash`. Which ones actually run is
  decided by `plugins.yml` — the image ships none.
- **Dispatch:** `ContainerPluginScheduler.dispatchAllPlugins(hashId,
  filePath, metaFlat)` — fire-and-forget. The scheduler keeps its own
  fast / background queues based on each plugin manifest's
  `defaultQueue`.
- **Plugin → meta-sort:** plugins POST results to
  `/api/plugins/callback`, and they can read/write Redis metadata
  through the meta-core-compatible `/meta/:hash` routes that meta-sort
  also exposes (so plugins only need one HTTP target).
- **Plugins access files** over meta-core's WebDAV: each plugin
  container is started with `WEBDAV_URL` (meta-core's
  `webdavUrlInternal`), `META_CORE_URL` (= `CONTAINER_META_CORE_URL`),
  `CALLBACK_URL` and `PLUGIN_ID` (`ContainerManager.ts`).

For the plugin HTTP contract, see
[`docs/containerized-plugin-architecture.md`](docs/containerized-plugin-architecture.md)
and [`docs/plugin-task-queue-architecture.md`](docs/plugin-task-queue-architecture.md).

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `META_CORE_URL` | — | Pins meta-core's API URL; UDP discovery then never overrides it. |
| `ENABLE_UDP_DISCOVERY` | on | `false`/`0` disables the beacon v2 announce/listen. |
| `ALLOW_LEGACY_REDIS_URL` | — | `1` downgrades the "meta-core still publishes `redisUrl`" startup error to a warning. |
| `FILES_PATH` | `/files` | Virtual root that relative paths resolve under (on meta-core's WebDAV). |
| `CACHE_FOLDER_PATH` | `/data/cache` | Local cache root. |
| `SERVICE_NAME` | `meta-sort` | Name announced on the discovery group. |
| `FUSE_API_PORT` | `3000` | HTTP API port (legacy name; this is the Fastify API). |
| `FUSE_API_HOST` | `0.0.0.0` | API bind host. |
| `PUBLIC_URL` | — | Browser-facing URL announced for neighbours' nav menus. Wins over `BASE_URL` (use it for a debug-direct port when no Caddy is in front). |
| `BASE_URL` | — | Perimeter URL announced when `PUBLIC_URL` is unset; falls back to `http://<hostname>:<FUSE_API_PORT>`. |
| `MAX_WORKER_THREADS` | `os.cpus().length` | If set, overrides all pipeline concurrencies to `(M*2, M, M)`. |
| `FAST_QUEUE_CONCURRENCY` | `32` | Container-plugin fast queue concurrency (see plugin-task-queue-architecture.md). |
| `FILE_LIGHT_SLOTS` | `16` | Max files concurrently in the light phase. |
| `FILE_BG_SLOTS` | `16` | Max files concurrently in the background phase. |
| `METADATA_FORMATS` | `meta` | Comma-separated list. `meta` = `.meta` YAML files; `jellyfin` = `.nfo` XML; empty disables sidecar generation. |
| `CONTAINER_PLUGINS_CONFIG` | `/app/plugins.yml` | Path to plugin manifest YAML. If missing, container plugins are skipped. |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | Docker socket for container management. |
| `CONTAINER_CALLBACK_URL` | `http://meta-sort:8180` | URL plugins POST callbacks to. |
| `CONTAINER_META_CORE_URL` | `http://meta-sort` | URL plugins use for meta-core-compatible `/meta/*` routes (served by meta-sort itself). The default host doesn't resolve on current stacks — dev sets `http://metasort-app` (port 80 dev nginx proxies `/meta/`), the store app `http://metasort-app:3000` (the stock nginx has no `/meta/` location). |
| `CONTAINER_NETWORK` | `meta-network` | Docker network to attach plugin containers to. |
| `PLUGIN_STACK_NAME` | — | Docker Compose project label so plugin containers group together in Docker Desktop. |
| `PLUGIN_CACHE_HOST_PATH` | — | Host path bind-mounted into each plugin for persistent caches. |

Source of truth: `packages/meta-sort-core/src/config/EnvConfig.ts` (plus
`PUBLIC_URL` in `kv/KVManager.ts` and `ENABLE_UDP_DISCOVERY` /
`ALLOW_LEGACY_REDIS_URL` in `kv/LeaderClient.ts`). `META_CORE_PATH`,
`REDIS_URL`, `ADVERTISE_HOST` and `SERVICE_VERSION` are still parsed by
`EnvConfig.ts` but nothing acts on them any more. The discovery group
defaults to the protocol endpoint (`239.255.99.1:9099`, 10 s interval);
`BEACON_GROUP` / `BEACON_PORT` / `BEACON_INTERVAL_MS` override it.

The WebDAV URLs are **not** configured via environment variables —
meta-sort takes them from meta-core's announce (or `GET /urls` when
pinned).

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
| `GET /api/plugins/containers/:pluginId/logs` | Container logs (`?instance=`, `?tail=`). |
| `POST /api/plugins/containers/:pluginId/restart` | Restart instances. |
| `POST /api/plugins/containers/:pluginId/stop` / `start` | Stop / start instances. |
| `POST /api/plugins/containers/restart-all` | Restart all. |
| `POST /api/plugins/containers` | Add a new plugin (image, instances, resources, config, defaultQueue). |
| `PUT /api/plugins/containers/:pluginId` | Update plugin spec. |
| `DELETE /api/plugins/containers/:pluginId` | Remove plugin. |

### Files and metadata

| Endpoint | Description |
|----------|-------------|
| `GET /api/file/download?path=...` | Download a file via meta-core's WebDAV. |
| `POST /file/cid` | Compute the CID (midhash256) for a path (`{ path }`). |

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
| `GET /api/stats` | File count + total size from meta-core's `/api/files/tuples` summary, cached stale-while-revalidate. |
| `GET /api/neighbors` | beacon v2 neighbour map (nav menu). Served locally — works while meta-core is down. Replaces the removed `/api/services`. |

---

## Operations

### Dev URLs

- Behind Caddy (auth enforced, self-signed cert):
  `https://metasort-dev.localhost:8180`
- Debug-direct backend (no auth, no TLS): `http://localhost:18180`
- Container name (backend): `metasort-app`
- Container name (hash-lock proxy): `metasort`
- CasaOS store app: `MetaSort` in the meta-root's `packages/MetaAppStore`
  (`ghcr.io/worph/meta-sort`, fronted by an `appshield` perimeter).

### Docker image

The repo `Dockerfile` (published to `ghcr.io/worph/meta-sort` by
`.github/workflows/docker-publish.yml`) is an all-in-one image: nginx on
`:80` → Fastify on `:3000`, rclone, and a bundled `meta-core` binary
copied from `ghcr.io/worph/meta-core` and started by
`docker/supervisord.conf`. Deployments run meta-core as its own app, so
both the dev stack and the store app mount their own supervisord/nginx
configs that drop the bundled meta-core.

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
docker exec meta-test-runner /app/test/test.sh sort   # E2E (meta-root dev stack)
pnpm test                                             # unit tests (@meta-sort/core, mocha)
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
│   │   │   ├── discovery/        # meshdisco.ts (beacon v2, mirrored port)
│   │   │   ├── events/           # FileEventConsumer, SSEEventClient
│   │   │   ├── jellyfin/         # Jellyfin / NFO output helpers
│   │   │   ├── kv/               # KVManager, LeaderClient, RedisClient, MetaCoreApiWriter
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
│   └── shared/                   # Vendored copies of filename-tool, meta-hash, meta-interface
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

> Built-in container plugins **do not live here.** They live at the
> repo root as separate submodules:
> `packages/plugins/metamesh-plugin-{file-info,ffmpeg,filename-parser,jellyfin-nfo,tmdb,anime-detector,language,subtitle,subtitle-extractor,still-extractor,opensubtitle,torrent,fullhash}`.

### Key components

| Component | File | Purpose |
|-----------|------|---------|
| Entry point | `src/index.ts` | Wires KVManager → API server → plugin manager → ContainerManager → StreamingPipeline → FileEventConsumer. |
| Discovery | `src/discovery/meshdisco.ts` | beacon v2 node + `MetaCoreLocator`. |
| Streaming pipeline | `src/logic/pipeline/StreamingPipeline.ts` | 3-queue (validation / fast / background) orchestrator. |
| State manager | `src/logic/UnifiedProcessingStateManager.ts` | Tracks `discovered → lightProcessing → hashProcessing → done`. |
| File processor | `src/logic/WatchedFileProcessor.ts` | Light + hash phase implementation. |
| SSE consumer | `src/events/FileEventConsumer.ts` | Translates meta-core events into pipeline calls. |
| SSE transport | `src/events/SSEEventClient.ts` | Long-lived HTTP SSE with cursor persistence. |
| KV manager | `src/kv/KVManager.ts` | Bootstraps the HTTP-only RedisKVClient + WebDAV client from LeaderClient. |
| Leader client | `src/kv/LeaderClient.ts` | Legacy name: thin adapter over `MetaCoreLocator` (UDP), or `GET /urls` when `META_CORE_URL` is pinned. |
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
- `packages/meta-core/docs/` — Redis storage owner, api-mediated access.
- `docs/project-architecture/beacon-v2.md` — beacon v2 spec.

## License

MIT (see `package.json`).
