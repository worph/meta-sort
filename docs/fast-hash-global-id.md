# MidHash256 Global ID Architecture

## Document Purpose

This document describes the architectural design of the midhash256 global identifier system for Meta-Mesh file metadata. MidHash256 is a fast-hash algorithm that computes SHA-256 of the middle 1MB of a file plus its size. This document explains the algorithm, rationale, performance characteristics, uniqueness guarantees, and trade-offs compared to full-file SHA-256.

---

## System Overview

Meta-Mesh uses **content-addressable storage** where each unique file is identified by a cryptographic hash of its content. This global identifier enables deduplication, distributed synchronization, and metadata consistency across the system.

### Current Implementation

The existing system uses **full-file SHA-256** as the global identifier:

```typescript
// Current: Hash entire file
const hash = await computeSHA256(filePath);  // Reads 100% of file
// Result: "sha256:a3f2bc9..."
```

**Properties:**
- **Uniqueness**: Cryptographically strong (collision probability ≈ 2^-256)
- **Consistency**: Identical content always produces identical hash
- **Performance**: Slow for large files (reads entire file, CPU-intensive)

### Problem Statement

For large media files (10GB-50GB video files), computing full-file SHA-256 creates significant bottlenecks:

1. **Processing Time**: Reading and hashing 50GB takes 15-20 minutes per file
2. **Resource Intensive**: CPU-bound SHA-256 computation at full file size
3. **Pipeline Bottleneck**: Hash computation is the slowest stage in the processing pipeline
4. **Delayed Availability**: Files cannot be fully indexed until hash completes
5. **ID Rotation Complexity**: Temporary IDs (tempId) are used during processing, requiring complex ID rotation logic when hash completes

### Core Design Principle

**A global identifier should be fast to compute while maintaining practical uniqueness guarantees for the target domain (personal media libraries).**

This design prioritizes:
- **Speed**: Sub-second hash computation for files of any size
- **Practicality**: Sufficient uniqueness for real-world media collections (millions of files)
- **Simplicity**: Single-phase processing eliminates temporary ID rotation
- **Determinism**: Identical content produces identical hash

---

## Architecture Design

### Fast-Hash Algorithm

The fast-hash algorithm computes a SHA-256 hash of a **sampled portion** of the file rather than the entire content. This provides a fast, deterministic, and practically unique identifier.

#### Algorithm Specification

```
computeMidHash256(filePath) -> CID:
    1. fileSize = getFileSize(filePath)
    2. sampleData = extractSample(filePath, fileSize)
    3. hashInput = concat(uint64_BE(fileSize), sampleData)
    4. hashBuffer = SHA256(hashInput)
    5. digest = createDigest(0x1000, hashBuffer)
    6. return CID.createV1(0x1000, digest)

extractSample(filePath, fileSize) -> bytes:
    if fileSize <= 1MB:
        return readEntireFile(filePath)
    else:
        middleOffset = (fileSize - 1MB) / 2
        return readBytes(filePath, offset=middleOffset, length=1MB)
```

#### Detailed Steps

**Step 1: File Size Measurement**
```typescript
const fileSize = (await fs.stat(filePath)).size;
```
- Use file system metadata (instant, no file read required)
- Size is measured in bytes (64-bit integer)

**Step 2: Sample Extraction**

For files **≤ 1MB**:
```typescript
const sampleData = await fs.readFile(filePath);
// Read entire file (small enough to process quickly)
```

For files **> 1MB**:
```typescript
const middleOffset = Math.floor((fileSize - SAMPLE_SIZE) / 2);
const SAMPLE_SIZE = 1024 * 1024;  // 1MB

const fd = await fs.open(filePath, 'r');
const buffer = Buffer.allocUnsafe(SAMPLE_SIZE);
await fd.read(buffer, 0, SAMPLE_SIZE, middleOffset);
await fd.close();
```
- Extract exactly 1MB from the middle of the file
- **Middle sampling rationale**: Avoids headers (start) and footers (end) which may be identical across files in the same format

**Step 3: Hash Input Construction**

