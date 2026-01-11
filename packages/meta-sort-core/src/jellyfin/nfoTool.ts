import { parse, sep } from "path";

/**
 * Get the nfo file path for a given file path (replace the extension with .nfo)
 * @param filePath
 * @param ext - The extension to replace with, default is "nfo"
 * @returns The nfo file path
 */
export function filePathReplace(filePath: string, ext: string = "nfo"): string {
    const { dir, name } = parse(filePath);
    return `${dir}${sep}${name}.${ext}`;
}

/**
 * Get the nfo file path for a given folder path (add .nfo to the folder path)
 * @param folderPath
 * @param ext
 * @returns The nfo file path
 */
export function filePathAdd(folderPath: string, ext: string = "nfo"): string {
    return `${folderPath}.${ext}`;
}
