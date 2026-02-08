# meta-sort

A standalone file sorting and metadata extraction service for the MetaMesh ecosystem. meta-sort monitors watch folders, extracts metadata from media files, stores it in a distributed key-value store, and manages remote drive mounting for shared access.

## Overview

meta-sort is a **process-write** service that serves as the primary data ingestion point for the MetaMesh platform. It:

1. **Watches folders** for new media files (video, audio, subtitles)
2. **Extracts metadata** using FFmpeg and filename parsing
3. **Computes content identifiers** using midhash256 (fast) and SHA-256 (background)
4. **Stores metadata** in a distributed KV store (Redis or etcd)
5. **Manages remote mounts** (NFS, SMB, cloud storage) for shared access

---

## Meta-Core Architecture

MetaMesh uses **two shared volumes** for operation:

### 1. META_CORE_VOLUME - Infrastructure

The infrastructure volume stores all service coordination data:

| Context | Path | Description |
|---------|------|-------------|
| **Inside Container** | `/meta-core` | Mounted shared volume |
| **Production (Host)** | `/DATA/Apps/meta-core` | External shared drive mount point |
| **Development** | `./data/meta-core` | Local development directory |

```
META_CORE_VOLUME (/meta-core or /DATA/Apps/meta-core)
├── db/                        # KV Database storage
│   ├── redis/                 # Redis persistence (RDB + AOF)
│   │   ├── dump.rdb          # Redis snapshot
│   │   └── appendonly.aof    # Redis append-only log
│   └── etcd/                  # etcd data (alternative)
│       └── member/
│
├── locks/                     # Distributed locking
│   └── kv-leader.lock        # Leader election lock file
│                             # Contains: {"host":"service-name","api":"http://host:port"}
│
├── services/                  # Service discovery registry
│   ├── meta-sort.json        # {"name":"meta-sort","api":"http://...","status":"running","pid":123}
│   ├── meta-fuse.json        # {"name":"meta-fuse","api":"http://...","status":"running","pid":456}
│   ├── meta-stremio.json     # {"name":"meta-stremio","api":"http://...","status":"running","pid":789}
│   └── meta-orbit.json       # {"name":"meta-orbit","api":"http://...","status":"running","pid":321}
│
└── config/                    # Shared configuration
    ├── remote-storage.conf   # Remote mount definitions
    └── smb-credentials.txt   # SMB credentials (chmod 600)
```

### 2. FILES_VOLUME - Shared Media Drive

The **FILES_VOLUME** (canonical name: `/files`) is the shared drive for all media files. This is where all actual media content resides, and file paths in the KV database reference this volume.

| Context | Path | Description |
|---------|------|-------------|
| **Inside Container** | `/files` | Mounted shared media volume |
| **Production (Host)** | Varies (NFS/SMB/local) | External shared drive |
| **Development** | `./data/files` | Local development directory |

```
FILES_VOLUME (/files)
├── watch/                     # Host media folder (read-only bind mount)
│   ├── Movies/
│   │   └── Inception (2010)/
│   │       └── Inception.mkv
│   └── TV Shows/
│       └── Breaking Bad/
│
├── test/                      # Test media folder (development)
│
├── plugin/                    # Plugin output files (read-write)
│   └── {plugin-id}/           # Per-plugin output directory
│
└── corn/                      # SMB/rclone mounts (mounted inside container)
    ├── nas-share/             # SMB mount via rclone
    └── gdrive/                # Google Drive mount via rclone
```

### WebDAV File Access

meta-sort exposes `/files` via **WebDAV** at the `/webdav/` endpoint. This allows:
- **Container plugins** to access files without direct volume mounts
- **meta-fuse** and **meta-stremio** to read files from meta-sort
- Access to dynamic mounts (SMB, rclone) that can't be pre-mounted in other containers

```
Container Plugin ──► WebDAV (http://meta-sort/webdav/) ──► /files/
                     GET, PUT, DELETE, MKCOL supported
```

Environment variable: `PLUGIN_WEBDAV_URL=http://meta-sort-dev/webdav`

### File Path References

All file paths stored in the KV database are **relative to FILES_VOLUME**:

