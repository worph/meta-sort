# Containerized Plugin Architecture

## Document Purpose

This document describes the containerized plugin architecture for MetaMesh. Plugins run as isolated Docker containers, enabling multi-language support, specialized tooling per plugin, and an open ecosystem for third-party plugin development. This document covers the container lifecycle, plugin HTTP API, meta-core KV extensions, task dispatch mechanism, and plugin development guidelines.

---

## Overview

### Motivation

The containerized plugin architecture addresses several limitations of in-process plugins:

| Challenge | Solution |
|-----------|----------|
| **Dependency bloat** | FFmpeg, Whisper, ML libs each in their own image |
| **Language lock-in** | Plugins can be written in any language |
| **Fault isolation** | Crashing plugin doesn't take down meta-sort |
| **Independent updates** | Update a plugin without redeploying meta-sort |
| **Open ecosystem** | Third-party developers can contribute plugins easily |

### Core Design Principles

1. **Container isolation**: Each plugin runs in its own Docker container
2. **Shared volumes**: Plugins access files via read-only `/files` volume
3. **Direct KV access**: Plugins write metadata directly to meta-core API
4. **Async processing**: Non-blocking task dispatch with callback notifications
5. **Docker socket orchestration**: meta-sort manages plugin containers via Docker API

---

## Architecture

### System Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  meta-sort container                                                         │
│                                                                              │
│  ┌────────────────────┐      ┌─────────────────────┐                        │
│  │   meta-sort-core   │◄────►│   meta-core sidecar │                        │
│  │                    │      │   (localhost:9000)  │                        │
│  │  - Plugin config   │      │                     │                        │
│  │  - Task scheduler  │      │  - KV API           │                        │
│  │  - Docker mgmt     │      │  - Leader election  │                        │
│  │  - Callback handler│      │  - Redis            │                        │
│  └─────────┬──────────┘      └──────────┬──────────┘                        │
│            │                            │                                    │
│  /var/run/docker.sock (mounted)         │                                    │
└────────────┼────────────────────────────┼────────────────────────────────────┘
             │                            │
             │ spawns & manages           │
             │                            │
   ┌─────────┴─────────┬─────────────────┐│
   │                   │                  ││
   ▼                   ▼                  ▼│
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ plugin-      │ │ plugin-      │ │ plugin-      │
│ ffmpeg       │ │ tmdb         │ │ whisper      │
│              │ │              │ │              │
│ :8080        │ │ :8080        │ │ :8080        │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │  meta-core API      │
             │  (meta-sort:9000)   │
             │                     │
             │  PATCH /meta/{cid}  │
             │  PUT /meta/{cid}/.. │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │  Redis              │
             │  (leader-managed)   │
             └─────────────────────┘
