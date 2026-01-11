import {CID_ALGORITHM_NAMES} from "@metazla/meta-hash";
import {VideoMeta, HashMeta, VersionMeta, FileNameMeta, FileStatMeta} from "@metazla/meta-interface";
import {renamingRule} from "../config/RenamingRule.js";

type Local = VideoMeta & HashMeta & VersionMeta & FileNameMeta & FileStatMeta;

export interface DuplicateGroup {
    key: string;
    files: string[];
    virtualPath?: string;
}

export interface DuplicateResult {
    hashDuplicates: DuplicateGroup[];
    titleDuplicates: DuplicateGroup[];
}

export class DuplicateFinder {
    async findDuplicates(database: Map<string, Local>): Promise<DuplicateResult> {
        let [hashDuplicates, titleDuplicates] = await Promise.all([
            this.findDuplicatesGeneric(database, this.hashKeyExtractor, 'remove'),
            this.findDuplicatesGeneric(database, this.pathExtractor, 'version')
        ]);

        return {
            hashDuplicates,
            titleDuplicates
        };
    }

    private hashKeyExtractor(metadata: Local): string | null {
        return metadata[CID_ALGORITHM_NAMES.sha256] ?? null;
    }

    private pathExtractor(metadata: Local): string | null {
        //case insensitive
        try {
            return renamingRule(metadata, '')?.toLowerCase() ?? null;
        } catch (e) {
            return null;
        }
    }

    private async findDuplicatesGeneric(
        database: Map<string, Local>,
        keyExtractor: (metadata: Local) => string | null,
        action?: 'remove' | 'version'
    ): Promise<DuplicateGroup[]> {
        const duplicates = new Map<string, string[]>();
        const duplicateGroups: DuplicateGroup[] = [];

        for (const [filePath, metadata] of database) {
            const key = keyExtractor(metadata);
            if (key) {
                const files = duplicates.get(key) ?? [];
                files.push(filePath);
                duplicates.set(key, files);
            }
        }

        for (const [key, files] of duplicates) {
            if (files.length > 1) {
                // Store duplicate group before modifying database
                const sortedFiles = [...files].sort();

                // Generate virtualPath for both hash and title duplicates
                let virtualPath: string | undefined;
                if (action === 'version') {
                    // For title duplicates, use the key (normalized title path)
                    virtualPath = key;
                } else if (action === 'remove') {
                    // For hash duplicates, use renamingRule on the first file's metadata
                    const firstFile = sortedFiles[0];
                    const metadata = database.get(firstFile);
                    if (metadata) {
                        try {
                            virtualPath = renamingRule(metadata, '');
                        } catch (e) {
                            // If renamingRule fails, virtualPath remains undefined
                        }
                    }
                }

                duplicateGroups.push({
                    key,
                    files: sortedFiles,
                    virtualPath
                });

                //alphabetical order
                const remainingFiles = files.slice(1).sort();
                //rename all problematic entries V2, V3, V4, V5
                let i = 2;
                for (const file of remainingFiles) {
                    if (action === 'remove') {
                        database.delete(file);
                    } else if (action === 'version') {
                        let definition = database.get(file);
                        definition.version = "V" + i;
                        if (definition.fileType !== "subtitle") {//allow multiple version of subtitle in the same folder
                            definition.extra = "true";//mark as extra so it don't pollute the main list
                        }
                        i++;
                    } else {
                        throw new Error();
                    }
                }
            }
        }

        return duplicateGroups;
    }
}
