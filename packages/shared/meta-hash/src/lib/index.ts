//fileID
export * from './file-id/FileIDComputerWorker.js';
export * from './file-id/ShaComputeWorker.js';//worker
export * from './file-id/FastHash.js'; // Fast-hash computation
export * from './file-id/BtihV2Hasher.js'; // BitTorrent v2 info hash
export * from './file-id/MagnetLinkGenerator.js'; // Magnet link generation
export * from './file-id/CidDecode.js'; // Bare-CID → algorithm decoding (THE shared TS CID decoder)

// The CID model: algorithm codes, the algorithm selector, and MultiHashData
// (bare `cids: string[]`). Exported because every consumer of a `cids/<cid>`
// key-set needs them to recover a specific digest — see CidDecode.
export * from './hash-compute/MultiHashData.js';

//hash-compute
export * from './hash-compute/HashComputerIndexCache.js';
export * from './hash-compute/HashComputerWorker.js';
export * from './hash-compute/HashIndexManager.js';
export * from './hash-compute/HashComputer.js';
export * from './hash-compute/HashComputerFile.js';

//folder-watcher
export * from './folder-watcher/FolderWatcher.js';
export * from './folder-watcher/PollingWatcher.js';
export * from './index-interface.js';

export * from './utils/ExistsAsync.js';