# Filename Tool

TypeScript library for extracting metadata from media filenames, designed for the Meta Orbit ecosystem.

## Overview

Filename Tool parses media filenames to extract structured metadata such as titles, seasons, episodes, quality, languages, and other relevant information. It's designed to work with various naming conventions used in media files.

## Features

- **Title Extraction**: Identifies show/movie titles from filenames
- **Episode & Season Detection**: Parses episode and season numbers in various formats
- **Quality Detection**: Identifies resolution (1080p, 720p, 4K) and quality indicators
- **Language Detection**: Extracts language codes and audio track information
- **Release Group**: Identifies fansub/release group tags
- **Format Support**: Handles multiple filename patterns and conventions
- **Platform Agnostic**: Dual builds for Node.js and browser environments

## Installation

From the monorepo root:
```bash
pnpm install
```

When using as a dependency:
```json
{
  "dependencies": {
    "@metazla/filename-tool": "workspace:*"
  }
}
```

## Usage

```typescript
import { FilenameParser } from '@metazla/filename-tool';

// Parse a filename
const result = FilenameParser.parse('[SubsPlease] Naruto - 01 (1080p) [12345678].mkv');

console.log(result);
// {
//   title: 'Naruto',
//   episode: 1,
//   season: 1,
//   quality: '1080p',
//   releaseGroup: 'SubsPlease',
//   hash: '12345678',
//   extension: 'mkv'
// }
```

## Supported Filename Patterns

### TV Shows
- `ShowName S01E01.mkv`
- `ShowName - 01.mkv`
- `[Group] ShowName - 01 (1080p).mkv`
- `ShowName.S01E01.1080p.WEB-DL.mkv`

### Movies
- `MovieName (2024) 1080p BluRay.mkv`
- `MovieName.2024.1080p.BluRay.x264.mkv`
- `[Group] MovieName (2024).mkv`

### Quality Detection
- Resolution: `1080p`, `720p`, `2160p`, `4K`, `8K`
- Source: `BluRay`, `WEB-DL`, `HDTV`, `DVDRip`
- Codec: `x264`, `x265`, `HEVC`, `AV1`

### Language Detection
- Audio languages: `eng`, `jpl`, `spa`, `fre`, etc.
- Subtitle languages: `[eng sub]`, `[multiple subs]`
- Dual audio: `[eng+jpl]`

## Architecture

### Build Configuration
Built with `tsup` for dual output:
- **Node.js**: `dist/index.js` (ESM) and `dist/index.cjs` (CommonJS)
- **Browser**: `dist/index-browser.js` (ESM) and `dist/index-browser.cjs` (CommonJS)

### Pattern Matching
Uses regex patterns and heuristics to handle various filename formats:
- Episode number detection with multiple patterns
- Title cleanup (remove tags, group names)
- Quality and resolution parsing
- Hash/CRC extraction

## Development

### Building

```bash
# From monorepo root
pnpm run build

# From package directory
cd packages/filename-tool
pnpm run build
```

### Testing

```bash
cd packages/filename-tool
pnpm test
```

Uses Vitest for unit tests with comprehensive filename pattern coverage.

## Integration

Used by:
- **meta-mesh**: Primary metadata extraction from filenames
- **meta-orbit**: Filename normalization for distributed queries
- **meta-ui**: Display and search filename metadata

## Examples

### Anime Filenames
```typescript
const result = FilenameParser.parse('[HorribleSubs] Attack on Titan - 25 [1080p].mkv');
// { title: 'Attack on Titan', episode: 25, quality: '1080p', releaseGroup: 'HorribleSubs' }
```

### Movie Filenames
```typescript
const result = FilenameParser.parse('The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv');
// { title: 'The Matrix', year: 1999, quality: '1080p', source: 'BluRay', codec: 'x264' }
```

### Multi-Episode
```typescript
const result = FilenameParser.parse('Show.Name.S01E01-E03.1080p.mkv');
// { title: 'Show Name', season: 1, episodes: [1, 2, 3], quality: '1080p' }
```

## Contributing

This package is part of the Meta Orbit monorepo. See the root README for contribution guidelines.

## License

MIT - Same as Meta Orbit monorepo
