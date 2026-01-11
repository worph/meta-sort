import * as path from 'path';
import {
    HashMeta,
} from "@metazla/meta-interface";

type Local =  HashMeta;

export class MetaDataToFolderStruct {

    public renamingRule: (metamesh: Local, filepath: string) => string | null;

    constructor(renamingRule: (metamesh: Local, filepath: string) => string | null) {
        this.renamingRule = renamingRule;
    }

    /**
     * Compute virtual filesystem structure for FUSE/WebDAV
     * Generates organized paths based on metadata without creating physical files
     * @param data Map of file paths to metadata
     * @private
     */
    private computeVirtualStructure(data: Map<string, Local>): Map<string, string> {
        const virtualMap = new Map<string, string>();

        for (const [filepath, metamesh] of data) {
            // Compute the virtual path for the file
            let virtualPath: string;
            try {
                virtualPath = this.renamingRule(metamesh, filepath);
            }catch (e){
                console.warn(e.message || e);
            }
            if (!virtualPath) {
                continue;
            }
            virtualPath = this.sanitizePath(virtualPath);
            virtualMap.set(filepath, virtualPath);
        }

        console.log(`Computed virtual structure for ${virtualMap.size} files`);
        return virtualMap;
    }

    sanitizePath(newPath: string): string {
        // First, isolate any potential Windows drive letter at the start of the path
        const driveMatch = newPath.match(/^[a-zA-Z]:/);
        const drive = driveMatch ? driveMatch[0] : '';

        // Define illegal characters for Windows and potentially problematic ones for Unix
        const illegalChars = /[<>:"|?*]/g;  // Null character added for Unix-like systems

        // Replace illegal characters with an underscore in the path, excluding the drive part
        const pathWithoutDrive = newPath.slice(drive.length);
        const sanitizedPath = pathWithoutDrive.replace(illegalChars, '');

        // Combine the drive (if any) and the sanitized path
        const cleanPath = drive + sanitizedPath;

        // Normalize the clean path to handle slashes appropriately
        return path.normalize(cleanPath);
    }

    /**
     * Generate virtual filesystem structure for FUSE/WebDAV
     * Returns only the computed virtual paths without checking physical filesystem
     * @param data Map of file paths to metadata
     */
    public generateVirtualStructure(data: Map<string, Local>): Map<string, string> {
        const start = performance.now();
        const computed = this.computeVirtualStructure(data);
        console.log(`Compute virtual structure took ${performance.now() - start}ms`);
        return computed;
    }

}