import {fileTypeFromFile} from 'file-type';
import {SimpleFileType} from "../SimpleFileType.js";

export class FileTypeConfigurable {

    constructor(private extensionMappings: Record<string, SimpleFileType>,private mimeTypeMappings:Record<string,SimpleFileType>) {
    }

    public async getMimeTypeFromFile(filepath: string, retries: number = 3): Promise<string | undefined> {
        let lastError: any;

        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const result = await fileTypeFromFile(filepath);
                return result?.mime;
            } catch (error: any) {
                lastError = error;

                // Only retry on EINVAL errors (common with SMB/CIFS mounts)
                if (error.code === 'EINVAL' && attempt < retries - 1) {
                    // Exponential backoff: 50ms, 100ms, 200ms
                    const delay = 50 * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }

                // Don't retry on other errors
                if (error.code !== 'EINVAL') {
                    break;
                }
            }
        }

        // Only log warning if all retries failed
        if (lastError) {
            // For EINVAL errors on network mounts, use less verbose logging
            if (lastError.code === 'EINVAL' && filepath.includes('/smb-')) {
                console.warn(`MIME type detection failed for network file (EINVAL - likely concurrent access or stale handle): ${filepath}`);
            } else {
                console.warn(`Error reading MIME type from file ${filepath}:`, lastError);
            }
        }

        return undefined;
    }

    /**
     * Get the file type based on the file extension
     * @param filepath
     */
    public getFileTypeFromExtension(filepath: string): SimpleFileType {
        const extension = filepath.split('.').pop()?.toLowerCase();
        let extensionBasedType:SimpleFileType = 'undefined';//some files don't have extension (eg. README)
        if (extension) {
            extensionBasedType = this.extensionMappings[extension] || 'other';
        }
        return extensionBasedType;
    }

    public async getFileType(filepath: string): Promise<SimpleFileType> {
        const mimeType = await this.getMimeTypeFromFile(filepath);
        let extensionBasedType:SimpleFileType = this.getFileTypeFromExtension(filepath);

        if (mimeType) {
            const mimeBasedType = this.mimeTypeMappings[mimeType];
            if (mimeBasedType && mimeBasedType !== 'undefined') {
                if (extensionBasedType !== mimeBasedType) {
                    console.warn(`Warning: Possible mismatch between extension and MIME type for file ${filepath}. Extension suggests ${extensionBasedType}, but MIME type suggests ${mimeBasedType}.`);
                    return 'undefined';
                }
                return mimeBasedType;
            }
        }

        return extensionBasedType;
    }
}
