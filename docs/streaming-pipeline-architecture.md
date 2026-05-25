# Streaming Pipeline Architecture

The meta-sort streaming pipeline processes media files as they arrive from
meta-core (the file watcher), classifies them by extension, extracts light
metadata + a permanent identifier, and dispatches heavier work to container
plugins. It is implemented in
`packages/meta-sort/packages/meta-sort-core/src/logic/pipeline/StreamingPipeline.ts`.

---

## Contents

1. [Overview](#overview)
2. [Event source: meta-core SSE](#event-source-meta-core-sse)
3. [Pipeline stages](#pipeline-stages)
4. [State manager](#state-manager)
5. [Concurrency model](#concurrency-model)
6. [Reset semantics (generation counter)](#reset-semantics-generation-counter)
7. [Stats and observability](#stats-and-observability)
8. [Key code locations](#key-code-locations)

---

## Overview

```
                  meta-core /api/events/files (SSE)
                              │
                              ▼
                   FileEventConsumer
                              │   add / change / delete / rename / reset
                              ▼
   handleFileAdded ─┐
   handleFileChanged┤───────► validationQueue (PQueue)
   handleFileDeleted┘                │   extension filter
                                     ▼
                              fastQueue (PQueue)
                          processLightPhase
                          - filename parse, FFprobe-light, stats
                          - midhash256 (permanent ID) computed or
                            adopted from meta-core's pre-computed value
                          - KV write → file appears in VFS
                          - dispatch all enabled container plugins
                                     │
                                     ▼
                              backgroundQueue (PQueue)
                          processHashPhase
                          - SHA-256, additional heavy hashing
                                     │
                                     ▼
                  await ContainerPluginScheduler `file:complete`
                  (or complete immediately if no container plugins)
                                     │
                                     ▼
                              UnifiedProcessingStateManager → DONE
```

Two things are worth highlighting because they differ from older
documentation:

1. **midhash256 is the permanent file ID.** It is computed during the fast
   queue (or supplied pre-computed by meta-core in the SSE payload) and the
   file becomes accessible in the VFS as soon as the fast queue commits its
   KV write. There is no `tempId` and no rename when SHA-256 finishes.
2. **There is no in-process plugin pipeline.** Filename parsing, ffprobe,
   TMDB, etc. are container plugins running as separate Docker containers;
   `StreamingPipeline` dispatches to them via
   `ContainerPluginScheduler.dispatchAllPlugins` and waits for the
   scheduler's `file:complete` event before marking the file DONE.

---

## Event source: meta-core SSE

meta-sort no longer reads the filesystem directly. File discovery and
change watching live in meta-core, which streams events over HTTP SSE.

- **Subscriber:** `src/events/FileEventConsumer.ts` — converts each event
  to an absolute path (`filesPath` + relative path from meta-core) and
  forwards it to the pipeline.
- **Transport:** `src/events/SSEEventClient.ts` — long-lived HTTP
  connection to `${metaCoreApiUrl}/api/events/files`, with cursor
  persistence at `/meta-core/cursors/meta-sort-files.cursor`, automatic
  reconnect, and `Last-Event-ID` resume semantics.
- **Cursor gap (`gap` event):** the cursor was trimmed out of retention.
  The default response is to log and wait for the next `reset` event from
  meta-core; the pipeline rebuilds from there.

Event types and their effect on the pipeline:

| SSE event | Pipeline call | Notes |
|-----------|---------------|-------|
| `add`     | `handleFileAdded(path, midhash256?)` | Standard new-file path. |
| `change`  | `handleFileChanged(path, midhash256?)` | Removes any prior state, re-validates. |
| `delete`  | `handleFileDeleted(path)` | Drops state + calls `fileProcessor.deleteFile`. |
| `rename`  | delete(oldPath) + add(newPath) | Old path is removed; new path is re-ingested. |
| `reset`   | `pipeline.reset()` | Increments the reset generation, clears queues. |

---

## Pipeline stages

### Stage 1: Validation (`validateFile`)

`StreamingPipeline.validateFile(filePath, midhash256?)`

- Extension check against `PipelineConfig.supportedExtensions`
  (`src/config/SupportedFileTypes.ts`). No I/O.
- Files with unsupported extensions are removed from the state manager and
  counted in `filteredCount`. They do not progress.
- Strict MIME validation is intentionally **not** implemented — the comment
  in code reserves the option but it is off by default and there is no
  external library wired in.
- A generation check protects against in-flight tasks completing after a
  `reset()` (see [Reset semantics](#reset-semantics-generation-counter)).
- Valid files are enqueued onto the fast queue via
  `this.fastQueue.add(() => this.processLightPhase(filePath, midhash256))`.

### Stage 2: Fast queue (`processLightPhase`)

`StreamingPipeline.processLightPhase(filePath, midhash256?)` calls
`fileProcessor.processLightPhase(...)` which:

1. Computes or adopts `midhash256` (the permanent file ID, written as
   `cid_midhash256` on the metadata record).
2. Extracts light metadata (filename parsing via `@metazla/filename-tools`,
   basic stat/ffprobe info — see `src/logic/fileProcessor/` for the
   adapter, and the file-info / filename-parser / ffmpeg container
   plugins for the actual work).
3. Writes metadata to Redis through the KV client. The file is now visible
   to meta-fuse, meta-stremio, etc.

After `processLightPhase` returns, `StreamingPipeline`:

- Sends a fire-and-forget `/add` POST to the Stremio addon on
  `http://localhost:7000` (silent fail if it isn't running).
- Calls `dispatchContainerPluginTasks(filePath, hashId, existingMeta)` —
  this iterates every enabled container plugin via
  `ContainerPluginScheduler.dispatchAllPlugins`. Tasks are routed to the
  scheduler's own fast / background queues based on each plugin manifest's
  `defaultQueue`. Plugins write results back through meta-core's `/meta/:hash`
  API; `StreamingPipeline` does not aggregate them itself.
- Enqueues the file on the background queue
  (`processHashPhase`) for the in-process hashing pass.

### Stage 3: Background queue (`processHashPhase`)

`StreamingPipeline.processHashPhase(filePath)` calls
`fileProcessor.processHashPhase(...)` for the slow in-process hashing
(SHA-256 and any other heavy hashes the file processor computes).

Completion path depends on whether container plugins are configured:

- **No container plugins:** the file is moved to DONE immediately via
  `stateManager.completeHashProcessing(filePath, hashId, virtualPath)`.
- **Container plugins configured:** the background queue completes, but
  the file stays in `hashProcessing` until the `ContainerPluginScheduler`
  emits `file:complete` for that `(fileHash, filePath)` pair. The
  scheduler-side listener (`setContainerPluginScheduler` in
  `StreamingPipeline.ts`) re-reads metadata from Redis, computes the
  virtual path via `MetaDataToFolderStruct.renamingRule(...)`, and then
  transitions the file to DONE.

The scheduler listener also defends against three races: a different reset
generation, a missing `hashProcessing` entry, and a hash-mismatch where the
callback belongs to a previous attempt for the same path.

---

## State manager

`src/logic/UnifiedProcessingStateManager.ts`

States: `'discovered' | 'lightProcessing' | 'hashProcessing' | 'done'`.

```
discovered ── startLightProcessing ──► lightProcessing
                                              │
                                              │ completeLightProcessing
                                              ▼
                                       hashProcessing ── completeHashProcessing ──► done
```

Notable details:

- `done` is kept as a bounded array (`maxDoneHistory = 100`); a running
  `totalProcessedCount` survives that truncation.
- `seenHashes: Set<string>` + `duplicateCount` track per-content duplicate
  ingestion.
- `UnifiedFileState` tracks per-stage `*StartedAt` / `*CompletedAt`
  timestamps and derived `*ProcessingTime` values; this is what the
  `/api/processing/status` and `/api/processing/queue` endpoints expose.

---

## Concurrency model

Three independent `p-queue` instances inside `StreamingPipeline`:

| Queue | Field | Configured by |
|-------|-------|---------------|
| Validation | `validationQueue` | `PipelineConfig.validationConcurrency` |
| Fast (light phase) | `fastQueue` | `PipelineConfig.fastQueueConcurrency` |
| Background (hash phase) | `backgroundQueue` | `PipelineConfig.backgroundQueueConcurrency` |

Defaults are derived in `src/index.ts`:

```ts
const cpuCount = os.cpus().length;
const defaultBackgroundWorkers = Math.max(1, Math.floor(cpuCount / 2));
const validationConcurrency = config.MAX_WORKER_THREADS
    ? config.MAX_WORKER_THREADS * 2 : cpuCount * 2;
const fastQueueConcurrency = config.MAX_WORKER_THREADS
    ?? cpuCount;
const backgroundQueueConcurrency = config.MAX_WORKER_THREADS
    ?? defaultBackgroundWorkers;
```

i.e. on a host with `os.cpus().length = N`:

- `validationConcurrency = N * 2`
- `fastQueueConcurrency = N`
- `backgroundQueueConcurrency = floor(N / 2)` (minimum 1)

Setting `MAX_WORKER_THREADS=M` overrides all three to `(M * 2, M, M)`.

Note: container-plugin tasks do **not** share these queues — they are
scheduled inside `ContainerPluginScheduler` (`src/container-plugins/`),
whose own concurrencies come from `FAST_QUEUE_CONCURRENCY` (default 32)
and the same `backgroundQueueConcurrency` value as above. See
`plugin-task-queue-architecture.md`.

### Pause / resume

`pipeline.pause()` / `pipeline.resume()` pause all three internal queues.
The API server wires these to operator controls (see
`UnifiedAPIServer.setStreamingPipeline`). In-flight tasks finish; no new
ones start until resume.

---

## Reset semantics (generation counter)

`StreamingPipeline` keeps a `resetGeneration` counter and a per-file
`fileGenerations: Map<string, number>`. Every time `reset()` is called
(triggered by a `reset` SSE event from meta-core, or by an operator action
that fans out to one), the counter increments and the queues are cleared.

Each long-running phase checks `fileGenerations.get(filePath) ===
resetGeneration` at every yield point and bails out silently if the file
belongs to an older generation. This is the primary defense against:

- Old tasks completing into a cleared state manager.
- Container plugin callbacks arriving for files that were since
  rescheduled (callback handler additionally verifies the hash matches the
  current `hashProcessing` entry).

The reset also resets `discoveredCount`, `validatedCount`, `filteredCount`,
`fastProcessedCount`, `backgroundProcessedCount`, clears the
`ContainerPluginScheduler`, and resets `performanceMetrics`.

---

## Stats and observability

`StreamingPipeline.getStats()` returns:

- counters: `discovered`, `validated`, `filtered`, `fastProcessed`,
  `backgroundProcessed`
- per-queue `{ pending, size }` for validation, fast, background — if a
  `ContainerPluginScheduler` is attached, the fast / background numbers
  come from the scheduler's queues (those are the user-meaningful
  numbers because that's where the plugin work actually runs)
- `state`: the full `UnifiedProcessingStateManager.getSnapshot()`

These are exposed via the API endpoints registered in
`src/api/UnifiedAPIServer.ts`:

- `GET /api/processing/status` — counts + state snapshot
- `GET /api/processing/queue` — per-queue depths
- `GET /api/processing/failed` — failed-file roster (also recorded into
  `performanceMetrics`)
- `POST /api/processing/retry` and `POST /api/processing/retry-all`
- `POST /api/processing/wait-empty` — pauseless wait for the queues to
  drain (useful in tests)

---

## Key code locations

| Component | File |
|-----------|------|
| Pipeline orchestrator | `src/logic/pipeline/StreamingPipeline.ts` |
| Pipeline config | `src/logic/pipeline/PipelineConfig.ts` |
| State manager | `src/logic/UnifiedProcessingStateManager.ts` |
| File processor (light/hash phases) | `src/logic/WatchedFileProcessor.ts`, `src/logic/fileProcessor/` |
| SSE subscriber | `src/events/FileEventConsumer.ts` |
| SSE transport + cursor | `src/events/SSEEventClient.ts` |
| Container plugin dispatch | `src/container-plugins/ContainerPluginScheduler.ts` |
| Extension allow-list | `src/config/SupportedFileTypes.ts` |
| Concurrency defaults / startup wiring | `src/index.ts` |
| API endpoints | `src/api/UnifiedAPIServer.ts` |
