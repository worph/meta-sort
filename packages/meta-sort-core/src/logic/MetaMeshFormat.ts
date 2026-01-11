import { promises as fs } from 'fs';
import yaml from 'yaml';
const { parse, stringify } = yaml;
/**
 * File type:
 * filename.<ext>.meta
 * filename.meta (contains multiple metadata entry "mkv", "str" etc...)
 * folder.meta
 */

export class MetaMeshFormat {
    async createOrUpdate<T>(metaDataFilePath: string, data: T): Promise<void> {
        if(!metaDataFilePath.endsWith('.meta')){
            throw new Error(`File path must end with '.meta'`);
        }
        try {
            // Check if the file exists
            const fileExists = await fs.access(metaDataFilePath).then(() => true).catch(() => false);

            if (fileExists) {
                // If the file exists, update it
                await this.update(metaDataFilePath, data);
            } else {
                // If the file does not exist, create it
                await fs.writeFile(metaDataFilePath, stringify(data), 'utf8');
            }
        } catch (error) {
            console.error(`Error in createOrUpdate: ${error}`);
            throw error;
        }
    }

    async read<T>(metaDataFilePath: string): Promise<T> {
        if(!metaDataFilePath.endsWith('.meta')){
            throw new Error(`File path must end with '.meta'`);
        }
        try {
            const fileExists = await fs.access(metaDataFilePath).then(() => true).catch(() => false);

            if (!fileExists) {
                return null;
            }
            // Read the YAML file
            const fileContent = await fs.readFile(metaDataFilePath, 'utf8');

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

            // Write the updated data back to the file
            await fs.writeFile(metaDataFilePath, stringify(updatedData), 'utf8');
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
            // Write the updated data back to the file
            await fs.writeFile(metaDataFilePath, stringify(data), {
                encoding:'utf8',
                flag:'w' // Write mode : Overwrite
            });
        } catch (error) {
            console.error(`Error in update: ${error}`);
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