```
KV Key: /file/{midhash256}/filePath
KV Value: "media1/Movies/Inception (2010)/Inception.mkv"
         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
         Relative to FILES_VOLUME (/files)

Full path construction:
  Container: /files + /media1/Movies/... = /files/media1/Movies/Inception (2010)/Inception.mkv
  Any host:  $FILES_VOLUME + /media1/Movies/... = $FILES_VOLUME/media1/Movies/Inception (2010)/Inception.mkv
```

This allows services to be deployed on different hosts while sharing the same volume. The FILES_VOLUME can be:
- A local folder bind mount
- An NFS share mounted on the host
- An SMB/CIFS share
- A FUSE mount (rclone, sshfs, etc.)

### Mount Management

meta-sort manages remote mounts **inside** the FILES_VOLUME for shared access:

```bash
# meta-sort mounts remote storage INTO /files
/files/smb/nas-share    ← SMB mount managed by meta-sort
/files/nfs/server       ← NFS mount managed by meta-sort
/files/gdrive/          ← rclone mount managed by meta-sort

# Other folders are bind mounts from host
/files/media1           ← Host folder mounted into container
/files/media2           ← Another host folder
```

All services access files through `/files/*`, regardless of whether the underlying storage is local, NFS, SMB, or cloud.

---

## Leader Election and Lock Mechanism

### How It Works

MetaMesh uses a **filesystem-based distributed consensus** mechanism using `flock(2)`. The shared filesystem acts as the consensus layer.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Leader Election via flock                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Step 1: Service Startup                                                    │
│  ┌─────────────┐                                                            │
│  │   Service   │ ──▶ Try to acquire flock on /meta-core/locks/kv-leader.lock│
│  └─────────────┘                                                            │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    flock() Result                                    │   │
│  │  ┌─────────────────────┐      ┌──────────────────────────────────┐ │   │
│  │  │   Lock Acquired     │      │      Lock Blocked                 │ │   │
│  │  │   ──────────────    │      │      ─────────────                │ │   │
│  │  │                     │      │                                   │ │   │
│  │  │   BECOME LEADER     │      │   BECOME FOLLOWER                 │ │   │
│  │  │   1. Spawn Redis    │      │   1. Read lock file               │ │   │
│  │  │   2. Write API      │      │   2. Extract leader API           │ │   │
│  │  │      endpoint to    │      │   3. Connect to leader's          │ │   │
│  │  │      lock file      │      │      Redis                        │ │   │
│  │  │   3. Accept clients │      │   4. Start reconnect loop         │ │   │
│  │  └─────────────────────┘      └──────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Lock File Format

The lock file at `/meta-core/locks/kv-leader.lock` contains JSON:

```json
{
  "host": "meta-sort-instance-1",
  "api": "redis://10.0.1.50:6379",
  "http": "http://10.0.1.50:3000",
  "timestamp": 1703808000000,
  "pid": 12345
}
```

### flock Implementation

