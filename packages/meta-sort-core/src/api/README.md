# FUSE API for Meta-Mesh

This module provides a FUSE-compatible HTTP API that runs alongside meta-mesh's hardlink system. The API exposes a virtual filesystem that can be consumed by a future FUSE driver.

## Overview

The FUSE API runs **always-on alongside hardlinks**, providing:

- **Dual output**: Both hardlinks (for local access) and virtual filesystem (for FUSE driver)
- **Dynamic updates**: VirtualFileSystem rebuilds on every processing cycle
- **Virtual .meta files**: Metadata files are generated on-the-fly without disk I/O
- **HTTP REST API**: Can be consumed by local or remote FUSE drivers
- **Zero configuration**: Always enabled, no opt-in required

## Architecture

### Components

1. **VirtualFileSystem** - In-memory representation of the output directory structure
2. **FuseAPIServer** - HTTP REST API server exposing FUSE operations
3. **FuseAPI** - TypeScript interfaces defining the API contract

### Data Flow

```
Input Files → File Processing → Metadata Extraction → Duplicate Removal
    ↓
Virtual Folder Structure Computation (diff generation)
    ↓
    ├─→ VirtualFileSystem Build (in-memory) → FUSE API Server → Future FUSE Driver
    │
    └─→ Hardlink Creation (on disk) → Direct File Access
```

Both outputs are generated in parallel from the same computed folder structure.

## Configuration

The FUSE API is **always enabled** and runs alongside hardlinks. You can optionally configure the server port and host:

```bash
# FUSE API Server configuration (optional)
FUSE_API_PORT=3000        # Default: 3000
FUSE_API_HOST=localhost   # Default: localhost
```

The API server starts automatically when meta-mesh starts.

## API Endpoints

The FUSE API Server exposes the following HTTP REST endpoints:

### Health & Info

- **GET /api/health** - Health check
  ```json
  { "status": "ok", "timestamp": "2025-01-15T10:30:00.000Z" }
  ```

- **GET /api/stats** - VFS statistics
  ```json
  {
    "fileCount": 1250,
    "directoryCount": 45,
    "totalSize": 52428800,
    "metaFileCount": 1250
  }
  ```

### Directory Operations

- **POST /api/readdir** - List directory contents
  ```json
  // Request
  { "path": "/Anime/Naruto/Season 1" }

  // Response
  { "entries": ["Naruto S01E01.mkv", "Naruto S01E01.mkv.meta", ...] }
  ```

### File Operations

- **POST /api/getattr** - Get file attributes
  ```json
  // Request
  { "path": "/Anime/Naruto/Season 1/Naruto S01E01.mkv" }

  // Response
  {
    "size": 524288000,
    "mode": 33188,  // 0o100644 (regular file, rw-r--r--)
    "mtime": 1705315200,
    "atime": 1705315200,
    "ctime": 1705315200,
    "nlink": 1,
    "uid": 1000,
    "gid": 1000
  }
  ```

- **POST /api/exists** - Check if path exists
  ```json
  // Request
  { "path": "/Anime/Naruto" }

  // Response
  { "exists": true }
  ```

- **POST /api/read** - Read file
  ```json
  // Request
  { "path": "/Anime/Naruto/Season 1/Naruto S01E01.mkv" }

  // Response (regular file)
  {
    "sourcePath": "/data/input/naruto_01.mkv",
    "size": 524288000
  }

  // Response (virtual .meta file)
  {
    "sourcePath": null,
    "content": "..base64-encoded content..",
    "contentEncoding": "base64",
    "size": 1024
  }
  ```

- **POST /api/metadata** - Get file metadata
  ```json
  // Request
  { "path": "/Anime/Naruto/Season 1/Naruto S01E01.mkv" }

  // Response
  {
    "title": "Naruto",
    "season": "01",
    "episode": "01",
    "anime": true,
    "sha256": "abc123...",
    // ... full HashMeta object
  }
  ```

### Tree Operations

- **GET /api/tree** - Get complete VFS tree structure
- **GET /api/files** - Get all file paths
- **GET /api/directories** - Get all directory paths
- **POST /api/refresh** - Refresh VFS (no-op, VFS updates automatically)

