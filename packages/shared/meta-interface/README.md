# Meta Interface

Shared TypeScript interfaces and types for the Meta Orbit ecosystem, providing type definitions used across all packages.

## Overview

Meta Interface is the foundational package that defines common TypeScript interfaces, types, and constants shared across the entire Meta Orbit monorepo. It has no dependencies and serves as the base layer for type safety.

## Features

- **Zero Dependencies**: Foundation package with no external dependencies
- **Type Definitions**: Comprehensive TypeScript interfaces for metadata structures
- **Shared Constants**: Common enums and constant values
- **Platform Agnostic**: Works in both Node.js and browser environments
- **Strict Typing**: Enables type safety across all packages

## Installation

This package is automatically available in the monorepo workspace:
```json
{
  "dependencies": {
    "@metazla/meta-interface": "workspace:*"
  }
}
```

## Usage

```typescript
import type {
  HashMeta,
  FileMetadata,
  VideoType,
  MediaType
} from '@metazla/meta-interface';

// Use interfaces for type safety
const metadata: HashMeta = {
  cid_sha256: 'baejbei...',
  fileName: 'episode.mkv',
  sizeByte: '1024000',
  videoType: 'tvshow',
  season: '1',
  episode: '1',
  titles: { eng: 'Show Name' }
};
```

## Key Interfaces

### HashMeta
Complete metadata structure for media files:
```typescript
interface HashMeta {
  // Content identifiers
  cid_sha1?: string;
  cid_sha256?: string;
  cid_md5?: string;
  cid_sha3_256?: string;
  cid_sha3_384?: string;
  cid_crc32?: string;

  // File information
  fileName: string;
  extension?: string;
  sizeByte: string;
  fileType?: MediaType;

  // Video metadata
  videoType?: VideoType;
  season?: string;
  episode?: string;
  originalTitle?: string;
  titles?: Record<string, string>;

  // Classification
  anime?: string;
  genres?: string[];
  languages?: string[];
  tags?: string[];

  // Paths
  privateFilePath?: string;
  publicFilePath?: string;
}
```

### VideoType
```typescript
type VideoType = 'movie' | 'tvshow' | 'anime' | 'documentary' | 'unknown';
```

### MediaType
```typescript
type MediaType = 'video' | 'audio' | 'image' | 'document' | 'unknown';
```

## Architecture

### Build Configuration
Built with `tsup` for dual output:
- **ESM**: `dist/index.js`
- **CommonJS**: `dist/index.cjs`

### Package Structure
```
meta-interface/
├── src/
│   └── lib/
│       ├── interfaces.ts     # Core interface definitions
│       ├── types.ts          # Type aliases and unions
│       ├── constants.ts      # Shared constants
│       └── index.ts          # Public exports
├── package.json
└── tsconfig.json
```

## Development

### Building

```bash
# From monorepo root
pnpm run build

# From package directory
cd packages/meta-interface
pnpm run build
```

### Testing

```bash
cd packages/meta-interface
pnpm test
```

Uses Mocha for type validation and interface tests.

## Used By

All packages in the monorepo depend on meta-interface:
- **meta-hash**: Hash metadata structures
- **meta-db**: Database record types
- **meta-mesh**: File processing interfaces
- **meta-orbit**: Network message types
- **meta-ui**: UI component prop types
- **filename-tool**: Parsing result types

## Dependency Flow

```
meta-interface (foundation, no deps)
    ↓
All other packages depend on it
```

This ensures:
- Consistent types across the entire codebase
- Single source of truth for interfaces
- Type safety in all inter-package communication

## Contributing

When adding new interfaces:
1. Add to appropriate file in `src/lib/`
2. Export from `src/lib/index.ts`
3. Document with JSDoc comments
4. Ensure backward compatibility

This package is part of the Meta Orbit monorepo. See the root README for contribution guidelines.

## License

MIT - Same as Meta Orbit monorepo