```typescript
import { open, flock } from 'fs';
import { promisify } from 'util';

const LOCK_FILE = '/meta-core/locks/kv-leader.lock';

async function tryBecomeLeader(): Promise<boolean> {
  const fd = await promisify(open)(LOCK_FILE, 'w');

  try {
    // LOCK_EX = exclusive lock, LOCK_NB = non-blocking
    await promisify(flock)(fd, 'exnb'); // Throws if cannot acquire

    // We are the leader - spawn KV database and write our endpoint
    await spawnRedis();
    await fs.writeFile(LOCK_FILE, JSON.stringify({
      host: hostname(),
      api: `redis://${myIP}:6379`,
      http: `http://${myIP}:3000`,
      timestamp: Date.now(),
      pid: process.pid
    }));

    return true; // We are leader
  } catch (err) {
    if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
      // Lock held by another process - become follower
      return false;
    }
    throw err;
  }
}
```

### Failure Detection and Recovery

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     Failure Detection Loop                                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Follower Service:                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  while (true) {                                                     │ │
│  │    try {                                                            │ │
│  │      await redis.ping();           // Health check                  │ │
│  │      await sleep(5000);            // Wait 5 seconds                │ │
│  │    } catch (connectionError) {                                      │ │
│  │      // Leader might be down                                        │ │
│  │      await tryBecomeLeader();      // Attempt to take over          │ │
│  │      if (isLeader) break;                                           │ │
│  │      await reconnectToNewLeader(); // Or connect to new leader      │ │
│  │    }                                                                │ │
│  │  }                                                                  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  When Leader Dies:                                                       │
│  1. flock is automatically released by OS                                │
│  2. First follower to call flock() wins                                  │
│  3. New leader spawns Redis, writes new endpoint                         │
│  4. Other followers detect connection failure, read new endpoint         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Service Discovery

### Registration Mechanism

Each service registers itself in `/meta-core/services/{service-name}.json`:

```json
{
  "name": "meta-sort",
  "version": "1.0.0",
  "api": "http://10.0.1.50:3000",
  "status": "running",
  "pid": 12345,
  "hostname": "meta-sort-instance-1",
  "startedAt": "2024-12-28T10:00:00Z",
  "lastHeartbeat": "2024-12-28T12:30:00Z",
  "capabilities": ["write", "mount", "monitor"],
  "endpoints": {
    "health": "/health",
    "api": "/api",
    "metrics": "/api/metrics"
  }
}
```

### Service Lifecycle

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Service Lifecycle                                  │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Startup:                                                                │
│  1. Create/update /meta-core/services/{name}.json                        │
│  2. Set status = "starting"                                              │
│  3. Initialize (connect to KV, etc.)                                     │
│  4. Set status = "running"                                               │
│  5. Start heartbeat loop (update lastHeartbeat every 30s)                │
│                                                                          │
│  Running:                                                                │
│  - Heartbeat updates lastHeartbeat timestamp                             │
│  - Other services read this file to discover endpoints                   │
│  - stale detection: if (now - lastHeartbeat > 60s) → service dead        │
│                                                                          │
│  Shutdown:                                                               │
│  1. Set status = "stopping"                                              │
│  2. Graceful shutdown (finish current work)                              │
│  3. Delete /meta-core/services/{name}.json OR set status = "stopped"     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Discovering Other Services

```typescript
async function discoverService(name: string): Promise<ServiceInfo | null> {
  const servicePath = `/meta-core/services/${name}.json`;

  try {
    const content = await fs.readFile(servicePath, 'utf-8');
    const service = JSON.parse(content);

    // Check if service is alive (heartbeat within last 60 seconds)
    const lastHeartbeat = new Date(service.lastHeartbeat).getTime();
    const isAlive = Date.now() - lastHeartbeat < 60_000;

    if (!isAlive) {
      console.warn(`Service ${name} appears stale (last heartbeat: ${service.lastHeartbeat})`);
      return null;
    }

    return service;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null; // Service not registered
    }
    throw err;
  }
}
```

---

## MetaMesh Ecosystem Architecture

### Service Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MetaMesh Ecosystem                                   │
│                                                                              │
│  Shared Volumes:                                                             │
│  ┌──────────────────────────────────┐  ┌──────────────────────────────────┐ │
│  │      META_CORE_VOLUME            │  │       FILES_VOLUME               │ │
│  │      (/meta-core)                │  │       (/files)                   │ │
│  │  ┌────────┐ ┌────────┐ ┌──────┐ │  │  ┌────────┐ ┌────────┐ ┌──────┐ │ │
│  │  │  db/   │ │ locks/ │ │svc/  │ │  │  │media1/ │ │  smb/  │ │ nfs/ │ │ │
│  │  │(Redis) │ │(flock) │ │(JSON)│ │  │  │(local) │ │(mount) │ │(mnt) │ │ │
│  │  └────┬───┘ └───┬────┘ └──┬───┘ │  │  └───┬────┘ └───┬────┘ └──┬───┘ │ │
│  └───────┼─────────┼─────────┼─────┘  └──────┼──────────┼─────────┼─────┘ │
│          │         │         │               │          │         │       │
│          ▼         ▼         ▼               ▼          ▼         ▼       │
│  ┌───────────────────────────────────────────────────────────────────────┐│
│  │                                                                        ││
│  │  [1] meta-sort          PROCESS-WRITE                                  ││
│  │      ├── Watches /files/* for new media files                         ││
│  │      ├── Extracts metadata → writes to KV (Redis in /meta-core/db)    ││
│  │      ├── Manages remote mounts INTO /files (NFS, SMB, rclone)         ││
│  │      └── Leader election (spawns Redis if leader)                      ││
│  │                                                                        ││
│  │  [2] meta-fuse          PROCESS-READ                                   ││
│  │      ├── Reads metadata from KV (Redis)                                ││
│  │      ├── Builds virtual filesystem from metadata                       ││
│  │      ├── Serves FUSE mount + WebDAV                                    ││
│  │      └── File paths resolve to /files/*                                ││
│  │                                                                        ││
│  │  [3] meta-stremio       PROCESS-READ                                   ││
│  │      ├── Reads metadata from KV (Redis)                                ││
│  │      ├── Stremio addon server (manifest, catalog, streams)             ││
│  │      ├── HLS transcoding via FFmpeg                                    ││
│  │      └── Video files from /files/*                                     ││
│  │                                                                        ││
│  │  [4] meta-orbit         SHARING-READ-WRITE                             ││
│  │      ├── P2P metadata synchronization (libp2p + OrbitDB)               ││
│  │      ├── Decentralized search across network                           ││
│  │      ├── Reads from local KV, shares to network                        ││
│  │      └── Receives from network, writes to local KV                     ││
│  │                                                                        ││
│  └───────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Data Flow                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  File Discovery:                                                             │
│                                                                              │
│    /files/media1/Movies/Inception (2010)/Inception.mkv                      │
│              │                                                               │
│              ▼                                                               │
│    [meta-sort] ──▶ Extract metadata ──▶ Write to Redis (in /meta-core/db)   │
│              │                              │                                │
│              │     Key: file:{midhash256}   │                                │
│              │     filePath: "media1/Movies/Inception (2010)/Inception.mkv" │
│              │     title: "Inception"                                        │
│              │     year: "2010"                                              │
│              │     duration: 8880                                            │
│              │                              │                                │
│              ▼                              ▼                                │
│                                                                              │
│  File Access:                                                                │
│                                                                              │
│    [meta-fuse] ◀── Read from Redis                                           │
│         │                                                                    │
│         ▼                                                                    │
│    Virtual FS: /mnt/virtual/Movies/Inception (2010)/Inception.mkv           │
│         │                     ↓                                              │
│         │          symlink to /files/media1/Movies/Inception (2010)/...     │
│         │                                                                    │
│    [meta-stremio] ◀── Read from Redis                                        │
│         │                                                                    │
│         ▼                                                                    │
│    Stream: GET /stremio/stream/{midhash256}/playlist.m3u8                    │
│         │                     ↓                                              │
│         │          transcode /files/media1/Movies/Inception (2010)/...      │
│         │                                                                    │
│    [meta-orbit] ◀──▶ Sync with P2P network                                   │
│         │                                                                    │
│         ▼                                                                    │
│    Share metadata to peers / Receive metadata from peers                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deployment

### Docker Compose (Production)

```yaml
version: '3.8'

