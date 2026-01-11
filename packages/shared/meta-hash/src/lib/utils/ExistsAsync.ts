// Example of checking if a file exists asynchronously
// Note: `existsSync` does not have a direct async equivalent, so we use `access` instead.
import {access,constants} from "fs/promises";

export async function existsAsync(filePath: string): Promise<boolean> {
    try {
        await access(filePath, constants.F_OK);
        return true; // File exists
    } catch {
        return false; // File does not exist
    }
}