```

### Shared Resources

All plugin containers share these Docker resources:

| Resource | Mount | Access | Purpose |
|----------|-------|--------|---------|
| `files-volume` | `/files` | Read-only | Media files to process |
| `meta-network` | - | Network | Communication with meta-core |

---

## Plugin Container Specification

### HTTP API

Every plugin container exposes an HTTP server on port 8080 with these endpoints:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Plugin Container API (port 8080)                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  GET  /health              Health check (required)                           │
│  GET  /manifest            Plugin manifest JSON (required)                   │
│  POST /configure           Receive configuration (required)                  │
│  POST /process             Process a file (required)                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### GET /health

Returns plugin health status. Meta-sort polls this endpoint after container startup.

**Response:**
```json
{
  "status": "healthy",
  "ready": true,
  "version": "1.0.0"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `"healthy"` or `"unhealthy"` |
| `ready` | boolean | Whether plugin can accept `/process` requests |
| `version` | string | Plugin version |

#### GET /manifest

Returns the plugin manifest describing capabilities, dependencies, and schemas.

**Response:**
```json
{
  "id": "ffmpeg",
  "name": "FFmpeg Metadata",
  "version": "1.0.0",
  "description": "Extracts video/audio/subtitle stream metadata using FFprobe",
  "author": "MetaMesh Team",
  "repository": "https://github.com/worph/metamesh-plugin-ffmpeg",

  "priority": 15,
  "queue": "fast",
  "timeout": 30000,

  "dependencies": ["file-info"],

  "filter": {
    "mimeTypes": ["video/*", "audio/*"]
  },

  "configSchema": {},

  "dataSchema": {
    "fileinfo/duration": {
      "label": "Duration",
      "type": "string",
      "readonly": true
    },
    "fileinfo/formatName": {
      "label": "Format Name",
      "type": "string",
      "readonly": true
    }
  },

  "ui": {
    "color": "#4CAF50"
  }
}
```

#### POST /configure

Receives configuration values from meta-sort. Called after container startup, before any `/process` calls.

**Request:**
```json
{
  "apiKey": "your-api-key",
  "language": "en"
}
```

**Response:**
```json
{
  "success": true
}
```

Or on validation error:
```json
{
  "success": false,
  "error": "apiKey is required"
}
```

#### POST /process

Receives a file processing task. Returns immediately with `accepted` status; plugin processes asynchronously and notifies via callback.

**Request:**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "cid": "midhash256:abc123def456",
  "filePath": "/files/movies/Movie.2024.1080p.mkv",
  "callbackUrl": "http://meta-sort:8180/api/plugins/callback",
  "metaCoreUrl": "http://meta-sort:9000",
  "existingMeta": {
    "file/type": "video",
    "file/mime": "video/x-matroska",
    "file/size": "4294967296"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | string | Unique task identifier (UUID) |
| `cid` | string | Content identifier (midhash256) |
| `filePath` | string | Absolute path to file in container |
| `callbackUrl` | string | URL to POST completion notification |
| `metaCoreUrl` | string | meta-core API base URL for KV operations |
| `existingMeta` | object | Metadata from previous plugins (flat key-value) |

**Response (immediate):**
```json
{
  "status": "accepted",
  "taskId": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## Plugin Manifest Schema

The manifest describes plugin capabilities and is fetched via `GET /manifest`.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (lowercase, alphanumeric, hyphens) |
| `name` | string | Human-readable display name |
| `version` | string | Semantic version (e.g., "1.0.0") |
| `priority` | number | Execution order (lower = earlier, 10-100 range) |
| `queue` | string | `"fast"` or `"background"` |
| `dataSchema` | object | Metadata keys this plugin writes |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Brief description of functionality |
| `author` | string | Plugin author or organization |
| `repository` | string | Source code repository URL |
| `timeout` | number | Max processing time in milliseconds (default: 30000) |
| `dependencies` | string[] | Plugin IDs that must run first |
| `filter` | object | File filter criteria |
| `configSchema` | object | Configuration options schema |
| `ui` | object | UI display hints |

### Filter Schema

```json
{
  "filter": {
    "mimeTypes": ["video/*", "audio/*"],
    "extensions": ["mkv", "mp4", "avi"],
    "minSize": 1048576,
    "maxSize": 107374182400
  }
}
```

Filters are combined with AND logic. If no filter is specified, plugin processes all files.

### Config Schema

```json
{
  "configSchema": {
    "apiKey": {
      "type": "string",
      "label": "API Key",
      "required": true,
      "secret": true,
      "default": ""
    },
    "language": {
      "type": "select",
      "label": "Language",
      "default": "en",
      "options": [
        { "value": "en", "label": "English" },
        { "value": "ja", "label": "Japanese" }
      ]
    },
    "includeAdult": {
      "type": "boolean",
      "label": "Include Adult Content",
      "default": false
    }
  }
}
```

### Data Schema

```json
{
  "dataSchema": {
    "fileinfo/duration": {
      "label": "Duration",
      "type": "string",
      "readonly": true
    },
    "fileinfo/streamdetails/video": {
      "label": "Video Streams",
      "type": "json",
      "pattern": "fileinfo/streamdetails/video/{n}/*",
      "hint": "Video codec, resolution, bitrate"
    },
    "genres": {
      "label": "Genres",
      "type": "set",
      "hint": "Multiple values allowed"
    }
  }
}
```

---

## meta-core KV API

Plugins write metadata directly to meta-core. The API supports individual property operations and batch updates.

### Endpoints

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  meta-core KV API (port 9000)                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  GET    /meta/{cid}                   Get all metadata for file              │
│  PUT    /meta/{cid}                   Replace all metadata                   │
│  PATCH  /meta/{cid}                   Merge metadata (partial update)        │
│  DELETE /meta/{cid}                   Delete all metadata                    │
│                                                                              │
│  GET    /meta/{cid}/{key...}          Get single property                    │
│  PUT    /meta/{cid}/{key...}          Set single property                    │
│  DELETE /meta/{cid}/{key...}          Delete single property                 │
│                                                                              │
│  POST   /meta/{cid}/_add/{key...}     Add value to set field                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### PATCH /meta/{cid}

Merges properties into existing metadata. This is the primary endpoint for plugins.

**Request:**
```http
PATCH /meta/midhash256:abc123def456
Content-Type: application/json

{
  "fileinfo/duration": "7200",
  "fileinfo/formatName": "matroska",
  "fileinfo/streamdetails/video/0/codec": "h265",
  "fileinfo/streamdetails/video/0/width": "1920",
  "fileinfo/streamdetails/video/0/height": "1080"
}
```

**Response:**
```json
{
  "success": true,
  "updated": 5
}
```

### PUT /meta/{cid}/{key...}

Sets a single property value.

**Request:**
```http
PUT /meta/midhash256:abc123def456/fileinfo/duration
Content-Type: text/plain

7200
```

**Response:**
```json
{
  "success": true
}
```

### GET /meta/{cid}/{key...}

Gets a single property value.

**Request:**
```http
GET /meta/midhash256:abc123def456/fileinfo/duration
```

**Response:**
```
7200
```

### POST /meta/{cid}/_add/{key...}

Adds a value to a set field (for multi-value fields like genres, tags).

**Request:**
```http
POST /meta/midhash256:abc123def456/_add/genres
Content-Type: text/plain

Action
```

**Response:**
```json
{
  "success": true
}
```

### Redis Storage Format

Properties are stored as individual Redis keys:

```
/file/{cid}/{property/path} → value

Examples:
/file/midhash256:abc123/file/name           → "Movie.2024.mkv"
/file/midhash256:abc123/fileinfo/duration   → "7200"
/file/midhash256:abc123/genres              → "Action|Adventure|Sci-Fi"  (set, pipe-delimited)
```

---

## Task Dispatch and Callbacks

### Dispatch Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TASK DISPATCH                                   │
└─────────────────────────────────────────────────────────────────────────────┘

1. File discovered, CID computed by meta-sort

2. meta-sort builds dependency graph:

   file-info (p:10)
       │
       ├──► ffmpeg (p:15)
       │        │
       └──► filename-parser (p:20)
                │
                ├──► jellyfin-nfo (p:25)
                │
                └──► anime-detector (p:28)
                         │
                         └──► tmdb (p:30)

3. Dispatch to ready plugins (dependencies satisfied):

   POST http://plugin-file-info:8080/process
   {
     "taskId": "task-001",
     "cid": "midhash256:abc123",
     "filePath": "/files/movie.mkv",
     "callbackUrl": "http://meta-sort:8180/api/plugins/callback",
     "metaCoreUrl": "http://meta-sort:9000",
     "existingMeta": {}
   }

4. Plugin processes asynchronously:
   - Reads file from /files volume
   - Extracts metadata
   - Writes to meta-core: PATCH /meta/midhash256:abc123

5. Plugin sends callback:

   POST http://meta-sort:8180/api/plugins/callback
   {
     "taskId": "task-001",
     "pluginId": "file-info",
     "cid": "midhash256:abc123",
     "status": "completed",
     "duration": 523
   }

6. meta-sort receives callback:
   - Marks file-info task complete
   - Dispatches ffmpeg + filename-parser (now unblocked)
   - Continues until all plugins complete
```

### Callback Payload

**Success:**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "pluginId": "ffmpeg",
  "cid": "midhash256:abc123def456",
  "status": "completed",
  "duration": 1523
}
```

**Failure:**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "pluginId": "ffmpeg",
  "cid": "midhash256:abc123def456",
  "status": "failed",
  "error": "FFprobe timeout after 30s",
  "duration": 30000
}
```

**Skipped (file doesn't match filter):**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "pluginId": "ffmpeg",
  "cid": "midhash256:abc123def456",
  "status": "skipped",
  "reason": "File mime type text/plain does not match filter",
  "duration": 2
}
```

### Callback Endpoint

meta-sort exposes a callback endpoint:

```
POST /api/plugins/callback

Headers:
  Content-Type: application/json

Body: (callback payload above)

Response:
  200 OK
  { "received": true }
```

---

## meta-sort Plugin Configuration

### Configuration File

Plugin configuration is stored in meta-sort's config directory:

```yaml
# /meta-core/config/plugins.yml

plugins:
  file-info:
    enabled: true
    image: ghcr.io/worph/metamesh-plugin-file-info:main
    instances: 1

  ffmpeg:
    enabled: true
    image: ghcr.io/worph/metamesh-plugin-ffmpeg:main
    instances: 2
    resources:
      memory: 512m
      cpus: 1.0

  tmdb:
    enabled: true
    image: ghcr.io/worph/metamesh-plugin-tmdb:main
    instances: 1
    config:
      apiKey: "${TMDB_API_KEY}"
      language: "en"

  whisper:
    enabled: false
    image: ghcr.io/worph/metamesh-plugin-whisper:main
    instances: 1
    resources:
      memory: 4g
      cpus: 2.0
```

### Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Whether to spawn this plugin |
| `image` | string | required | Docker image name and tag |
| `instances` | number | `1` | Number of container instances |
| `resources.memory` | string | - | Memory limit (e.g., "512m", "4g") |
| `resources.cpus` | number | - | CPU limit (e.g., 1.0, 2.5) |
| `config` | object | `{}` | Plugin-specific configuration values |

### Environment Variable Substitution

Configuration values support environment variable substitution:

```yaml
config:
  apiKey: "${TMDB_API_KEY}"           # From environment
  language: "${LANG:-en}"             # With default
```

---

## Container Lifecycle

### Startup Sequence

```
1. meta-sort starts
   │
   ├── Load plugins.yml configuration
   │
   ├── Connect to Docker socket
   │
   └── For each enabled plugin:
       │
       ├── Check if container exists
       │   ├── Yes: Check health, reuse if healthy
       │   └── No: Continue to create
       │
       ├── Pull image if not present
       │   docker pull ghcr.io/worph/metamesh-plugin-ffmpeg:main
       │
       ├── Create and start container
       │   docker run -d \
       │     --name plugin-ffmpeg-1 \
       │     --network meta-network \
       │     -v files-volume:/files:ro \
       │     --memory 512m \
       │     --cpus 1.0 \
       │     ghcr.io/worph/metamesh-plugin-ffmpeg:main
       │
       ├── Wait for health check (30s timeout)
       │   GET http://plugin-ffmpeg-1:8080/health
       │   └── Retry every 1s until ready=true
       │
       ├── Fetch manifest
       │   GET http://plugin-ffmpeg-1:8080/manifest
       │   └── Store in memory: id, priority, dependencies, schemas
       │
       └── Send configuration
           POST http://plugin-ffmpeg-1:8080/configure
           { "apiKey": "..." }
```

### Shutdown Sequence

```
1. meta-sort receives shutdown signal
   │
   ├── Stop accepting new files
   │
   ├── Wait for in-flight tasks (30s timeout)
   │
   └── For each plugin container:
       │
       ├── Send SIGTERM
       │   docker stop plugin-ffmpeg-1 -t 10
       │
       └── Remove container
           docker rm plugin-ffmpeg-1
```

### Container Naming Convention

```
plugin-{id}-{instance}

Examples:
  plugin-ffmpeg-1
  plugin-ffmpeg-2
  plugin-tmdb-1
  plugin-whisper-1
```

---

## Networking

### Docker Network

All plugin containers join a shared Docker network:

```bash
docker network create meta-network
```

Container hostnames on this network:
- `meta-sort` - meta-sort container (includes meta-core on :9000)
- `plugin-ffmpeg-1` - first ffmpeg instance
- `plugin-tmdb-1` - tmdb instance

### Port Mapping

Plugin containers do not expose ports to the host. All communication happens on the Docker network:

| Service | Internal Port | External | Purpose |
|---------|---------------|----------|---------|
| meta-sort | 8180 | Yes | meta-sort API + callback endpoint |
| meta-core | 9000 | No | KV API (accessed via meta-sort hostname) |
| plugin-* | 8080 | No | Plugin API |

### DNS Resolution

Plugins reach meta-core using the meta-sort container hostname:

```
metaCoreUrl: "http://meta-sort:9000"
callbackUrl: "http://meta-sort:8180/api/plugins/callback"
```

---

## Plugin Development Guide

### Minimal Plugin (Python Example)

```python
# plugin-example/main.py

from flask import Flask, request, jsonify
import requests
import os

app = Flask(__name__)

config = {}

@app.route('/health')
def health():
    return jsonify({
        'status': 'healthy',
        'ready': True,
        'version': '1.0.0'
    })

@app.route('/manifest')
def manifest():
    return jsonify({
        'id': 'example',
        'name': 'Example Plugin',
        'version': '1.0.0',
        'description': 'A minimal example plugin',
        'priority': 50,
        'queue': 'fast',
        'timeout': 10000,
        'dependencies': ['file-info'],
        'filter': {
            'mimeTypes': ['video/*']
        },
        'configSchema': {},
        'dataSchema': {
            'example/processed': {
                'label': 'Processed',
                'type': 'string',
                'readonly': True
            }
        },
        'ui': {
            'color': '#9C27B0'
        }
    })

@app.route('/configure', methods=['POST'])
def configure():
    global config
    config = request.json or {}
    return jsonify({'success': True})

@app.route('/process', methods=['POST'])
def process():
    data = request.json
    task_id = data['taskId']
    cid = data['cid']
    file_path = data['filePath']
    callback_url = data['callbackUrl']
    meta_core_url = data['metaCoreUrl']

    # Process asynchronously
    import threading
    threading.Thread(
        target=process_file,
        args=(task_id, cid, file_path, callback_url, meta_core_url)
    ).start()

    return jsonify({
        'status': 'accepted',
        'taskId': task_id
    })

def process_file(task_id, cid, file_path, callback_url, meta_core_url):
    import time
    start = time.time()

    try:
        # Do actual processing here
        # For example: read file, extract metadata

        # Write to meta-core
        requests.patch(
            f'{meta_core_url}/meta/{cid}',
            json={
                'example/processed': 'true',
                'example/timestamp': str(int(time.time()))
            }
        )

        # Send success callback
        duration = int((time.time() - start) * 1000)
        requests.post(callback_url, json={
            'taskId': task_id,
            'pluginId': 'example',
            'cid': cid,
            'status': 'completed',
            'duration': duration
        })

    except Exception as e:
        # Send failure callback
        duration = int((time.time() - start) * 1000)
        requests.post(callback_url, json={
            'taskId': task_id,
            'pluginId': 'example',
            'cid': cid,
            'status': 'failed',
            'error': str(e),
            'duration': duration
        })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
```

### Dockerfile

```dockerfile
# plugin-example/Dockerfile

FROM python:3.11-slim

WORKDIR /app

RUN pip install flask requests

COPY main.py .

EXPOSE 8080

CMD ["python", "main.py"]
```

### Building and Testing

```bash
# Build image locally
docker build -t my-plugin-example:dev ./plugin-example

# Test locally
docker run -d \
  --name plugin-example-test \
  -p 8080:8080 \
  my-plugin-example:dev

# Check health
curl http://localhost:8080/health

# Check manifest
curl http://localhost:8080/manifest

# Cleanup
docker stop plugin-example-test && docker rm plugin-example-test
```

**Note:** Production images are built via GitHub Actions and published to GitHub Container Registry (ghcr.io/worph/metamesh-plugin-*).

### TypeScript Plugin Template

```typescript
// plugin-example/src/index.ts

import Fastify from 'fastify';

const app = Fastify();

let config: Record<string, unknown> = {};

const manifest = {
  id: 'example-ts',
  name: 'Example TypeScript Plugin',
  version: '1.0.0',
  description: 'A TypeScript plugin template',
  priority: 50,
  queue: 'fast' as const,
  timeout: 10000,
  dependencies: ['file-info'],
  filter: { mimeTypes: ['video/*'] },
  configSchema: {},
  dataSchema: {
    'example/processed': {
      label: 'Processed',
      type: 'string',
      readonly: true
    }
  },
  ui: { color: '#2196F3' }
};

app.get('/health', async () => ({
  status: 'healthy',
  ready: true,
  version: manifest.version
}));

app.get('/manifest', async () => manifest);

app.post('/configure', async (req) => {
  config = req.body as Record<string, unknown>;
  return { success: true };
});

interface ProcessRequest {
  taskId: string;
  cid: string;
  filePath: string;
  callbackUrl: string;
  metaCoreUrl: string;
  existingMeta: Record<string, string>;
}

app.post<{ Body: ProcessRequest }>('/process', async (req) => {
  const { taskId, cid, filePath, callbackUrl, metaCoreUrl } = req.body;

  // Process asynchronously
  setImmediate(() => processFile(taskId, cid, filePath, callbackUrl, metaCoreUrl));

  return { status: 'accepted', taskId };
});

async function processFile(
  taskId: string,
  cid: string,
  filePath: string,
  callbackUrl: string,
  metaCoreUrl: string
) {
  const start = Date.now();

  try {
    // Do processing here...

    // Write to meta-core
    await fetch(`${metaCoreUrl}/meta/${cid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        'example/processed': 'true',
        'example/timestamp': String(Date.now())
      })
    });

    // Send success callback
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        pluginId: manifest.id,
        cid,
        status: 'completed',
        duration: Date.now() - start
      })
    });

  } catch (error) {
    // Send failure callback
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        pluginId: manifest.id,
        cid,
        status: 'failed',
        error: String(error),
        duration: Date.now() - start
      })
    });
  }
}

app.listen({ port: 8080, host: '0.0.0.0' });
```

---

## Error Handling

### Plugin Startup Failures

| Failure | Behavior |
|---------|----------|
| Image pull fails | Log error, skip plugin, continue startup |
| Container won't start | Log error, skip plugin, continue startup |
| Health check timeout | Log error, remove container, skip plugin |
| Manifest fetch fails | Log error, remove container, skip plugin |
| Configure fails | Log error, remove container, skip plugin |

### Task Processing Failures

| Failure | Behavior |
|---------|----------|
| Plugin returns error | Mark task failed, continue with other plugins |
| Callback timeout (60s) | Mark task failed, log warning |
| Plugin container dies | Restart container, requeue pending tasks |
| meta-core unreachable | Plugin retries 3x, then fails task |

### Retry Policy

Tasks are retried on transient failures:

```yaml
retry:
  maxAttempts: 3
  backoff: exponential
  initialDelay: 1000    # ms
  maxDelay: 30000       # ms
```

---

## Monitoring

### Plugin Status API

meta-sort exposes plugin status:

```
GET /api/plugins

Response:
{
  "plugins": [
    {
      "id": "ffmpeg",
      "name": "FFmpeg Metadata",
      "version": "1.0.0",
      "status": "healthy",
      "instances": 2,
      "containers": [
        { "name": "plugin-ffmpeg-1", "status": "running" },
        { "name": "plugin-ffmpeg-2", "status": "running" }
      ],
      "stats": {
        "tasksCompleted": 1523,
        "tasksFailed": 12,
        "avgDuration": 845
      }
    }
  ]
}
```

### Container Logs

```bash
# View plugin logs
docker logs plugin-ffmpeg-1 -f

# View all plugin logs
docker logs plugin-ffmpeg-1 plugin-tmdb-1 -f
```

### Health Monitoring

meta-sort continuously monitors plugin health:

```
Every 30 seconds:
  For each plugin container:
    GET /health
    If unhealthy for 3 consecutive checks:
      Restart container
      Requeue pending tasks
```

---

## Migration from In-Process Plugins

### Compatibility Layer

During migration, meta-sort supports both in-process and containerized plugins. The plugin type is determined by configuration:

```yaml
plugins:
  # In-process plugin (legacy)
  file-info:
    enabled: true
    type: internal

  # Containerized plugin
  ffmpeg:
    enabled: true
    image: ghcr.io/worph/metamesh-plugin-ffmpeg:main
```

### Migration Steps

1. **Convert manifest**: Transform `manifest.yml` to JSON endpoint response
2. **Implement HTTP API**: Add `/health`, `/manifest`, `/configure`, `/process`
3. **Update KV writes**: Change from in-memory KV to meta-core HTTP calls
4. **Containerize**: Create Dockerfile with required dependencies
5. **Test**: Verify output matches in-process plugin
6. **Deploy**: Update plugins.yml to use containerized version

---

## Summary

The containerized plugin architecture provides:

1. **Language flexibility**: Plugins can be written in any language
2. **Dependency isolation**: Each plugin has its own container with specialized tools
3. **Fault tolerance**: Crashing plugins don't affect meta-sort or other plugins
4. **Scalability**: Run multiple instances of slow plugins
5. **Open ecosystem**: Third-party developers can contribute plugins easily

The architecture maintains backward compatibility with the existing KV-based metadata model while enabling a new generation of plugins with advanced capabilities.
