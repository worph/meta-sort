# Plugin Task Queue Architecture

**Author**: Meta Mesh Development Team
**Last Updated**: 2026-01-07
**Status**: Current Implementation

---

## Table of Contents

1. [Overview](#overview)
2. [Clarifications](#clarifications)
3. [Problem Statement](#problem-statement)
4. [Proposed Architecture](#proposed-architecture)
5. [Design Decisions](#design-decisions)
6. [Plugin Task Model](#plugin-task-model)
7. [Queue Classification](#queue-classification)
8. [Dependency and Priority Handling](#dependency-and-priority-handling)
9. [Data Flow](#data-flow)
10. [VFS Event System](#vfs-event-system)
11. [Performance Characteristics](#performance-characteristics)
12. [Migration Path](#migration-path)

---

## Overview

This document describes the **two-queue plugin task architecture** for meta-sort's processing pipeline. The architecture separates plugin execution into discrete, queueable tasks and routes them to specialized queues based on execution characteristics.

### Key Characteristics

- **Task Granularity**: Each plugin execution becomes a separate queueable task
- **Two-Queue Model**: Fast queue (high concurrency: 32) and Background queue (low concurrency: 8)
- **Sequential Queue Execution**: Background queue is paused while Fast queue has pending work
- **Manifest-Based Classification**: Plugins declare their queue via `defaultQueue` in manifest, with measurement-based override after sufficient samples
- **Dependency Preservation**: Plugin dependencies respected across queue boundaries (including cross-queue)
- **Priority Ordering**: Tasks sorted by execution time within each queue (fastest first)
- **Sequential Per-File Execution**: Plugins execute sequentially per file; concurrency is between files

### Goals

| Goal | Description |
|------|-------------|
| **Throughput** | Fast plugins don't wait behind slow plugins |
| **Resource Efficiency** | Appropriate concurrency for each workload type |
| **Simplicity** | Two queues are easier to reason about than N queues |
| **Predictability** | Classification via manifest with measurement-based refinement |
| **Observability** | Clear separation enables better monitoring |

---

## Clarifications

This section documents design clarifications made during architecture review.

### C1: `manifest.defaultQueue` Field

The `defaultQueue` field is implemented in the plugin manifest schema. See `packages/meta-sort/packages/meta-sort-core/src/plugin-engine/types.ts` for the definition.

Plugins specify their default queue in the manifest as either 'fast' or 'background'.

### C2: `full-hash` Plugin Implementation

The `full-hash` plugin is a wrapper around the existing hash computation logic, not a rewrite. It imports and calls the existing hash computation function, is classified as a background queue plugin, and allows future hash algorithms to be added as separate plugins.

### C3: Queue Replacement Strategy

The new two-queue model replaces and improves the current queue structure:

| Current Queue | New Queue | Notes |
|---------------|-----------|-------|
| Light Processing Queue | **Fast Queue** | Same purpose, now handles only fast plugins |
| Hash Processing Queue | **Background Queue** | Now handles slow plugins including `full-hash` |
| Validation Queue | (unchanged) | Remains for extension filtering |

The current `lightQueue` + `hashQueue` in `WatchedFileProcessor` will be replaced by `fastQueue` + `backgroundQueue` with the new task-based scheduling.

### C4: midhash256 "Inline" Meaning

"Inline" means midhash256 computation happens within the light processing queue worker, before any plugin tasks are created. It is NOT a plugin because:

1. It provides the file identity (`fileHash`) required to create task IDs
2. It must complete before task creation (tasks are identified as `${fileHash}:${pluginId}`)
3. It requires file access, so it runs in the queue worker context

The light processing queue worker first computes midhash256 (approximately 150ms), which produces the fileHash. Then it creates PluginTask entries for all plugins using that fileHash, and finally enqueues tasks to the Fast and Background queues.

### C5: VFS Population via Event Listener System

Files should appear in the VFS as soon as sufficient metadata is available, not after all fast plugins complete. This is achieved via an event listener system:

- **Event**: `plugin:complete` emitted when any plugin finishes for a file
- **Listener**: meta-fuse subscribes and checks if required metadata fields are present
- **VFS Update**: File added to VFS when minimum required fields exist (e.g., after `filename-parser` completes)

This replaces the current "wait for all plugins" approach and provides faster VFS visibility.

**Current Infrastructure**: Redis pub/sub channel `meta-sort:file:batch` already exists and batches updates every 5 seconds. This can be extended or a new real-time channel added for plugin completion events.

**Note**: The `renamingRule` function is NOT deprecated - it's actively used in both meta-sort and meta-fuse to generate virtual paths from metadata.

---

## Problem Statement

### Current Architecture

The current light processing phase executes all plugins sequentially for each file:

```
Light Processing Queue (16 workers)
    │
    └── Worker picks up file
            │
            ├── midhash256 computation (~150ms)  ◄── Inline, not a plugin
            │
            └── executePlugins(file)
                    │
                    ├── file-info        (~2ms)
                    ├── filename-parser  (~8ms)
                    ├── ffmpeg           (~300ms)
                    ├── tmdb             (~2000ms)  ◄── Network call
                    ├── language         (~50ms)
                    └── subtitle         (~30ms)
                    │
                    └── Total: ~2400ms per file
```

### Problems Identified

1. **Slow Plugin Blocking**
   - A 2-second tmdb API call blocks the worker for the entire duration
   - Fast plugins (file-info, filename-parser) complete in under 10ms but wait in the same queue
   - With 16 workers, only 16 tmdb calls can run concurrently

2. **Suboptimal Resource Utilization**
   - Network-bound plugins (tmdb) could run with higher concurrency (rate limit permitting)
   - CPU-bound plugins share workers with I/O-bound plugins
   - No differentiation between instant operations and heavy operations

3. **Throughput Bottleneck**
   - For 1000 files: 1000 × 2400ms = 2,400,000ms total work
   - With 16 workers: 2,400,000 / 16 = 150,000ms = 2.5 minutes minimum
   - But instant plugins could process all 1000 files in seconds

4. **Inflexible Concurrency**
   - All plugins share the same concurrency limit
   - Cannot tune concurrency per-plugin or per-resource-type

---

## Proposed Architecture

### Two-Queue Model

Split plugin execution into two queues based on execution time characteristics:

```
File Discovery
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ midhash256 computation (inline, ~150ms)                                  │
│ ════════════════════════════════════════════════════════════════════    │
│ Required before any plugin processing - provides file identity           │
└──────────────────────────────────┬──────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         FAST QUEUE                                       │
│                    (High Concurrency: 32)                                │
│                                                                          │
│  Sorted by average execution time (fastest first)                        │
│  Plugins execute sequentially per file, concurrency is between files     │
│                                                                          │
│  ┌──────────┐  ┌─────────────────┐  ┌──────────┐  ┌──────────┐          │
│  │file-info │─▶│ filename-parser │─▶│  ffmpeg  │─▶│ language │          │
│  │  ~2ms    │  │     ~8ms        │  │  ~300ms  │  │  ~50ms   │          │
│  └──────────┘  └─────────────────┘  └──────────┘  └──────────┘          │
│                                                                          │
│  Classification: avgTime < 1000ms OR manifest.defaultQueue = 'fast'      │
│  ════════════════════════════════════════════════════════════════════   │
│  Files appear in VFS after fast processing completes                     │
└─────────────────────────────────────────────────────────────────────────┘
      │
      │ Fast queue IDLE (all fast tasks complete)
      │ Background queue STARTS (in-progress tasks allowed to complete)
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      BACKGROUND QUEUE                                    │
│                     (Low Concurrency: 8)                                 │
│                     ⚠ PAUSED while Fast queue has work                  │
│                                                                          │
│  Sorted by average execution time (fastest first)                        │
│  Plugins execute sequentially per file, concurrency is between files     │
│                                                                          │
│  ┌──────────┐  ┌─────────────┐  ┌─────────────┐                         │
│  │  tmdb    │  │ full-hash   │  │  transcode  │                         │
│  │ ~2000ms  │  │  ~5000ms    │  │  ~30000ms   │                         │
│  └──────────┘  └─────────────┘  └─────────────┘                         │
│                                                                          │
│  Classification: avgTime >= 1000ms OR manifest.defaultQueue = 'background'│
└─────────────────────────────────────────────────────────────────────────┘
      │
      ▼
   File Complete (all plugin tasks finished)
```

**Critical Constraint**: The Background queue does NOT process while the Fast queue has pending work. This ensures all files become visible in the VFS as quickly as possible before background enrichment begins.

### Why Two Queues?

We evaluated several queue architectures:

| Architecture | Queues | Complexity | Chosen |
|-------------|--------|------------|--------|
| Per-plugin queues | N (one per plugin) | High | No |
| Resource-typed queues | 4 (CPU/IO/Network/Heavy) | Medium | No |
| Time-based queues | 2 (Fast/Background) | Low | **Yes** |
| Single priority queue | 1 | Low | No |

**Two queues provide the optimal balance:**
- **Simpler than N queues**: Easier to reason about, less coordination overhead
- **Better than single queue**: Slow tasks don't block fast tasks
- **Adaptive**: Classification based on actual measurements, not static assumptions
- **Resource-aware**: Background queue naturally limits heavy operations

---

## Design Decisions

### Decision 1: Task Granularity per Plugin

**Problem**: How should work be divided across queues?

**Options Considered**:
1. **Per-file tasks**: Current model (one task = all plugins for one file)
2. **Per-plugin tasks**: Each plugin execution is a separate task
3. **Per-phase tasks**: Group plugins by processing phase

**Decision**: Per-plugin tasks (Option 2)

**Rationale**:
- Enables fine-grained scheduling and prioritization
- Allows slow plugins to be isolated from fast plugins
- Enables per-plugin concurrency tuning
- Better resource utilization (fast plugins don't wait for slow ones)
- Natural fit for dependency-based execution order

---

### Decision 2: Two Queues (Fast/Background)

**Problem**: How many queues should exist, and how should they be differentiated?

**Options Considered**:
1. **Per-plugin queues**: Maximum isolation, maximum complexity
2. **Four resource-typed queues**: CPU, I/O, Network, Heavy (mixed)
3. **Two time-based queues**: Fast (under 1s) and Background (1s or more)
4. **Single priority queue**: Simplest, but slow tasks still block workers

**Decision**: Two time-based queues (Option 3)

**Rationale**:

The key insight is that execution time is what matters for user experience, not resource type:
- Users want to see results quickly
- Fast plugins should complete for all files before slow plugins start
- The distinction between "fast enough to wait for" and "do in background" is the meaningful boundary

Resource-typing (Option 2) was rejected because:
- Hash computation is both I/O and CPU intensive - which queue?
- FFmpeg is I/O + CPU + process spawning - hard to categorize
- Resource types don't map cleanly to user-perceived latency

Per-plugin queues (Option 1) were rejected because:
- Plugin dependencies require coordination across queues anyway
- Tracking "file complete" across N queues is complex
- Diminishing returns beyond 2 queues for this workload

---

### Decision 3: Time-Based Classification

**Problem**: How should plugins be assigned to Fast vs Background queue?

**Options Considered**:
1. **Static configuration**: Plugin manifest declares queue type
2. **Dynamic measurement**: Classify based on observed execution times
3. **Hybrid**: Static default with dynamic override

**Decision**: Dynamic measurement (Option 2)

**Rationale**:
- Execution time varies by environment (fast SSD vs slow NAS)
- Plugin behavior may change over time (API latency varies)
- Removes need for manual configuration
- Self-healing: if a plugin becomes faster/slower, classification adapts

**Implementation Notes**:
- Uses existing performanceMetrics.pluginTimings to calculate average time
- Default threshold is 1000ms (1 second)
- New plugins with no measurements start in Fast queue, then migrate to Background if their average exceeds threshold

---

### Decision 4: Priority Within Queues

**Problem**: How should tasks be ordered within each queue?

**Options Considered**:
1. **FIFO**: Process in arrival order
2. **Time-based priority**: Fastest tasks first
3. **Dependency-based priority**: Ready tasks with satisfied dependencies first

**Decision**: Time-based priority with dependency gating (Options 2 + 3)

**Rationale**:
- Fastest-first maximizes throughput (more completions per time unit)
- Dependencies must be satisfied regardless of priority
- Combines both: tasks are eligible when dependencies met, then sorted by time

Tasks with satisfied dependencies get priority based on inverse average execution time - faster tasks run first.

---

### Decision 5: Concurrency Levels

**Problem**: What concurrency should each queue have?

**Options Considered**:
1. **Equal concurrency**: Both queues get 16 workers
2. **Inverse concurrency**: Fast gets more, Background gets less
3. **Adaptive concurrency**: Adjust based on queue depth

**Decision**: Inverse concurrency (Option 2)

**Rationale**:

| Queue | Concurrency | Rationale |
|-------|-------------|-----------|
| Fast | 32 | Fast tasks complete quickly, high concurrency reduces latency |
| Background | 8 | Slow tasks are resource-intensive, limit to prevent thrashing |

- Fast queue: Higher concurrency is safe because tasks complete quickly
- Background queue: Lower concurrency prevents resource exhaustion (network, I/O, memory)
- Background queue concurrency also enables natural rate limiting for API-based plugins

---

### Decision 6: Hash Computation Placement

**Problem**: Hash computation is both I/O-intensive (reading file) and CPU-intensive (computing hash). How should it be handled?

**Analysis**:
- **midhash256**: Reads 256KB chunks, fast (approximately 150ms average) → Inline computation (not a plugin)
- **Full hash (SHA-256)**: Reads entire file, slow (5-30 seconds) → Background queue plugin

**Decision**:
- midhash256 is computed inline before any plugin processing (provides file identity)
- Full hash becomes a background queue plugin (`full-hash` plugin)

**Rationale**:
- midhash256 is required to identify the file before any plugin can run - it cannot be a plugin itself
- Full hash is slow and non-blocking for VFS visibility, making it ideal for background processing
- This absorbs the previous "Hash Processing" stage into the Background queue
- Hash algorithms become plugins, allowing new hash types to be added without core changes

---

### Decision 7: Sequential Queue Execution (Fast-First)

**Problem**: Should the Fast and Background queues run concurrently, or should Background wait for Fast to complete?

**Options Considered**:
1. **Concurrent execution**: Both queues process tasks simultaneously
2. **Sequential execution**: Background queue paused while Fast queue has work
3. **Hybrid**: Background runs at reduced concurrency while Fast is active

**Decision**: Sequential execution (Option 2) - Background queue does not start new tasks while Fast queue has work

**Important**: When new fast work arrives while background is processing, in-progress background tasks are allowed to complete - only new background task starts are paused.

**Rationale**:

This is a critical architectural constraint that preserves the current system behavior and provides several benefits:

1. **Predictable Resource Usage**
   - Fast queue can use full system resources without competition
   - No resource contention between fast and slow operations
   - Prevents slow operations (network, heavy I/O) from impacting fast processing

2. **User Experience Priority**
   - Files appear in VFS as quickly as possible
   - All files become visible before enrichment begins
   - Users see a complete library structure immediately, then metadata enriches over time

3. **Simpler Mental Model**
   - Clear phases: "discovery/fast processing" then "background enrichment"
   - Easier to monitor and debug
   - Progress is linear and predictable

4. **Batch Efficiency**
   - Background tasks (like tmdb API calls) can be batched more effectively
   - Rate limiting is easier to manage when all network calls happen together
   - Reduces API call overhead through potential batching

**Visual Timeline**:
```
Time ──────────────────────────────────────────────────────────────────────▶

     ┌─────────────────── FAST QUEUE ACTIVE ───────────────────┐
     │                                                          │
     │  File A: [file-info][filename-parser][ffmpeg]           │
     │  File B: [file-info][filename-parser][ffmpeg]           │
     │  File C: [file-info][filename-parser][ffmpeg]           │
     │  ...                                                     │
     │  File N: [file-info][filename-parser][ffmpeg]           │
     │                                                          │
     └──────────────────────────────────────────────────────────┘
                                                                │
                                                                │ Fast queue idle
                                                                ▼
     ┌─────────────────── BACKGROUND QUEUE ACTIVE ─────────────────────────▶
     │
     │  File A: [tmdb][full-hash]
     │  File B: [tmdb][full-hash]
     │  File C: [tmdb][full-hash]
     │  ...
     │
     └─────────────────────────────────────────────────────────────────────▶

All files visible in VFS ──┘
                           │
                           Enrichment happens in background
```

---

### Decision 8: Sequential Plugin Execution Per File

**Problem**: Should multiple plugins for the same file execute concurrently, or sequentially?

**Options Considered**:
1. **Concurrent per-file**: Multiple plugins process the same file simultaneously
2. **Sequential per-file**: Plugins execute one at a time per file, concurrency between files

**Decision**: Sequential per-file execution (Option 2)

**Rationale**:
- Plugins share a KV store per file - concurrent writes would cause race conditions
- Dependencies require sequential execution anyway (tmdb needs filename-parser results)
- Simplifies plugin development - no need to handle concurrent access
- Concurrency between files (32 fast, 8 background) provides sufficient throughput
- Easier to debug and reason about plugin execution order

---

### Decision 9: Shared KV Store Across Tasks

**Problem**: How should plugin results be shared between tasks for the same file?

**Decision**: Single shared KV store per file, persisted across all plugin tasks

**Behavior**:
- KV store is created when file enters processing (after midhash256)
- All plugins for a file read/write to the same KV store
- Once a plugin sets a value, subsequent plugins can read it
- KV store persists to Redis after each plugin completes
- Cross-queue access works transparently (fast plugin results available to background plugins)

For example, the filename-parser plugin (fast queue) sets parsed title and year data. Later, the tmdb plugin (background queue) reads that parsed data from the same KV store to make its API request.

---

### Decision 10: Cross-Queue Dependencies

**Problem**: What happens when a fast plugin depends on a background plugin?

**Decision**: Dependencies are always respected, regardless of queue classification

**Behavior**:
- If a fast plugin declares a dependency on a background plugin, it waits
- This effectively moves the dependent fast plugin to execute after background
- The task remains in the fast queue but cannot start until dependency completes

**Recommendation**: Avoid cross-queue dependencies where possible. If a fast plugin needs background data, consider whether it should be a background plugin instead.

---

## Plugin Task Model

### Task Definition

Each plugin execution becomes a discrete task with the following properties:
- **id**: Unique task ID in format `${fileHash}:${pluginId}`
- **fileHash**: File identity (midhash256, computed inline before tasks)
- **filePath**: File path for processing
- **pluginId**: Plugin to execute
- **dependencies**: Plugin IDs this task depends on
- **queue**: Target queue ('fast' or 'background') from classification
- **priority**: Based on average execution time (lower = higher priority)
- **estimatedTimeMs**: From performance metrics
- **status**: One of 'pending', 'ready', 'running', 'completed', or 'failed'
- **createdAt**, **startedAt**, **completedAt**: Timestamps
- **result**: Plugin result (on completion)
- **error**: Error message (on failure)

**Note**: The `fileHash` (midhash256) is computed inline before task creation, so it's always available when tasks are created.

### Task Lifecycle

```
                    ┌─────────┐
                    │ PENDING │ ◄── Created when file enters light processing
                    └────┬────┘
                         │
                         │ All dependencies completed
                         ▼
                    ┌─────────┐
                    │  READY  │ ◄── Eligible for queue placement
                    └────┬────┘
                         │
                         │ Worker picks up task
                         ▼
                    ┌─────────┐
                    │ RUNNING │ ◄── Plugin.process() executing
                    └────┬────┘
                         │
           ┌─────────────┴─────────────┐
           │                           │
           ▼                           ▼
    ┌───────────┐               ┌──────────┐
    │ COMPLETED │               │  FAILED  │
    └───────────┘               └──────────┘
```

### Task Creation

When a file enters light processing, tasks are created for all active plugins. The plugin manager provides the execution order via topological sort, and performance metrics provide estimated timing for each plugin. Each task is assigned dependencies based on the plugin manifest.

---

## Queue Classification

### Classification Algorithm

Classification uses the following logic:
1. Check if plugin has sufficient measurement data (at least 10 samples)
2. If not enough data, use the manifest's `defaultQueue` value (defaults to 'fast')
3. If enough data exists, use measured average time against a 1000ms threshold

Classification is determined at task creation time and does not change for existing tasks. This keeps the system simple and predictable.

### Expected Classification

Based on current measurements and recommended `defaultQueue` values:

| Plugin | Avg Time | defaultQueue | Classification |
|--------|----------|--------------|----------------|
| file-info | ~2ms | fast | Fast |
| filename-parser | ~8ms | fast | Fast |
| ffmpeg | ~300ms | fast | Fast |
| language | ~50ms | fast | Fast |
| subtitle | ~30ms | fast | Fast |
| jellyfin-nfo | ~20ms | fast | Fast |
| tmdb | ~2000ms | background | Background |
| full-hash | ~5000ms+ | background | Background |

**Note**: midhash256 is not listed as it's computed inline, not as a plugin.

### Manifest Schema Extension

Plugins can declare their default queue in the manifest with a `defaultQueue` field:
- `fast` (default): Plugin is assumed to complete quickly (under 1s)
- `background`: Plugin is assumed to be slow (1s or more), e.g., API calls, full file hashing

This is used for classification until enough measurements are collected. After 10+ executions, measured average time takes precedence.

---

## Dependency and Priority Handling

### Dependency Resolution

Plugin dependencies are declared in manifests and respected across queues. For example, the tmdb plugin depends on file-info, filename-parser, and jellyfin-nfo.

**Cross-Queue Dependencies**:
- tmdb (Background) depends on filename-parser (Fast)
- tmdb task remains 'pending' until filename-parser task is 'completed'
- Once dependencies satisfied, tmdb task becomes 'ready' and enters Background queue

### Dependency Graph Example

```
                    file-info (Fast)
                    /           \
                   /             \
    filename-parser (Fast)    ffmpeg (Fast)
           |                    /    \
           |                   /      \
    jellyfin-nfo (Fast)   language   subtitle
           |               (Fast)     (Fast)
           |
           ▼
        tmdb (Background) ◄── Waits for filename-parser & jellyfin-nfo
           |
           ▼
      full-hash (Background) ◄── No deps, but queued after fast completes
```

**Note**: `full-hash` has no plugin dependencies but runs in Background queue. It starts only after all fast tasks complete due to sequential queue execution.

### Task Scheduling

The TaskScheduler maintains pending and completed task sets. When a task is enqueued, the scheduler checks if all dependencies are satisfied. If ready, it adds the task to the appropriate queue with priority based on estimated execution time.

After task completion, timing is recorded for future classification, and dependent tasks are checked for readiness.

---

## Data Flow

### Complete Processing Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. File Discovery                                                            │
│    FolderWatcher yields file path                                            │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Validation Queue (unchanged)                                              │
│    Extension check, state initialization                                     │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. midhash256 Computation (inline)                                           │
│    Compute file identity hash before any plugin processing                   │
│    This is NOT a plugin - required for task identification                   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Task Creation                                                             │
│    Create PluginTask for each active plugin (fileHash now available)         │
│                                                                              │
│    file-info task      (pending, no deps, fast)     → immediately ready      │
│    filename-parser task (pending, deps: file-info, fast)                     │
│    ffmpeg task         (pending, deps: file-info, fast)                      │
│    tmdb task           (pending, deps: filename-parser, background)          │
│    full-hash task      (pending, no deps, background)                        │
│    ...                                                                       │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. Fast Queue Processing                                                     │
│    Concurrency: 32 (between files, sequential per file)                      │
│                                                                              │
│    ┌────────────┐    ┌─────────────────┐    ┌──────────┐    ┌────────┐      │
│    │ file-info  │───▶│ filename-parser │───▶│  ffmpeg  │───▶│language│      │
│    │ (ready)    │    │ (ready after    │    │ (ready)  │    │(ready) │      │
│    └────────────┘    │  file-info)     │    └──────────┘    └────────┘      │
│                      └────────┬────────┘                                     │
│                               │                                              │
│                               ▼                                              │
│                      🎯 VFS EVENT EMITTED                                    │
│                      File visible in VFS after filename-parser               │
│                      (minimum metadata available for path generation)        │
│                                                                              │
│    ════════════════════════════════════════════════════════════════════════  │
│    Background queue tasks are queued but PAUSED during this phase            │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ ⚠ Fast queue becomes IDLE (no pending fast tasks)
                                   │ ⚠ Background queue STARTS (in-progress tasks finish)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. Background Queue Processing                                               │
│    Concurrency: 8 (between files, sequential per file)                       │
│    ⚠ ONLY starts new tasks when Fast queue is idle                          │
│    ⚠ In-progress background tasks complete even if new fast work arrives    │
│                                                                              │
│    ┌──────────┐    ┌─────────────┐                                          │
│    │   tmdb   │    │  full-hash  │                                          │
│    │ (ready)  │    │  (ready)    │                                          │
│    └──────────┘    └─────────────┘                                          │
│                                                                              │
│    Slow plugins complete, metadata enriched, full hashes computed            │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. File Complete                                                             │
│    All plugin tasks for file completed (last task finishes)                  │
│    State: done                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key Changes from Previous Architecture**:
- Hash Processing stage is eliminated - `full-hash` is now a Background queue plugin
- midhash256 is computed inline (not a plugin) as it's required for file identity
- Pipeline stages: Validation → midhash → Fast Queue → Background Queue → Done
- VFS visibility decoupled via event system - files appear after `filename-parser` completes (approximately 160ms)

### Multi-File Sequential Queue Processing

With sequential queue execution, ALL fast tasks complete before ANY background tasks start. However, VFS visibility is decoupled via the event system:

```
Time ──────────────────────────────────────────────────────────────────────▶

     ┌──────────────── FAST QUEUE PHASE ────────────────┐  ┌─── BACKGROUND PHASE ───▶
     │                                                   │  │
File A: [file-info][filename-parser]▼[ffmpeg]           │  │ [tmdb][full-hash]
File B: .....[file-info][filename-parser]▼[ffmpeg]      │  │ [tmdb][full-hash]
File C: ..........[file-info][filename-parser]▼[ffmpeg] │  │ [tmdb][full-hash]
File D: ...............[file-info][filename-parser]▼[ffmpeg] [tmdb][full-hash]
     │                              │                    │  │
     │                              │                    │  │
     │                              ▼                    │  │
     │                   VFS EVENT: file visible         │  │
     │                   (after filename-parser)         │  │
     │                                                   │  │
     └───────────────────────────────────────────────────┘  └─────────────────────────▶
                                                         │
                                                         │
                                            Fast queue complete
                                            Background enrichment begins
```

**Key behavior**:
- Fast queue processes all files with high concurrency (32)
- VFS visibility is IMMEDIATE after `filename-parser` completes (via event system)
- Files appear in VFS approximately 160ms after discovery (midhash + file-info + filename-parser)
- Background queue is PAUSED until fast queue becomes idle
- Once fast queue is empty, background queue starts (8 workers)
- If new files are discovered, fast queue resumes and background pauses again
- TMDB metadata enriches already-visible files when background processing completes

---

## VFS Event System

### Overview

The VFS (Virtual File System) population is decoupled from the task queue via an event-driven architecture. Files appear in the VFS as soon as sufficient metadata is available, rather than waiting for all plugins to complete.

### Event Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TASK SCHEDULER (meta-sort)                           │
│                                                                              │
│  Plugin executes → Result stored in KV → Event emitted                       │
│                                                                              │
│  Event contains: fileHash, pluginId, filePath, timestamp                     │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      REDIS PUB/SUB (event transport)                         │
│                                                                              │
│  Channel: 'meta-sort:plugin:complete'                                        │
│  Message: { fileHash, pluginId, filePath, timestamp }                        │
│                                                                              │
│  (Existing 'meta-sort:file:batch' channel remains for batch updates)         │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VFS LISTENER (meta-fuse)                             │
│                                                                              │
│  On 'plugin:complete':                                                       │
│      1. Fetch metadata from Redis                                            │
│      2. Check if minimum required fields present:                            │
│         - For TV: title, season, episode                                     │
│         - For Movies: title, year                                            │
│      3. If sufficient: compute virtualPath via renamingRule()                │
│      4. Add file to VFS                                                      │
│      5. File appears in FUSE/WebDAV                                          │
│                                                                              │
│  On subsequent 'plugin:complete' for same file:                              │
│      - Update metadata (enrichment from tmdb, etc.)                          │
│      - File already visible, just metadata improves                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Minimum Metadata Requirements

Files appear in VFS when these minimum fields are available (typically after `filename-parser` plugin):

| Content Type | Required Fields | Typical Provider Plugin |
|--------------|-----------------|------------------------|
| TV Episode | `title`, `season`, `episode` | filename-parser |
| Movie | `title`, `year` | filename-parser |
| Unknown | `filename` (fallback to Unsorted/) | file-info |

### Event vs Batch Trade-offs

| Approach | Latency | Overhead | Use Case |
|----------|---------|----------|----------|
| Per-plugin events | ~10ms | High (many messages) | Real-time VFS updates |
| Batch updates (5s) | ~5000ms | Low | Bulk metadata sync |
| Hybrid | ~10ms for VFS, batched for full sync | Medium | **Recommended** |

**Recommended Hybrid Approach**:
- Emit per-plugin events for VFS population (instant visibility)
- Keep batch updates for full metadata sync and reconnection recovery
- meta-fuse uses events for real-time, polling (30s) as safety net

### Integration with Current Infrastructure

The current Redis pub/sub infrastructure (`meta-sort:file:batch`) is preserved. The new event system adds:

1. **New channel**: `meta-sort:plugin:complete` for per-plugin events
2. **Event structure**: fileHash, pluginId, filePath, timestamp
3. **Backward compatibility**: Batch channel continues to work for existing consumers

---

## Performance Characteristics

### Expected Improvements

| Metric | Current | Proposed | Improvement |
|--------|---------|----------|-------------|
| Time to VFS visibility | ~2400ms | ~160ms (after filename-parser) | 15x faster |
| Fast plugin throughput | 16 concurrent | 32 concurrent | 2x |
| Background isolation | None | Full | Slow plugins don't block fast |
| Resource utilization | Uniform | Optimized | Better CPU/IO/network balance |

### Throughput Analysis

**Current Model** (1000 files):
- Total work: 1000 files × 2400ms = 2,400,000ms
- Workers: 16
- Time: 2,400,000ms / 16 = 150,000ms = 2.5 minutes

**Proposed Model** (1000 files):
- Inline midhash: 1000 × 150ms = 150,000ms (part of validation/task creation)
- Fast queue work: 1000 × (2 + 8 + 300 + 50 + 30)ms = 390,000ms
- Fast workers: 32
- Fast time: 390,000ms / 32 = 12,187ms ≈ 12 seconds
- Background queue work: 1000 × (2000 + 5000)ms = 7,000,000ms (tmdb + full-hash)
- Background workers: 8
- Background time: 7,000,000ms / 8 = 875,000ms ≈ 14.5 minutes
- Total time: ~15 minutes (background dominates, but includes full hashing)
- Time to VFS: ~5 seconds (after filename-parser, via event system)

**Key Insights**:
1. **VFS Visibility**: With the event system, files appear in VFS after `filename-parser` completes (approximately 160ms = midhash + file-info + filename-parser). For 1000 files with 32 workers: 160ms × 1000 / 32 = 5 seconds to full VFS visibility.
2. **Background Processing**: Total time is longer because full hashing is now included in background queue, but this doesn't affect user-perceived latency.
3. **Decoupled Enrichment**: TMDB metadata arrives later but files are already browsable.

### Memory Characteristics

Task tracking overhead per file:
- Tasks per file: ~8 plugins
- Task object size: ~200 bytes
- Per-file overhead: 1600 bytes

For 100,000 files:
- In-flight tasks (max): ~10,000 (based on queue depths)
- Memory overhead: 10,000 × 1600 bytes = 16MB

Acceptable memory overhead for significant throughput improvement.

---

## Migration Path

### Phase 1: Task Infrastructure

1. Define PluginTask interface and types
2. Implement TaskScheduler with single queue (current behavior)
3. Add task creation during light processing (after inline midhash)
4. Validate dependency resolution works correctly
5. Add `defaultQueue` field to manifest schema

### Phase 2: Two-Queue Split

1. Add fastQueue and backgroundQueue to TaskScheduler
2. Implement classification logic (manifest.defaultQueue + 1000ms threshold)
3. Route tasks to appropriate queues based on classification
4. Implement sequential queue execution (background pauses while fast has work)
5. Convert `full-hash` computation to a background queue plugin

### Phase 3: Polish

1. Implement priority ordering within queues (fastest first)
2. Expose queue metrics via API (queue depths, throughput, etc.)
3. Add configuration for threshold and concurrency levels
4. Update existing plugins with appropriate `defaultQueue` values

### Backward Compatibility

The new architecture is internal to light processing. External interfaces remain unchanged:
- Same file state transitions (pending → lightProcessing → hashProcessing → done)
- Same VFS update timing (after light processing completes)
- Same API endpoints and responses
- Same plugin interface (plugins unaware of queue routing)

---

## Appendix: Alternative Architectures Considered

### Per-Plugin Queues

Separate queue per plugin (file-info queue, ffmpeg queue, tmdb queue, etc.) with individual concurrency settings.

**Rejected because**:
- N queues require N times coordination logic
- Tracking file completion across N queues is complex
- Dependency chains span multiple queues
- Diminishing returns beyond 2-3 queues

### Four Resource-Typed Queues

Queues for CPU (16 workers), I/O (8 workers), Network (4 workers), and Heavy (4 workers).

**Rejected because**:
- Classification is ambiguous (hash is both I/O and CPU)
- FFmpeg is I/O + CPU + process spawning
- Resource type doesn't directly correlate with user-perceived latency
- More complex than necessary for the problem being solved

### Single Priority Queue

Single priority queue sorted by average time with 16 workers.

**Rejected because**:
- Slow tasks still consume workers
- No isolation between fast and slow workloads
- Cannot tune concurrency per workload type
- Fast tasks can be blocked behind slow tasks already in progress

---

## Glossary

- **Task**: A discrete unit of work (one plugin execution for one file)
- **Fast Queue**: High-concurrency (32) queue for plugins completing in under 1 second
- **Background Queue**: Low-concurrency (8) queue for plugins completing in 1 second or more
- **Classification**: Determining which queue a plugin's tasks should use (based on `defaultQueue` manifest field or measured average time)
- **Dependency**: A plugin that must complete before another plugin can start
- **Priority**: Ordering within a queue based on expected execution time (fastest first)
- **defaultQueue**: Manifest field specifying the default queue for a plugin before measurements are available
- **midhash256**: Inline hash computation (not a plugin) that provides file identity before task creation
- **Sequential Queue Execution**: Background queue only processes when Fast queue is idle

---

## References

- [Streaming Pipeline Architecture](./streaming-pipeline-architecture.md)
- [p-queue Priority Queues](https://github.com/sindresorhus/p-queue#priority)
- Plugin System Types: `packages/meta-sort/packages/meta-sort-core/src/plugin-engine/types.ts`
- PerformanceMetrics: `packages/meta-sort/packages/meta-sort-core/src/metrics/PerformanceMetrics.ts`