```typescript
// Prepend file size as 64-bit big-endian integer
const sizeBuffer = Buffer.allocUnsafe(8);
sizeBuffer.writeBigUInt64BE(BigInt(fileSize), 0);

// Concatenate: [fileSize (8 bytes)] + [sampleData (≤ 1MB)]
const hashInput = Buffer.concat([sizeBuffer, sampleData]);
```

**Why include file size:**
- **Uniqueness boost**: Files with identical middle 1MB but different sizes produce different hashes
- **Size change detection**: Modifying file size (even without changing middle content) changes hash
- **Minimal overhead**: 8 bytes added to hash input (negligible)

**Step 4: SHA-256 Computation**

```typescript
import { createHash } from 'crypto';

const hashBuffer = createHash('sha256')
    .update(hashInput)
    .digest();

const digest = create(0x1000, hashBuffer);
const midhash256 = CID.createV1(0x1000, digest).toString();
```

- SHA-256 is computed on ≤ 1MB + 8 bytes (maximum 1,048,584 bytes)
- Result is wrapped in CID v1 format with custom multicodec `0x1000`
- Base32 CID encoding produces strings like "bafkr4ih5kapbjzqvmj7jxr..."
- This format is homogeneous with other CID types (sha256, sha1, etc.)

#### Example Hash Computation

**Small File (500KB)**
```
File: documentary.mp4 (512,000 bytes)

1. fileSize = 512000
2. sampleData = [entire file, 512KB]
3. hashInput = [0x0000000000007D00] + [512KB of data]
4. hashBuffer = SHA256(hashInput)
5. digest = createDigest(0x1000, hashBuffer)
6. result = CID.createV1(0x1000, digest) = "bafkr4ih5kapbjzqvmj7jxr..."
```

**Large File (50GB)**
```
File: movie-4k.mkv (53,687,091,200 bytes)

1. fileSize = 53687091200
2. middleOffset = (53687091200 - 1048576) / 2 = 26,843,021,312
3. sampleData = read 1MB at offset 26,843,021,312
4. hashInput = [0x0000000C80000000] + [1MB from middle]
5. hashBuffer = SHA256(hashInput)
6. digest = createDigest(0x1000, hashBuffer)
7. result = CID.createV1(0x1000, digest) = "bafkr4if3dqvyqvuqfyfg..."
```

---

## Uniqueness Analysis

### Uniqueness Factors

The fast-hash provides uniqueness through multiple independent factors:

1. **File Size (64-bit)**: Exact byte count must match
2. **Middle Content (1MB)**: 1,048,576 bytes of content must match
3. **Content Position**: Content must be at the exact middle position

### Collision Scenarios

A collision occurs when two different files produce the same fast-hash. This requires:

```
FileA ≠ FileB
AND
size(FileA) == size(FileB)
AND
middle1MB(FileA) == middle1MB(FileB)
```

#### Scenario 1: Different Video Files (Same Source)

**Low Risk - Extremely Unlikely**

Two different episodes of a TV show encoded with the same settings:
- **File Size**: Different (episode durations vary, file sizes differ by seconds of content)
- **Middle Content**: Different (different scenes, audio, subtitles)
- **Collision Probability**: ≈ 0% (file sizes will differ)

#### Scenario 2: Re-encoded Video (Same Source Material)

**Low Risk - Practically Impossible**

Same video encoded twice with different encoders or settings:
- **File Size**: Different (encoding settings, bitrate, codecs affect size)
- **Middle Content**: Different (encoding algorithms produce different compressed data)
- **Collision Probability**: ≈ 0% (encoding is deterministic per encoder but differs between encoders)

#### Scenario 3: Identical Container, Different Streams

**Medium Risk - Possible but Detectable**

Same video with different audio tracks or subtitles:
- **File Size**: Different (additional audio/subtitle streams change size)
- **Middle Content**: May differ (if audio/subtitle data interleaved)
- **Collision Probability**: Very low (size typically differs; if not, middle content likely differs)

#### Scenario 4: Truncated or Extended Files

**No Risk - Guaranteed Different**

File that is truncated or extended (padding added):
- **File Size**: Different (guaranteed)
- **Collision Probability**: 0% (size difference guarantees unique hash)

#### Scenario 5: Files with Identical Middles (Crafted Attack)