## Usage Example

### Starting meta-mesh with FUSE API

The FUSE API starts automatically with meta-mesh:

```bash
# Run meta-mesh (FUSE API starts automatically on port 3000)
pnpm run start:mesh

# Or customize the port
export FUSE_API_PORT=8080
pnpm run start:mesh
```

You'll see output like:
```
FUSE API Server started on http://localhost:3000
VirtualFileSystem build took 15ms
VirtualFileSystem: 1250 files (1250 .meta), 45 directories, 50.00 MB
```

### Consuming the API

```typescript
import { VirtualFileSystem, FuseAPIServer } from '@metazla/meta-mesh/api';

// Create VFS instance
const vfs = new VirtualFileSystem({
  fileMode: 0o644,
  directoryMode: 0o755,
  uid: process.getuid(),
  gid: process.getgid()
});

// Build from computed structure
vfs.buildFromComputed(sourceToDestMap, metadataMap);

// Start API server
const server = new FuseAPIServer(vfs, {
  port: 3000,
  host: 'localhost'
});

await server.start();
```

### FUSE Driver Integration

A FUSE driver would make HTTP requests to these endpoints:

```typescript
// Example pseudo-code for FUSE driver
async function readdir(path: string): Promise<string[]> {
  const response = await fetch('http://localhost:3000/api/readdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });

  const { entries } = await response.json();
  return entries;
}

async function read(path: string): Promise<Buffer> {
  const response = await fetch('http://localhost:3000/api/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });

  const result = await response.json();

  if (result.sourcePath) {
    // Regular file - read from source
    return fs.readFileSync(result.sourcePath);
  } else {
    // Virtual file - use provided content
    return Buffer.from(result.content, 'base64');
  }
}
```

## Virtual .meta Files

`.meta` files are entirely virtual and generated on-the-fly:

- **No disk I/O**: Content is serialized from in-memory metadata
- **Always up-to-date**: Reflects current metadata state
- **YAML format**: Uses `MetaMeshFormat.serialize()` for consistency
- **No source path**: `sourcePath` is `null`, `content` contains the YAML

## Events

The VirtualFileSystem emits events for monitoring:

```typescript
vfs.on('vfs-updated', () => {
  console.log('Virtual filesystem updated');
});

vfs.on('file-added', (path: string) => {
  console.log(`File added: ${path}`);
});

vfs.on('file-removed', (path: string) => {
  console.log(`File removed: ${path}`);
});

vfs.on('directory-added', (path: string) => {
  console.log(`Directory added: ${path}`);
});
```

## Performance

The VirtualFileSystem is highly performant:

- **In-memory**: All operations are O(1) or O(n) in-memory
- **No disk I/O**: Except for reading source files when FUSE driver requests content
- **Lazy .meta generation**: Content is only serialized when requested
- **Fast updates**: Rebuilding the VFS takes milliseconds

## Dual Output: Hardlinks + FUSE API

Meta-mesh now provides **both** output methods simultaneously:

| Feature | Hardlinks | FUSE API | Best For |
|---------|-----------|----------|----------|
| Disk usage | 1 inode per file | 0 (virtual) | Hardlinks: local use |
| Update speed | Slow (file I/O) | Fast (in-memory) | FUSE: frequent updates |
| .meta files | Written to disk | Virtual (on-demand) | FUSE: dynamic metadata |
| Remote access | No | Yes (HTTP) | FUSE: network drives |
| Compatibility | Any filesystem | Requires FUSE driver | Hardlinks: broad compat |
| Access method | Direct file access | HTTP + FUSE driver | Hardlinks: native apps |

**Use hardlinks** for local applications like Jellyfin, Plex, Kodi that read files directly.

**Use FUSE API** for future FUSE drivers that want dynamic, virtual filesystem access.

## Future Enhancements

- **WebSocket support**: Real-time updates for FUSE drivers
- **Authentication**: API key or JWT-based auth
- **Compression**: Gzip/Brotli for API responses
- **Caching**: ETag/Last-Modified headers
- **Batch operations**: Multi-file operations in single request
