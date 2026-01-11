# Meta-Hash

Meta-Hash is a TypeScript library designed to monitor a specified folder and compute hashes for any new files detected within it. This library leverages an index system to avoid recomputing hashes if the program is restarted, ensuring efficiency and continuity in hash computation. The hashes are computed in the Content Identifier (CID) format, making them compatible with systems like IPFS (InterPlanetary File System).

## Features

- **Platform Agnostic**: Dual builds for Node.js and browser environments
- **Efficient Hash Computation**: Computes hashes using multiple algorithms (SHA2-256, SHA1, MD5, SHA3-256, SHA3-384, CRC32)
- **Persistent Indexing**: CSV-based index system tracks file hashes, sizes, and modification times
- **CID Format**: Uses IPFS Content Identifiers (multiformat, multicodec, multihash)
- **Worker Thread Support**: Node.js build can use worker threads for parallel hashing
- **Incremental Hashing**: Only rehashes files when size or mtime changes
- **Multiple Hash Types**: Supports all major cryptographic and checksum algorithms

## CID Format and Inspection

The Content Identifier (CID) is a label used to point to material in IPFS. It doesn't indicate where the content is stored, but it forms a kind of address based on the content itself. CIDs are used as a standard way of pointing to pieces of information. A single CID can represent a piece of content that is distributed across multiple systems.

The list of CID formats used in this project can be found at the following link:
[Multicodecs Table](https://ipfs.io/ipfs/QmXec1jjwzxWJoNbxQF5KffL8q6hFXm9QwUGaa3wKGk6dT/#title=Multicodecs&src=https://raw.githubusercontent.com/multiformats/multicodec/master/table.csv)

To inspect the details of a CID, including its version, codec, multihash and more, you can use the CID Inspector tool. This tool allows you to enter a CID and it will break it down into its component parts and provide a detailed explanation of each part.

[CID Inspector Tool](https://cid.ipfs.tech/)

## Installation

This package is part of the Meta Orbit monorepo and uses pnpm workspaces.

From the monorepo root:
```bash
pnpm install
```

When using as a dependency in other packages:
```json
{
  "dependencies": {
    "@metazla/meta-hash": "workspace:*"
  }
}
```

## Usage of ComputeHashIndexCache

To integrate Meta-Hash into your application, follow these steps:

1. **Import the Library**: Import the necessary components from the library.

```typescript
import { ComputeHashIndexCache, CID_ALGORITHM_NAMES } from "./folder-watch-hasher";
```

2. **Initialize the Watcher**: Create an instance of `ComputeHashIndexCache`, specifying the path to the folder you want to monitor and the hash algorithms you wish to use.

```typescript
//note that the csv file will be derived from the path provided into multiple files (one for each algorithm)
const computer = new ComputeHashIndexCache("path/to/your/indexfile/index.csv", [CID_ALGORITHM_NAMES.sha256, CID_ALGORITHM_NAMES.sha1]);
```

3. **Compute Hashes**: Invoke the `computeMissingHash` method for each file you wish to hash. This method will automatically check the index for existing hashes and compute missing ones.

```typescript
let hash:MultiHashData = {};
await computer.computeMissingHash("path/to/your/file.txt", hash);
console.log(hash[CID_ALGORITHM_NAMES.sha256]);
```

## Example of Index File

An example index file (`index-cid_sha2-256.csv`) is shown below, demonstrating how file paths, sizes, modification times, and computed hashes are stored:

```
path,size,mtime,cid_sha2-256
file.mkv,230265591,2023-01-17T18:53:37.692Z,baejbeif45glg263244x7cbjzyd3ssp5edzae7bxurzxjhnogazcwmj32wa
...
```

## Contributing

Contributions to Meta-Hash are welcome! Please read our contributing guidelines for more information on how to participate.

## License

Meta-Hash is released under the [MIT License](LICENSE.md).


## Platform-Specific Builds

### Node.js Environment

```typescript
import { HashComputerIndexCache, CID_ALGORITHM_NAMES } from '@metazla/meta-hash';
import path from 'path';

// With worker threads for parallel processing
const packageEntryPath = path.dirname(import.meta.resolve("@metazla/meta-hash")) + "/worker.js";
const hashComputer = new HashComputerIndexCache(
  '/path/to/index/folder',
  [CID_ALGORITHM_NAMES.sha256, CID_ALGORITHM_NAMES.sha1],
  packageEntryPath
);

// Hash a file
const hashes = {};
await hashComputer.computeMissingHash('/path/to/file.mkv', hashes);
console.log(hashes[CID_ALGORITHM_NAMES.sha256]);
```

### Browser Environment

```typescript
import { HashComputerIndexCache, CID_ALGORITHM_NAMES } from '@metazla/meta-hash/index-browser';

// Browser build (no worker threads, uses Web Crypto API where available)
const hashComputer = new HashComputerIndexCache(
  '/virtual/index/path',
  [CID_ALGORITHM_NAMES.sha256]
);
```

## Architecture

### Build Configuration

Built with `tsup` for dual output:
- **Node.js**: `dist/index.js` (ESM) and `dist/index.cjs` (CommonJS)
- **Browser**: `dist/index-browser.js` (ESM) and `dist/index-browser.cjs` (CommonJS)

### Worker Thread Support (Node.js)

The Node.js build includes `worker.js` for parallel hash computation:
```typescript
// Automatic worker path resolution
const workerPath = path.join(
  path.dirname(import.meta.resolve('@metazla/meta-hash')),
  'worker.js'
);
```

## Development

### Building

```bash
# From monorepo root
pnpm run build

# From package directory
cd packages/meta-hash
pnpm run build
```

### Testing

```bash
cd packages/meta-hash
pnpm test
```

Uses Vitest for unit tests.

## Integration

Used by:
- **meta-mesh**: File content hashing for deduplication
- **meta-orbit**: Content addressing for distributed storage
- **meta-ui**: Browser-based file verification

## Performance

- **Index Cache**: Avoids rehashing unchanged files (checks size + mtime)
- **Worker Threads**: Parallel hashing on multi-core systems (Node.js only)
- **Streaming**: Hashes large files without loading into memory
- **CSV Index**: Fast lookup and incremental updates