services:
  meta-sort:
    image: metazla/meta-sort:latest
    volumes:
      # Infrastructure volume (KV DB, locks, services)
      - /DATA/Apps/meta-core:/meta-core:rw
      # Shared media volume
      - /DATA/Apps/meta-core/files:/files:rw,shared
      # OR mount multiple sources into /files
      # - /mnt/nas/media:/files/nas:ro
      # - /mnt/local/media:/files/local:ro
    environment:
      - META_CORE_PATH=/meta-core
      - FILES_PATH=/files
      - WATCH_PATHS=/files
      - REDIS_DATA_DIR=/meta-core/db/redis
    privileged: true  # Required for rclone FUSE mounts

  meta-fuse:
    image: metazla/meta-fuse:latest
    volumes:
      # Infrastructure (read-only for followers)
      - /DATA/Apps/meta-core:/meta-core:ro
      # Shared media volume (read-only)
      - /DATA/Apps/meta-core/files:/files:ro
      # FUSE mount output
      - /mnt/metamesh:/mnt/metamesh:rw,shared
    environment:
      - META_CORE_PATH=/meta-core
      - FILES_PATH=/files
    privileged: true  # Required for FUSE
    cap_add:
      - SYS_ADMIN
    devices:
      - /dev/fuse

  meta-stremio:
    image: metazla/meta-stremio:latest
    volumes:
      # Infrastructure (read-only)
      - /DATA/Apps/meta-core:/meta-core:ro
      # Shared media volume (read-only)
      - /DATA/Apps/meta-core/files:/files:ro
    environment:
      - META_CORE_PATH=/meta-core
      - FILES_PATH=/files
    ports:
      - "7000:7000"

  meta-orbit:
    image: metazla/meta-orbit:latest
    volumes:
      # Infrastructure (read-write for P2P sync)
      - /DATA/Apps/meta-core:/meta-core:rw
    environment:
      - META_CORE_PATH=/meta-core
    ports:
      - "4001:4001"  # libp2p
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `META_CORE_PATH` | `/meta-core` | Path to META_CORE_VOLUME (infrastructure) |
| `FILES_PATH` | `/files` | Path to FILES_VOLUME (shared media) |
| `REDIS_URL` | Auto-discover | Redis connection (from leader lock file) |
| `SERVICE_NAME` | Container hostname | Unique service identifier |
| `BASE_URL` | `http://localhost:8180` | External URL for this service |

