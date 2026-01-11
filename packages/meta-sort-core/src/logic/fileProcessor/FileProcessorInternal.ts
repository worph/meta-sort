import { HashComputerFile } from "@metazla/meta-hash";
import { targetHash } from "../../config/TargetHash.js";
import { DebugMeta, HashMeta } from "@metazla/meta-interface";
import { MetaMeshFormat } from "../MetaMeshFormat.js";

type Local = HashMeta & DebugMeta;

export class FileProcessorInternal {
    hashComputer = new HashComputerFile(targetHash);
    metaMeshFormat = new MetaMeshFormat();

    async processFile(filePath: string, hash: HashMeta): Promise<{
        time: number,
        metadata: HashMeta,
        hashTimings?: Record<string, number>,
        pluginTimings?: Record<string, number>
    }> {
        const start = performance.now();
        const hashTimings: Record<string, number> = {};
        const pluginTimings: Record<string, number> = {};

        // --------------------------------------------
        // Hash logic compute and get the hash - use cache etc...
        // --------------------------------------------
        const metaDataPath = `${filePath}.meta`;
        let metadata: HashMeta = await this.metaMeshFormat.read(metaDataPath) || {}; // Read the reference file
        // try to update the sha values from the index
        if (hash) {
            for (let key in hash) {
                if (!metadata[key] && hash[key]) {
                    metadata[key] = hash[key];
                }
            }
        }

        // Time consuming - compute hashes and track timing
        try {
            // Determine which hashes need to be computed
            const neededHashes = this.hashComputer['targetHash'].filter(hashName => !metadata[hashName]);

            if (neededHashes.length > 0) {
                // Measure total time for hash computation
                const hashStart = performance.now();

                // Compute all needed hashes at once (more efficient than individual)
                await this.hashComputer.computeMissingHash(filePath, metadata);

                const totalHashTime = Math.ceil(performance.now() - hashStart);

                // Distribute the time evenly among computed hashes
                // This is an approximation - actual individual hash times may vary
                const avgTimePerHash = totalHashTime / neededHashes.length;
                for (const hashAlgorithm of neededHashes) {
                    hashTimings[hashAlgorithm] = Math.ceil(avgTimePerHash);
                }
            }
        } catch (hashError) {
            console.error(`[Worker] Hash computation failed for ${filePath}:`, hashError);
            throw new Error(`Hash computation failed: ${hashError instanceof Error ? hashError.message : String(hashError)}`);
        }

        // Plugin processing is now handled by container plugins via TaskScheduler
        // This internal processor only handles hash computation

        // Validate all required hashes are present before returning
        const missingHashesAfterCompute: string[] = [];
        for (const hashKey of this.hashComputer['targetHash']) {
            if (!metadata[hashKey]) {
                missingHashesAfterCompute.push(hashKey);
            }
        }

        if (missingHashesAfterCompute.length > 0) {
            throw new Error(`[Worker] Hash validation failed - missing hashes: ${missingHashesAfterCompute.join(', ')}`);
        }

        return {
            time: Math.ceil(performance.now() - start),
            metadata,
            hashTimings,
            pluginTimings
        };
    }
}
