export class SerieFilesNameAnalysisTool {

    constructor(
        private episodePatterns:string[],
        private seasonAndEpisodePatterns:string[],
        private seasonPatterns:string[],
        private extraEpKeyWords:string[],
        private keywordsArray:string[],
        private substringArray:string[],
        private soloEp,
    ) {
        //ensure keywords are sorted by length in descending order because we want to remove the longest keyword first
        keywordsArray.sort((a, b) => b.length - a.length); // Sort keywords by length in descending order
        substringArray.sort((a, b) => b.length - a.length); // Sort keywords by length in descending order
        extraEpKeyWords.sort((a, b) => b.length - a.length); // Sort keywords by length in descending order
    }

    private getSeasonAndEpisodePatterns(): RegExp[] {        // Patterns for matching season and episode
        return this.seasonAndEpisodePatterns.map(pattern => new RegExp(pattern, 'i')); // Apply 'i' flag for case-insensitive matching
    }

    private getEpisodeOnlyPatterns(): RegExp[] {
        return this.episodePatterns.map(pattern => new RegExp(pattern, 'i')); // Apply 'i' flag for case-insensitive matching
    }

    private getSeasonOnlyPatterns(): RegExp[] {
        return this.seasonPatterns.map(pattern => new RegExp(pattern, 'i')); // Apply 'i' flag for case-insensitive matching
    }


    findMovieYear(filename: string): number {
        const yearPattern = "\\b(19|20)\\d{2}\\b"; // Matches 1900-2099
        const match = filename.match(yearPattern);
        if (match) {
            return parseInt(match[0], 10);
        }

        return -1; // Indicates that no year pattern was found
    }

    /**
     * Find the season and episode numbers in the filename
     * Must keep the "." for the float episode number
     * @param filename
     */
    findSeasonAndEpisode(filename: string): [number, number] {
        // Combine season & episode and episode-only patterns
        const combinedPatterns = [...this.getSeasonAndEpisodePatterns(), ...this.getEpisodeOnlyPatterns()];
        filename = " "+filename+" "; // Add spaces to the beginning and end of the filename to ensure word boundaries (easier regex matching)
        const dxs = 1;//number of parentesis match in the regex (before the interesting one)
        for (const pattern of combinedPatterns) {
            const match = filename.match(pattern);
            if (match) {
                if(match.length==dxs+2) {
                    // Extract season and episode from the match
                    const season = parseFloat(match[dxs]);
                    const episode = parseFloat(match[dxs+1]);
                    return [season, episode];
                }else if(match.length==dxs+1){
                    const season = -1;
                    const episode = parseFloat(match[dxs]); // Assumes Season 1 if only an episode is found
                    return [season, episode];
                }
            }
        }
        //last hope
        //Try to match the  number the most on the right
        let number = this.extractRightmostNumber(filename);
        if(number){
            return [-1, number];
        }
        return [-1, -1]; // Indicates no season/episode pattern was found
    }

    removeSeasonAndEpisode(filename: string): string {
        // Get both sets of patterns
        const allPatterns = [
            ...this.getSeasonAndEpisodePatterns(),
            ...this.getEpisodeOnlyPatterns(),
            ...this.getSeasonOnlyPatterns()
        ];

        // Remove season and episode info from filename
        let match = false;
        for (const pattern of allPatterns) {
            if(filename.match(pattern) != null) {
                filename = filename.replace(pattern, '');
                match = true;
                break;
            }
        }
        if(!match){
            filename = this.removeRightmostNumber(filename);
        }

        return filename.trim(); // Trim any leading/trailing whitespace that may have been left
    }

    isExtra(filename: string): boolean {
        // Remove season and episode info from filename
        let match = false;
        for (const keyword of this.extraEpKeyWords) {
            // Prepare keyword for regex. Since we're focusing on strict word boundaries, we don't escape parentheses in keywords as before
            const preparedKeyword = keyword.replace(/([.*+?^=!:${}|\[\]\/\\])/g, "\\$1");
            // Create regex from keyword, ensuring word boundaries, case insensitive ('i') and global ('g') to replace all occurrences
            const pattern = new RegExp(`\\b${preparedKeyword}`, 'gi');
            if(filename.match(pattern) != null) {
                match = true;
                break;
            }
        }
        return match;
    }