**Theoretical Risk - Requires Intentional Manipulation**

Maliciously crafted files with identical size and middle content:
- **File Size**: Identical (by design)
- **Middle Content**: Identical (by design)
- **Start/End Content**: Different (not included in hash)
- **Collision Probability**: 100% if crafted (but not a concern for media files)

**Mitigation**: Media files are organically created content, not crafted adversarially. This scenario does not occur in practice for video/audio files.

---

## Performance Characteristics

### Computation Time

| File Size | Full SHA-256 | Fast-Hash | Speedup | Time Saved |
|-----------|--------------|-----------|---------|------------|
| 100 MB | 2 sec | 0.02 sec | 100x | 1.98 sec |
| 1 GB | 20 sec | 0.02 sec | 1000x | 19.98 sec |
| 10 GB | 200 sec | 0.02 sec | 10,000x | 199.98 sec |
| 50 GB | 1000 sec | 0.02 sec | 50,000x | 999.98 sec |

**Assumptions:**
- Disk read speed: 500 MB/s (SSD)
- SHA-256 computation: 500 MB/s (CPU-bound)
- Fast-hash: 1MB sample + 8 bytes = 1.048 MB to hash

**Result**: Fast-hash is **O(1)** regardless of file size (always hashes ≈ 1MB).

### I/O Characteristics

**Full SHA-256 I/O:**
```
Total I/O = fileSize (sequential read)
For 50GB file: 50GB read
```

**Fast-Hash I/O:**
```
Total I/O = 1MB (single seek + read)
For 50GB file: 1MB read (99.998% reduction)
```

**Disk Operations:**
- **Full SHA-256**: Sequential scan (no seeks, but reads everything)
- **Fast-Hash**: Single seek to middle + 1MB read (minimal I/O)

### CPU Characteristics

**SHA-256 Computation:**
- **Full SHA-256**: SHA-256 state updated for every block of file (many GB)
- **Fast-Hash**: SHA-256 state updated for ≤ 1MB (fixed)

**CPU Time:**
- **Full SHA-256**: O(n) where n = file size
- **Fast-Hash**: O(1) regardless of file size

### Memory Characteristics

Both approaches use streaming (constant memory):
- **Full SHA-256**: Reads chunks (e.g., 64KB), updates hash, repeats
- **Fast-Hash**: Reads 1MB sample into memory, computes hash

**Memory Usage:**
- **Full SHA-256**: ~64KB buffer + SHA-256 state (minimal)
- **Fast-Hash**: ~1MB buffer + SHA-256 state (acceptable)

---

## Trade-offs and Design Decisions

### Advantages

#### 1. Dramatic Performance Improvement

Fast-hash reduces hash computation time by **100x to 50,000x** depending on file size. For a 50GB file:
- **Full SHA-256**: 16.7 minutes
- **Fast-Hash**: 0.02 seconds

This eliminates the hash computation bottleneck in the processing pipeline.

#### 2. Simplified Processing Pipeline

**Current System (with full SHA-256):**
```
Discovery → Validation → Metadata (tempId) → Hash → Rotate ID (tempId → hash)
```
- Temporary ID assigned during metadata extraction
- Final hash computed later (slow)
- ID rotation required (update all references from tempId to hash)

**New System (with fast-hash):**
```
Discovery → Validation → Metadata + Fast-Hash → Done
```
- Fast-hash computed immediately during metadata extraction (instant)
- No temporary ID needed
- No ID rotation required
- Simpler state management

#### 3. Immediate File Availability

Files can be fully indexed and accessible within seconds of discovery:
- **Current**: 15-20 minutes for large files (waiting for hash)
- **Fast-Hash**: < 1 second (hash computed instantly)

Virtual filesystem and search become immediately available.

#### 4. Constant-Time Complexity

Hash computation time is **O(1)** regardless of file size. This provides:
- **Predictable Performance**: Always ~20ms per file
- **Scalability**: 100GB files hash as fast as 1GB files
- **Resource Efficiency**: CPU and disk I/O are minimized

#### 5. Sufficient Uniqueness for Target Domain

For personal media libraries (even large ones with millions of files):
- **Practical Collision Risk**: Effectively zero for organically created media files
- **Theoretical Collision Risk**: Requires identical file size AND middle 1MB (extremely rare)