**Container Plugins:**

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTAINER_PLUGINS_CONFIG` | `/app/plugins.yml` | Path to plugins configuration |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | Docker socket for container management |
| `CONTAINER_CALLBACK_URL` | `http://meta-sort:80` | URL plugins use to call back |
| `CONTAINER_NETWORK` | `meta-network` | Docker network for plugin containers |
| `PLUGIN_WEBDAV_URL` | - | WebDAV URL for plugin file access (e.g., `http://meta-sort-dev/webdav`) |
| `PLUGIN_STACK_NAME` | - | Docker Compose project name for grouping containers |

---

## File Processing Pipeline

meta-sort uses a **plugin-based architecture** with a two-queue task scheduler:

```
┌──────────────┐    ┌────────────────────────────────────────────────────┐
│   Discovery  │    │              Task Scheduler                         │
│   (Stream)   │───▶│  ┌─────────────────┐  ┌──────────────────────────┐ │
└──────────────┘    │  │   Fast Queue    │  │    Background Queue      │ │
   Watch folder     │  │  (16 workers)   │  │     (4 workers)          │ │
   + manual scan    │  │  <1s tasks      │  │     >=1s tasks           │ │
                    │  └─────────────────┘  └──────────────────────────┘ │
                    └────────────────────────────────────────────────────┘
```

Tasks are automatically classified and scheduled based on plugin dependencies:

```
Discovery → file-info → ffmpeg → filename-parser → jellyfin-nfo → tmdb
                                      ↓
            anime-detector ← language ← subtitle ← torrent ← full-hash
```

---

## Plugin System

Plugins are the core processing units that extract and enrich metadata. Each plugin:
- Has a `manifest.yml` defining metadata schema, config, and dependencies
- Runs in either **fast** (high concurrency) or **background** (low concurrency) queue
- Can depend on other plugins to ensure correct execution order

### Container Plugins

All plugins run as **Docker containers** for isolation and flexibility. Plugins are configured in `plugins.yml` and communicate via HTTP API.

| Plugin | Language | Queue | Priority | Description |
|--------|----------|-------|----------|-------------|
| **file-info** | TypeScript | fast | 10 | Basic file info (type, MIME, size, midhash256) |
| **ffmpeg** | TypeScript | fast | 15 | Video/audio/subtitle stream metadata via FFprobe |
| **filename-parser** | TypeScript | fast | 20 | Parse title, season, episode, year, quality from filename |
| **jellyfin-nfo** | TypeScript | fast | 25 | Parse Jellyfin/Kodi NFO metadata files |
| **tmdb** | TypeScript | background | 30 | Fetch metadata from The Movie Database API |
| **anime-detector** | TypeScript | fast | 35 | Detect anime content from keywords and audio tracks |
| **language** | TypeScript | fast | 40 | Aggregate languages from all streams (ISO 639-3) |
| **subtitle** | TypeScript | fast | 45 | Find sibling subtitle files and detect language |
| **torrent** | TypeScript | fast | 50 | Parse .torrent file metadata |
| **full-hash** | TypeScript | background | 100 | Compute SHA-256/SHA-1/MD5 hashes (JS implementation) |
| **fast-full-hash** | **Rust** | background | 100 | High-performance multi-algorithm hashing (Rust/Axum) |

### Plugin File Access

Plugins access files via **WebDAV** served by meta-sort nginx. This allows plugins to:
- Access files without requiring direct volume mounts
- See SMB/rclone mounts that are mounted dynamically inside meta-sort
- Read and write to the plugin output directory at `/files/plugin/`

### Plugin Manifest Example

```yaml
id: ffmpeg
name: FFmpeg Metadata
version: 1.0.0
description: Extracts video/audio/subtitle stream metadata using FFprobe
priority: 15
color: "#4CAF50"
defaultQueue: fast

dependencies:
  - file-info

config: {}

schema:
  fileinfo/duration:
    label: Duration
    type: string
    readonly: true
  fileinfo/streamdetails/video:
    label: Video Streams
    type: json
    readonly: true
    pattern: "fileinfo/streamdetails/video/{n}/*"
```

