export class FileNameStringOperation {
    cleanSpace(dataString: string): string {
        // Remove double spaces
        dataString = dataString.replace(/\s+/g, " ");
        // Remove leading spaces
        dataString = dataString.replace(/^\s/, "");
        // Remove trailing spaces if any
        if (dataString.endsWith(" ")) {
            dataString = dataString.slice(0, -1);
        }
        return dataString;
    }

    removeExt(filename: string): string {
        const lastDotPosition = filename.lastIndexOf(".");
        if (lastDotPosition === -1) return ""; // No extension found
        return filename.substring(0, lastDotPosition);
    }

    getExt(filename: string): string {
        const lastDotPosition = filename.lastIndexOf(".");
        if (lastDotPosition === -1) return ""; // No extension found
        return filename.substring(lastDotPosition + 1).toLowerCase();
    }
}