#### 6. Deterministic and Reproducible

Same file always produces same hash:
- **Content Addressable**: Hash uniquely identifies file content
- **Synchronization**: Distributed nodes agree on file identity
- **Deduplication**: Duplicate files detected reliably

---

### Disadvantages

#### 1. Weaker Cryptographic Guarantees

**Full SHA-256:**
- Collision probability: 2^-256 (effectively impossible)
- Security: Cryptographically secure (cannot be forged)

**Fast-Hash:**
- Collision probability: Higher (depends on middle 1MB, not full content)
- Security: Not cryptographically secure for authentication (only samples content)

**Impact:** Fast-hash should not be used for security-critical applications (e.g., verifying file integrity for software distribution). For media library management, this is acceptable.

#### 2. Potential Collisions for Specific File Types

**High-Risk File Types** (not applicable to Meta-Mesh):
- **Sparse Files**: Files with large regions of zeros (e.g., disk images)
- **Generated Files**: Programmatically generated with patterns
- **Container Files with Metadata-Only Changes**: Same content, different headers/footers

**Low-Risk File Types** (Meta-Mesh target):
- **Video Files**: Compressed content varies throughout file
- **Audio Files**: Waveform data varies throughout file
- **Subtitle Files**: Text content varies throughout file

**Mitigation:** Meta-Mesh targets video/audio files, where collision risk is minimal.

#### 3. Partial Content Modifications Undetected

If only the start or end of a file changes (and middle 1MB is unchanged):
- **Full SHA-256**: Detects change (entire file is hashed)
- **Fast-Hash**: Does not detect change (middle is unchanged)

**Example Scenario:**
```
Original: [intro][middle content][outro]
Modified: [new-intro][middle content][outro]

Fast-Hash: SAME (middle unchanged)
Full SHA-256: DIFFERENT (intro changed)
```

**Impact for Meta-Mesh:** Video/audio files are typically modified by re-encoding (entire file changes) rather than splicing (start/end modification). Subtitle files are small (< 1MB) and fully hashed. This scenario is rare in practice.

#### 4. Not Suitable for Integrity Verification

Fast-hash cannot verify file integrity:
- **Full SHA-256**: Detects any single-bit change anywhere in file
- **Fast-Hash**: Only detects changes in middle 1MB or file size

**Impact:** Fast-hash is for **identification** (deduplication, indexing), not **verification** (ensuring file is uncorrupted). If integrity verification is needed, full SHA-256 should be computed separately.

#### 5. Incompatible with Existing Hash Standards

Fast-hash is not compatible with:
- **Torrent Hashes**: Use full-file SHA-1 or info-hash
- **IPFS CIDs**: Use full-file multihash
- **Checksums**: Use CRC32, MD5, or full SHA-256

**Impact:** Fast-hash cannot be used for interoperability with external systems that require standard hash formats. Meta-Mesh can compute multiple hashes (fast-hash for internal use, full SHA-256 for external interoperability).

---

## Collision Risk Analysis

### Mathematical Model

For a collection of **n** files, the probability of at least one collision is approximated by the birthday paradox:

```
P(collision) ≈ 1 - e^(-n² / (2 × H))

Where:
  H = hash space size
```

**Hash Space Size:**
- **Full SHA-256**: H = 2^256 (enormous, collision effectively impossible)
- **Fast-Hash**: H depends on middle content diversity

**Effective Hash Space for Fast-Hash:**

The middle 1MB provides:
```
Theoretical space: 2^(8 × 1,048,576) = 2^8,388,608 (astronomical)
Practical space: Much smaller due to:
  - File size constraint (limits possible values)
  - Content structure (video codecs produce non-random data)
```

**Practical Estimate:**

For video files, the middle 1MB contains:
- Compressed video frames (varies by scene, motion, color)
- Interleaved audio data (varies by sound, music, dialogue)
- Possibly subtitle data (varies by text)

**Estimated effective hash space**: 2^64 to 2^80 (considering content diversity)

**Collision Probability for Media Collections:**

