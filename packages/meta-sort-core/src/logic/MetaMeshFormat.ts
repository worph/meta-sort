import yaml from 'yaml';
import * as webdav from '../webdav/WebdavClient.js';
const { parse, stringify } = yaml;
/**
 * File type:
 * filename.<ext>.meta
 * filename.meta (contains multiple metadata entry "mkv", "str" etc...)
 * folder.meta
 *
 * All file operations use WebDAV for access to meta-core's file system.
 */

export class MetaMeshFormat {
    async createOrUpdate<T>(metaDataFilePath: string, data: T): Promise<void> {
        if(!metaDataFilePath.endsWith('.meta')){
            throw new Error(`File path must end with '.meta'`);
        }
        try {
            // Check if the file exists via WebDAV
            const fileExists = await webdav.exists(metaDataFilePath);

            if (fileExists) {
                // If the file exists, update it
                await this.update(metaDataFilePath, data);
            } else {
                // If the file does not exist, create it via WebDAV
                await webdav.writeFile(metaDataFilePath, stringify(data));
            }
        } catch (error) {
            console.error(`Error in createOrUpdate: ${error}`);
            throw error;
        }
    }

    async read<T>(metaDataFilePath: string): Promise<T | null> {
        if(!metaDataFilePath.endsWith('.meta')){
            throw new Error(`File path must end with '.meta'`);
        }
        try {
            // Read the YAML file via WebDAV
            const fileContent = await webdav.readTextFile(metaDataFilePath);

            if (!fileContent) {
                return null;
            }

            // Parse the YAML content to a JavaScript object
            return parse(fileContent) as T;
        } catch (error) {
            console.error(`Error in read: ${error}`);
            throw error;
        }
    }

    async update<T>(metaDataFilePath: string, data: T): Promise<void> {
        if(!metaDataFilePath.endsWith('.meta')){
            throw new Error(`File path must end with '.meta'`);
        }
        try {
            // Read the existing file content
            const existingData = await this.read<any>(metaDataFilePath) || {};

            // Merge the existing data with the new data
            const updatedData = { ...existingData, ...data };

            // Write the updated data back to the file via WebDAV
            await webdav.writeFile(metaDataFilePath, stringify(updatedData));
        } catch (error) {
            console.error(`Error in update: ${error}`);
            throw error;
        }
    }

    async write<T>(metaDataFilePath: string, data: T): Promise<void> {
        if(!metaDataFilePath.endsWith('.meta')){
            throw new Error(`File path must end with '.meta'`);
        }
        try {
            // Write the data to the file via WebDAV (overwrite)
            await webdav.writeFile(metaDataFilePath, stringify(data));
        } catch (error) {
            console.error(`Error in write: ${error}`);
            throw error;
        }
    }

    /**
     * Serialize data to YAML string (for virtual .meta files)
     */
    serialize<T>(data: T): string {
        return stringify(data);
    }
}