    extractRightmostNumber (str: string): number | null {
        const matches = str.match(new RegExp(this.soloEp, 'g'));
        return matches ? parseFloat(matches[matches.length - 1]) : null;
    };

    removeRightmostNumber(str: string): string {
        // This regex matches the rightmost number in the string, including optional negative sign and decimals
        const regex = new RegExp(this.soloEp);
        return str.replace(regex, '').trim();
    };


    /**
     * Remove everything beyond the first hyphen in the filename but only if the hyphen is a word boundary
     * eg The Mandalorian - Chapter 1 S01E01.mkv -> The Mandalorian
     * eg Sherlock - A Scandal in Belgravia S02E03.mkv -> Sherlock
     * eg [SubsPlease] Shangri-La Frontier - 07 (1080p) [FC412C51].nfo -> [SubsPlease]  Shangri-La Frontier - 07 (1080p) [FC412C51].mkv
     * Delimiter char around hyphen can be any non-word char  " ",".","_"
     * @param filename
     */
    removeBeyondHyphen(filename: string): string {
        // This pattern targets a hyphen that is acting as a delimiter, based on surrounding context (e.g., spaces).
        // It will match the first instance of a hyphen surrounded by spaces or a hyphen at the end before trimming.
        // The addition of '?\s*$' accounts for cases where the hyphen may be followed by optional spaces before the end of the string.
        const pattern = /^(.*?)(\s+-\s+|\s+-).*|\s*-\s*$/;

        // Use the pattern to replace the content beyond the first delimiter hyphen or a trailing hyphen, if matched.
        const replacement = filename.replace(pattern, '$1').trim();

        // Return the potentially trimmed filename, preserving internal hyphens but removing a trailing delimiter hyphen.
        return replacement;
    }

    /**
     * Simple file verification (SFV) is a file format for storing CRC32 checksums
     * @param filename
     */
    removeSFV(filename: string): string {
        // Regular expression to match an 8-character hexadecimal string
        const hexIdPattern = /\b[A-F0-9]{8}\b/i;

        // Replace the hexadecimal ID with an empty string
        return filename.replace(hexIdPattern, '').trim();
    }

    removeKeywordsFromFilename(filename: string): string {
        // Iterate over each keyword/pattern and remove it from the filename
        for (const keyword of this.keywordsArray) {
            // Prepare keyword for regex. Since we're focusing on strict word boundaries, we don't escape parentheses in keywords as before
            const preparedKeyword = keyword.replace(/([.*+?^=!:${}|\[\]\/\\])/g, "\\$1");
            // Create regex from keyword, ensuring word boundaries, case insensitive ('i') and global ('g') to replace all occurrences
            const regex = new RegExp(`\\b${preparedKeyword}\\b`, 'gi');
            // Replace occurrences of the keyword in the filename
            filename = filename.replace(regex, '');
        }

        // Iterate over each substring and remove it from the filename
        for (const substring of this.substringArray) {
            // Prepare substring for regex. Since we're focusing on strict word boundaries, we don't escape parentheses in keywords as before
            const preparedSubstring = substring.replace(/([.*+?^=!:${}|\[\]\/\\])/g, "\\$1");
            // Create regex from keyword, ensuring word boundaries, case insensitive ('i') and global ('g') to replace all occurrences
            const regex = new RegExp(preparedSubstring, 'gi');
            // Replace occurrences of the keyword in the filename
            filename = filename.replace(regex, '');
        }

        return filename;
    }


    findSeasonFromParentFolder(parentFolderName: string): number {
        const minSeaNbLen = 1, maxSeaNbLen = 2;

        const seaNumberString = `(\\d{${minSeaNbLen},${maxSeaNbLen}})`;

        const patterns = [
            "\\bSeason\\s*(\\d{1,2})\\b", // Season 1 (eng)
            "\\bSaison\\s*(\\d{1,2})\\b", // Saison 1 (fra)
            "\\bS(\\d{1,2})\\b", // S01
            "\\b(\\d{1,2})\\b", // 01
            `\\b\\w+\\s*\\(${seaNumberString}\\)\\b`, // title then (number)
        ];

        for (const pattern of patterns) {
            const match = parentFolderName.match(pattern);
            if (match) {
                const season = match[1] ? parseInt(match[1], 10) : -1; // Assumes Season 1 for "Episode 2" format
                return season;
            }
        }

        return -1; // Indicates that no season pattern was found
    }
}