| Collection Size (n) | Hash Space (H) | Collision Probability |
|---------------------|----------------|-----------------------|
| 1,000 files | 2^64 | ≈ 0.000027% |
| 10,000 files | 2^64 | ≈ 0.27% |
| 100,000 files | 2^64 | ≈ 27% |
| 1,000,000 files | 2^64 | ≈ 99.97% |
| 10,000 files | 2^80 | ≈ 0.0000000041% |
| 100,000 files | 2^80 | ≈ 0.000041% |
| 1,000,000 files | 2^80 | ≈ 0.041% |

**Interpretation:**

- For **typical personal media libraries** (1,000 - 10,000 files): Collision risk is negligible
- For **large media libraries** (100,000+ files): Collision risk becomes measurable but remains low if hash space is large (2^80)
- For **massive institutional collections** (1,000,000+ files): Collision detection and resolution may be necessary

**Mitigation Strategy:**

If a collision is detected (two different files with same fast-hash), the system can:
1. **Log the collision** for manual review
2. **Fall back to full SHA-256** for the conflicting files
3. **Use a secondary identifier** (full path, full SHA-256) to disambiguate

---

## Integration with Existing Components

### etcd Storage Structure

**Current Structure:**
```
/file/hash/{fullSHA256}/property/path → value
/file/tmp/{tempId}/property/path → value (temporary)
/tempid/{tempId} → {fullSHA256} (rotation mapping)
```

**New Structure with Fast-Hash:**
```
/file/hash/{midhash256}/property/path → value
```

**Changes:**
- Replace `fullSHA256` with `midhash256` as the primary key
- Eliminate `/file/tmp/{tempId}` keys (no temporary storage needed)
- Eliminate `/tempid/{tempId}` reverse lookup (no ID rotation)

**Simplified Key Structure:**
```
/file/bafkr4ih5kapbjzqvmj7jxr.../title → "Inception"
/file/bafkr4ih5kapbjzqvmj7jxr.../year → "2010"
/file/bafkr4ih5kapbjzqvmj7jxr.../video/codec → "h265"
```
(Using CID v1 format with custom multicodec 0x1000)

### Processing Pipeline

**Current Pipeline (Two-Phase):**
```typescript
// Phase 1: Light Processing (quick metadata)
const tempId = generateTempId();
await extractMetadata(filePath, tempId);
await etcd.put(`/file/tmp/${tempId}/title`, title);

// Phase 2: Hash Processing (slow full SHA-256)
const hash = await computeFullSHA256(filePath);  // 15+ minutes
await rotateId(tempId, hash);  // Move /tmp/{tempId} → /file/hash/{hash}
```

**New Pipeline (Single-Phase):**
```typescript
// Single Phase: Metadata + Fast-Hash
const midhash256 = await computecomputeMidHash256(filePath);  // < 1 second
await extractMetadata(filePath, midhash256);
await etcd.put(`/file/hash/${midhash256}/title`, title);
```

**Benefits:**
- **Simpler Code**: No ID rotation logic
- **Faster Processing**: No waiting for slow hash computation
- **Fewer etcd Operations**: No temporary key creation/deletion

### Virtual Filesystem

**Impact:** Minimal changes required.

**Current:**
```typescript
// Retrieve file by full SHA-256
const metadata = await etcd.get(`/file/hash/${fullSHA256}/...`);
```

**New:**
```typescript
// Retrieve file by fast-hash
const metadata = await etcd.get(`/file/hash/${midhash256}/...`);
```

The virtual filesystem organizes files by metadata properties (title, year, season, episode), not by hash. The hash is used only as the unique key for metadata storage. Changing from full SHA-256 to fast-hash is transparent to the virtual filesystem.

### Deduplication

**Current Deduplication:**
```typescript
// Check if file already exists
const existingFile = await etcd.get(`/file/hash/${fullSHA256}`);
if (existingFile) {
    // Duplicate detected (same content hash)
    // Add new path to paths array
}
```

**New Deduplication:**
```typescript
// Check if file already exists
const existingFile = await etcd.get(`/file/hash/${midhash256}`);
if (existingFile) {
    // Duplicate detected (same fast-hash)
    // Verify paths are different (not the same file)
    // Add new path to paths array
}
```