### Task Queue Architecture

- **Fast Queue** (16 workers): High-throughput for quick operations (<1s)
  - File info extraction, FFprobe, filename parsing, NFO reading
- **Background Queue** (4 workers): Low-concurrency for slow operations (>=1s)
  - TMDB API calls, full SHA-256 hashing
  - Automatically pauses when fast queue has work, resumes when idle

### Plugin Management

Plugins can be enabled/disabled and configured via:
- **Dashboard**: http://localhost:8180/ → Plugins tab
- **Config file**: `plugins.json` in cache directory

---

## Processing States

1. **Pending** - File discovered in watch folder
2. **Processing** - Plugins running (fast queue first, then background)
3. **Done** - All plugins completed successfully

---

## Package Structure

```
meta-sort/
├── packages/
│   ├── meta-sort-core/         # Core processing service (@meta-sort/core)
│   │   ├── plugins/            # Built-in plugins
│   │   │   ├── file-info/      # Basic file information
│   │   │   ├── ffmpeg/         # FFprobe metadata extraction
│   │   │   ├── filename-parser/# Filename parsing
│   │   │   ├── jellyfin-nfo/   # NFO file parsing
│   │   │   ├── tmdb/           # TMDB API integration
│   │   │   ├── anime-detector/ # Anime content detection
│   │   │   ├── language/       # Language aggregation
│   │   │   ├── subtitle/       # Subtitle file finder
│   │   │   ├── torrent/        # Torrent file parsing
│   │   │   └── full-hash/      # SHA-256 full file hashing
│   │   ├── src/
│   │   │   ├── api/            # Fastify REST API (UnifiedAPIServer)
│   │   │   ├── config/         # Environment configuration
│   │   │   ├── jellyfin/       # Jellyfin integration
│   │   │   ├── kv/             # KV manager with leader election (Redis)
│   │   │   ├── logic/          # File processing logic
│   │   │   ├── metrics/        # Performance tracking
│   │   │   ├── plugin-engine/  # Plugin loader and task scheduler
│   │   │   ├── types/          # TypeScript types
│   │   │   ├── utils/          # Utility functions
│   │   │   └── index.ts        # Entry point
│   │   └── package.json
│   │
│   ├── meta-sort-ui/           # Monitoring dashboard (@meta-sort/ui)
│   │   └── ...                 # React/Vite app
│   │
│   └── async-utils/            # Async utility library
│       └── ...                 # MultiQueue, PromiseQueue, etc.
│
├── docker/
│   ├── nginx.conf              # Reverse proxy config
│   ├── redis.conf              # Redis configuration
│   └── supervisord.conf        # Process management
│
├── Dockerfile
├── docker-compose.yml
├── package.json                # Workspace root
├── pnpm-workspace.yaml
└── README.md
```

### Key Components (meta-sort-core)

| Component | File | Purpose |
|-----------|------|---------|
| Entry Point | `src/index.ts` | Initializes KV manager, plugin engine, API server, file watching |
| File Processor | `src/logic/WatchedFileProcessor.ts` | File discovery and plugin task scheduling |
| Plugin Loader | `src/plugin-engine/PluginLoader.ts` | Loads plugins from manifest.yml, manages plugin lifecycle |
| Task Scheduler | `src/plugin-engine/TaskScheduler.ts` | Two-queue scheduler (fast/background) with dependency resolution |
| KV Manager | `src/kv/KVManager.ts` | Leader election via flock, Redis spawning, service discovery |
| Unified API | `src/api/UnifiedAPIServer.ts` | Fastify REST API for monitoring and control |
| Performance Metrics | `src/metrics/PerformanceMetrics.ts` | Tracks processing throughput and timing |
| Config | `src/config/EnvConfig.ts` | Environment variable parsing |

---

## Core Features

### 1. Folder Watching

- **Real-time monitoring** using chokidar for file system events
- **Streaming discovery** via async generators for efficient memory usage
- **Configurable watch paths** supporting local and remote mounted directories
- **File type filtering** (video, audio, subtitle, torrent files)

### 2. Plugin-Based Metadata Extraction

