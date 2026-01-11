export class FileNameCleaner {
    /**
     * Extract the filename from the file path (remove extension and folder path)
     * @param filePath
     */
    public getFilenameFromPath(filePath: string): string {
        // Find the last occurrence of both '/' and '\'
        let lastSlash = filePath.lastIndexOf('/');
        let lastBackSlash = filePath.lastIndexOf('\\');

        // Use the greater index to support both Windows and Unix paths
        let fileNameIndex = Math.max(lastSlash, lastBackSlash) + 1;
        let fileName = filePath.substring(fileNameIndex);

        // Remove the file extension from the file name
        let extensionIndex = fileName.lastIndexOf('.');
        if (extensionIndex != -1) {
            fileName = fileName.substring(0, extensionIndex);
        }

        return fileName;
    }

    public cleanSpace(filename: string): string {
        // Remove double (multiple) spaces
        filename = filename.replaceAll(/\s+/g, " ");
        // Remove leading spaces
        filename = filename.replace(/^\s/, "");
        // Remove trailing spaces if any
        filename = filename.replace(/\s$/, "");
        return filename;
    }

    //tags are strings that are enclosed in square brackets or parentheses or curly braces
    public cleanTags(filename: string): string {
        // Remove tags
        filename = filename.replaceAll(/\[.*?\]/g, "");
        filename = filename.replaceAll(/\(.*?\)/g, "");
        filename = filename.replaceAll(/\{.*?\}/g, "");
        return filename;
    }

    // Remove special characters (eg underscore) except for hyphen(-) , (.), (') and Tag separator (, ), [, ], {, }
    public cleanSpecialChars(filename: string): string {
        // Remove special characters
        const specialChars = ["'", ",", "_", "@", "#", "$", "%", "^", "&", "*", "+", "=", "<", ">", "?", "|", ":", ";", "\"", "`", "~"];
        for (let char of specialChars) {
            filename = filename.replaceAll(char, " ");
        }
        // Remove double (multiple) spaces
        filename = filename.replaceAll(/\s+/g, " ");
        return filename;
    }

    public cleanDot(filename: string): string {
        // Remove dot
        filename = filename.replaceAll(/\./g, " ");
        return filename;
    }

    /**
     * remove the Tag separator "(", ")", "[", "]", "{", "}" from the filename
     * @param filename
     */
    public removeTagSeparator(filename: string): string {
        // Remove tag separators
        filename = filename.replaceAll(/\(|\)|\[|\]|\{|\}/g, "");
        return filename;
    }

    public extractTags(filename: string): string[] {
        // Extract tags
        const tags = filename.match(/\[.*?\]|\(.*?\)|\{.*?\}/g);
        return tags ? tags.map(tag => tag.slice(1, -1)) : [];
    }

    /**
     * remove the remaining hyphens at the end "-" or "- "
     * @param filename
     */
    removeHyphenAtTheEndAndStart(filename: string): string {
        // Remove hyphen at the end
        filename = filename.replace(/-\s*$/, "");
        // Remove hyphen at the start
        filename = filename.replace(/^\s*-/, "");
        return filename;
    }

    /**
     * year ar 4 digits 1800-2099
     * @param filename
     */
    public removeYear(filename: string): string {
        // Remove year
        filename = filename.replaceAll(/\b(19|20)\d{2}\b/g, "");
        return filename;
    }

    /**
     * convert the first letter of each word to uppercase
     * with the exception of small world like "of"
     * Aims to get a movie title style
     * don't touch the original casing of others letters in the words
     * */
    public convertFirstLetterToUpperCase(filename: string): string {
        // List of small words to exclude from capitalization, all in lowercase
        const smallWords = ['of', 'in', 'the', 'on', 'at', 'to', 'a', 'an', 'and', 'but', 'or', 'for', 'nor', 'with'];

        // Split the filename into words
        const words = filename.split(' ');

        // Process each word
        const titleCasedFilename = words
            .map((word, index) => {
                // Check if word is in the list of small words (ignoring case)
                if (index !== 0 && smallWords.includes(word.toLowerCase())) {
                    // If it's a small word (not the first word), return it as is
                    return word;
                } else {
                    // Otherwise, capitalize the first letter but keep the rest of the word as is
                    return word.charAt(0).toUpperCase() + word.slice(1);
                }
            })
            .join(' '); // Join the words back into a string

        return titleCasedFilename;
    }

    public removeNumbers(filename: string): string {
        // Remove numbers
        filename = filename.replaceAll(/\d/g, "");
        return filename;
    }

    public removeExtension(filename: string): string {
        // Find the last index of '.' to identify the extension
        let extensionIndex = filename.lastIndexOf('.');
        if (extensionIndex != -1) {
            // Extract the extension excluding the dot
            let extension = filename.substring(extensionIndex + 1);
            // Check if the length of the extension is 5 or fewer characters
            if (extension.length <= 5) {
                // Remove the extension if it meets the criteria
                filename = filename.substring(0, extensionIndex);
            }
        }
        return filename;
    }

    /**
     * Sanitize a string to be used in a filename or a path - remove illegal characters and reserved names
     * @param value
     */
    sanitizeFilename(value: string): string {
        const illegalRe = /[<>:"\/\\|?*\x00-\x1F]/g; // Regex for Windows' illegal characters
        const controlRe = /[\x00-\x1F\x80-\x9F]/g; // Control characters
        const reservedRe = /^\.+$/; // Reserved filenames in Windows like "." and ".."
        const windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i; // Windows reserved names
        const spaceEndRe = /[\. ]+$/; // Trailing dots or spaces

        let sanitized = value
            .replace(illegalRe, '') // Remove illegal characters
            .replace(controlRe, '')
            .replace(reservedRe, '')
            .replace(windowsReservedRe, '')
            .replace(spaceEndRe, '');

        // Ensure the filename is not too long
        const MAX_LENGTH = 255;
        if (sanitized.length > MAX_LENGTH) {
            sanitized = sanitized.substring(0, MAX_LENGTH);
        }

        return sanitized;
    }

}