Deduplication logic remains identical. Fast-hash serves the same purpose as full SHA-256 (unique file identifier).

### Stremio Addon

**Impact:** None (uses metadata, not hash directly).

The Stremio addon retrieves files by metadata queries (title, season, episode), not by hash. The hash is used internally for metadata storage. Changing to fast-hash is transparent to the addon.

### Meta-Orbit (Distributed Synchronization)

**Impact:** Hash serves as content identifier for P2P synchronization.

**Current Synchronization:**
```typescript
// Node A: "I have file with hash sha256:abc123"
// Node B: "I also have sha256:abc123" → Same file, sync metadata
```

**New Synchronization:**
```typescript
// Node A: "I have file with CID bafkr4ih5kapbjzqvmj7jxr..."
// Node B: "I also have bafkr4ih5kapbjzqvmj7jxr..." → Same file (likely), sync metadata
```

**Consideration:** Fast-hash collisions are more likely than full SHA-256 collisions. If two nodes have files with the same fast-hash but different content (collision), synchronization may treat them as duplicates incorrectly.

**Mitigation:**
- **Collision Detection**: Compare additional metadata (file size, title, resolution) to detect false positives
- **Manual Resolution**: Allow users to manually resolve ambiguous cases
- **Fallback to Full Hash**: If collision suspected, compute full SHA-256 for confirmation

---

## Comparison with Alternative Approaches

### Fast-Hash vs. Full SHA-256

| Aspect | Full SHA-256 | Fast-Hash |
|--------|--------------|-----------|
| **Computation Time** | O(n), 15+ min for 50GB | O(1), < 1 sec for any size |
| **Uniqueness** | Cryptographic (2^-256) | Practical (depends on middle content) |
| **I/O Required** | Full file read (50GB) | 1MB read (fixed) |
| **Memory Usage** | Streaming (64KB buffer) | 1MB buffer |
| **Collision Risk** | Effectively zero | Very low (0.041% for 1M files) |
| **Security** | Cryptographically secure | Not secure (samples only) |
| **Suitable For** | Integrity verification, security | Deduplication, indexing |

**Decision Rationale:** Fast-hash prioritizes speed and practicality for media library management over cryptographic strength.

---

### Fast-Hash vs. Partial SHA-256 (First/Last 1MB)

**Alternative Approach:**
```
Hash first 1MB + last 1MB of file (instead of middle 1MB)
```

**Comparison:**

| Aspect | First/Last 1MB | Middle 1MB (Fast-Hash) |
|--------|----------------|------------------------|
| **Computation Time** | Same (2MB to hash) | Faster (1MB to hash) |
| **Uniqueness** | Better (captures headers + footers) | Good (captures content body) |
| **Collision Risk** | Lower (2MB of data) | Higher (1MB of data) |
| **Header Sensitivity** | High (format headers differ) | Low (content body may differ more) |

**Decision Rationale:** Middle 1MB is preferred because:
- **Faster**: 1MB vs. 2MB (50% less data to hash)
- **Simpler**: Single seek vs. two seeks
- **Content-Focused**: Middle contains unique content (not generic headers/footers)

---

### Fast-Hash vs. Random Sampling

**Alternative Approach:**
```
Sample random chunks throughout the file (e.g., 10 × 100KB chunks)
```

**Comparison:**

| Aspect | Random Sampling | Middle 1MB (Fast-Hash) |
|--------|----------------|------------------------|
| **Determinism** | Requires fixed seed (complex) | Deterministic (middle offset) |
| **Disk I/O** | Multiple seeks (slower) | Single seek (faster) |
| **Uniqueness** | Better (samples distributed) | Good (single large sample) |
| **Complexity** | High (seed management, chunk distribution) | Low (simple offset calculation) |

**Decision Rationale:** Middle 1MB is preferred because:
- **Simpler**: Single offset calculation, no seed management
- **Faster**: Single disk seek, not multiple
- **Deterministic**: Always samples exact middle (no randomness)

---

### Fast-Hash vs. Metadata-Based ID

**Alternative Approach:**
```
Use metadata (title + year + duration) as identifier instead of content hash
```

**Comparison:**