Metadata extraction is handled by plugins that can be enabled/disabled and configured:

- **file-info** - Basic file info, MIME type, midhash256 content identifier
- **ffmpeg** - Duration, codec, resolution, bitrate, audio tracks, subtitles via FFprobe
- **filename-parser** - Extract title, year, season, episode, quality from filenames
- **jellyfin-nfo** - Parse NFO sidecar files (Jellyfin/Kodi format)
- **tmdb** - Fetch rich metadata from The Movie Database API
- **anime-detector** - Detect anime content from keywords and audio tracks
- **language** - Aggregate languages from all streams (ISO 639-3)
- **subtitle** - Find sibling subtitle files and detect language
- **torrent** - Parse .torrent file metadata
- **full-hash** - Compute SHA-256 hash of entire file (background)

### 3. KV Storage

- **Nested key architecture** for property-level granularity
- **Leader election** via flock for high availability
- **Service discovery** via shared filesystem
- **CRDT-compatible** for distributed synchronization

```
Key Structure:
/file/{midhash256}/title      → "Inception"
/file/{midhash256}/year       → "2010"
/file/{midhash256}/video/codec → "h265"
/file/{midhash256}/audio/0/language → "en"
/file/{midhash256}/filePath   → "media1/Movies/Inception (2010)/Inception.mkv"
                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                 Relative to FILES_VOLUME (/files)
```

### 4. Remote Mount Management

- **NFS shares** - Network file systems
- **SMB/CIFS** - Windows network shares with credentials
- **rclone** - Cloud storage (Google Drive, Dropbox, S3, etc.)
- **Automatic mounting** on startup
- **Mounts created inside FILES_VOLUME** for shared access by all services

Mounts are created inside `/files/` (FILES_VOLUME) so all services can access them:

```bash
# Example mount structure
/files/                       # FILES_VOLUME
├── media1/                   # Local folder bind mount from host
├── media2/                   # Another local folder
├── smb/                      # SMB/CIFS remote mounts
│   └── nas-share/           # SMB: //server/share
├── nfs/                      # NFS remote mounts
│   └── server-media/        # NFS: nas.local:/volume1/media
└── gdrive/                   # rclone: gdrive:Media
```

---

## Configuration

### Environment Variables

```bash
# Volume paths
META_CORE_PATH=/meta-core        # Infrastructure volume
FILES_PATH=/files                # Shared media volume

# Watch paths (comma-separated, relative to FILES_PATH or absolute)
WATCH_PATHS=/files

# Processing configuration
MAX_WORKER_THREADS=16            # Defaults to CPU count
LIGHT_PROCESSING_TIMEOUT_MS=120000
HASH_PROCESSING_TIMEOUT_MS=7200000

# Remote mount configuration
REMOTE_STORAGE_CONFIG=/meta-core/config/remote-storage.conf
```

### Remote Storage Configuration

Create `/meta-core/config/remote-storage.conf`:

```conf
# NFS mount (into FILES_VOLUME)
nfs://nas.local:/volume1/media /files/nfs/nas-media nfs defaults,rw 0 0

# SMB mount (credentials in separate file)
//server/share /files/smb/nas-share cifs credentials=/meta-core/config/smb-creds.txt,uid=1000 0 0

# rclone mount
gdrive: /files/gdrive rclone vfs-cache-mode=full 0 0
```

---

## API

### REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Service health check |
| `/api/scan/trigger` | POST | Trigger manual folder scan |
| `/api/processing/status` | GET | Current pipeline state |
| `/api/metrics` | GET | Performance metrics |
| `/api/mounts` | GET | List mounted remote storage |
| `/api/mounts` | POST | Add new remote mount |
| `/api/mounts/{id}` | DELETE | Remove remote mount |

### Processing Status Response

```json
{
  "totalPending": 150,
  "totalLightProcessing": 16,
  "totalHashProcessing": 8,
  "totalDone": 45000,
  "totalFilesInVFS": 45150,
  "throughput": {
    "filesPerSecond": 34,
    "avgLightProcessingMs": 470,
    "avgHashProcessingMs": 15000
  }
}
```

---

## Usage

### Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build

# Run in development mode
pnpm run dev
```

### Docker

```bash
# Build and run with Docker Compose
docker-compose up -d

# Check health
curl http://localhost/health
curl http://localhost/api/processing/status
```

---

## License

MIT License - see LICENSE file for details.
