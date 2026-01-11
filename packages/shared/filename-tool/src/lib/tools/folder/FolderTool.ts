
import {dirname, parse} from 'path';
import {promises as fs} from 'fs';

/**
 * Return the sibling file associated to the nfo file.
 * Warning: the sibling file must be in the same folder. This function will look in the file system.
 * It will find any file with the same base name regardless of its extension, excluding the original .nfo file.
 * @param filePath The path to the .nfo file.
 * @returns The path to the sibling file if it exists, otherwise an empty string.
 */
export async function getSiblingFiles(filePath: string): Promise<string[]> {
    const fileDir = dirname(filePath);
    const fileNameWithoutExt = parse(filePath).name;

    try {
        const files = await fs.readdir(fileDir);
        return files.filter(file => {
            const {name, ext} = parse(file);
            return name === fileNameWithoutExt;
        });
    } catch (error) {
        console.error(`Error searching for sibling file of ${filePath}:`, error);
        return [];
    }
}