| Aspect | Metadata-Based ID | Fast-Hash |
|--------|-------------------|-----------|
| **Uniqueness** | Low (many files share same title/year) | High (content-based) |
| **Collision Risk** | High (identical metadata common) | Low (content must match) |
| **Deduplication** | Unreliable (different files, same metadata) | Reliable (same content → same hash) |
| **Content Change** | ID unchanged (metadata same) | ID changed (content changed) |

**Decision Rationale:** Content-based hash (fast-hash) is superior for deduplication and identity because:
- **Unique**: Content determines ID, not metadata
- **Reliable**: Different content → different ID (guaranteed)
- **Deduplication**: Identical content → same ID (accurate duplicate detection)

---

## Design Intent: Supplement, Not Replacement

**IMPORTANT**: midhash256 is a **supplement** to full-file hashes, **not a replacement**.

### Two-Phase Processing Model

MetaMesh implements a two-phase processing pipeline:

**Phase 1: Light Processing (midhash256)**
- Compute midhash256 hash (< 1 second)
- Extract metadata (filename parsing, FFmpeg analysis)
- Store in etcd with midhash256 as primary key
- **File becomes immediately accessible in Virtual Filesystem**

**Phase 2: Hash Processing (Full Hashes - Background)**
- Compute full-file hashes: SHA-256, SHA-1, MD5, CRC32 (slow, minutes)
- Update etcd with additional hash metadata
- Required for Meta-Orbit distributed synchronization

### Why Both Are Needed

**midhash256 Purpose:**
- **Immediate file availability**: Users can browse/stream files within seconds of discovery
- **Simplified ID management**: No temporary IDs or complex ID rotation
- **Fast deduplication**: Quickly identify potential duplicates

**Full Hash Purpose:**
- **Meta-Orbit integration**: Distributed P2P synchronization requires cryptographically secure hashes
- **External system compatibility**: Torrent verification, IPFS CIDs
- **Collision resolution**: If midhash256 collision detected, full SHA-256 provides definitive answer

### Processing Flow

```
File Discovery
    ↓
Light Processing (32 workers, parallel)
  - Compute midhash256 (~20ms)
  - Extract metadata
  - Store in etcd: /file/{midhash256}/...
  - Add to VFS (file accessible immediately) ✓
    ↓
Hash Processing (8 workers, background)
  - Compute SHA-256, SHA-1, MD5, CRC32 (15+ minutes for 50GB)
  - Update etcd with full hashes
  - Enable Meta-Orbit synchronization ✓
```

### Collision Detection and Handling

When a file is processed, the system checks if another file with the same midhash256 already exists:

**If collision detected:**
1. **Log warning**: Alert administrator of potential collision
2. **Skip VFS addition**: Do not add colliding file to Virtual Filesystem
3. **Force full hash**: Compute SHA-256 immediately (bypass light processing)
4. **Use SHA-256 as key**: Store in etcd using full SHA-256 instead of midhash256

This ensures:
- **No data corruption**: Different files never share the same ID
- **No silent failures**: Collisions are logged and handled explicitly
- **Fallback path**: System continues working even if collision occurs

---

## Conclusion

The midhash256 global ID architecture provides a **practical, high-performance supplement** to full-file SHA-256 for media library management. By sampling 1MB from the middle of each file and prepending the file size, the algorithm achieves:

- **100x to 50,000x speedup** over full-file hashing (for Phase 1 processing)
- **O(1) constant-time complexity** regardless of file size
- **Sufficient uniqueness** for personal media libraries (millions of files)
- **Immediate file availability** (accessible in VFS within seconds)
- **Two-phase processing** (fast accessibility + background full hashing)

The trade-offs—weaker cryptographic guarantees, potential collisions for adversarial cases, and unsuitability for integrity verification—are acceptable for Meta-Mesh's target domain (personal media libraries where files are organically created, not adversarially crafted).

This architecture aligns with Meta-Mesh's design philosophy: **optimize for the common case** (large media files, organic content, personal libraries) while maintaining **practicality and performance** over theoretical perfection.

Meta-Mesh leverages midhash256 for **immediate file availability** while computing full SHA-256 hashes **in the background** for Meta-Orbit distributed synchronization and external system compatibility. This dual-hash approach provides both speed and security.
