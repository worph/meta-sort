import {FileNameCleaner} from "./tools/FileNameCleaner.js";
import {StringArrayOperation} from "./tools/StringArrayOperation.js";
import {SerieFilesNameAnalysisTool} from "./tools/video/SerieFilesNamaAnalysisTool.js";
import path from 'path';

/**
 * Result of video file metadata extraction
 */
export interface VideoFileMetadata {
    originalTitle?: string;
    season?: string;
    episode?: string;
    increment?: string;
    movieYear?: string;
    videoType?: 'tvshow' | 'movie';
    extra?: string;
}

const MIN_TITLE_LENGTH = 3;

export class FileNameVideoMetaExtractor {
    fileNameCleaner = new FileNameCleaner();
    stringArrayOperation = new StringArrayOperation();
    serieFilesNameAnalysisTool: SerieFilesNameAnalysisTool;

    constructor(
        private watchFolderList: string[],
        private episodePatterns:string[],
        private seasonAndEpisodePatterns:string[],
        private seasonPatterns:string[],
        private extraEpKeyWords:string[],
        private keywordsArray:string[],
        private substringArray:string[],
        private soloEp,
    ) {
        this.serieFilesNameAnalysisTool = new SerieFilesNameAnalysisTool(
            episodePatterns,
            seasonAndEpisodePatterns,
            seasonPatterns,
            extraEpKeyWords,
            keywordsArray,
            substringArray,
            soloEp
        );
    }

    /**
     * Returns the name of the folder at a specified parent level from the file path,
     * or null if the file is not under any of the media root folders defined in watchFolderList,
     * or if no media root folder is defined, calculates based on the file path directly.
     * @param filePath The file path to check.
     * @param parent The parent level to adjust the depth check (1 for parent folder, 2 for grandparent folder, etc.).
     * @return The name of the folder at the specified parent level or null.
     */
    getParentFolder(filePath: string, parent: number): string | null {
        if (parent < 0 || !Number.isInteger(parent)) {
            throw new Error('Parent parameter must be a non-negative integer.');
        }

        const normalizedFilePath = path.normalize(filePath);

        const folderList = this.watchFolderList;
        if (folderList && folderList.length > 0) {
            for (let folder of folderList) {
                const mediaRootFolder = path.normalize(folder);
                if (normalizedFilePath.startsWith(mediaRootFolder)) {
                    const pathRelative = path.relative(mediaRootFolder, normalizedFilePath);
                    const pathParts = pathRelative.split(path.sep);
                    pathParts.reverse(); // Reverse the array to make it easier to access the parent levels.

                    if (pathParts.length >= parent) {
                        return pathParts[parent]; // Adjusted for zero-indexed arrays.
                    }
                    return null; // The specified parent level is too deep.
                }
            }
            return null; // File path is not under any of the media root folders.
        }

        // General solution for any parent level when no watchFolderList is defined.
        let targetFolder = normalizedFilePath;
        for (let i = 0; i < parent; i++) {
            targetFolder = path.dirname(targetFolder);
        }
        if (targetFolder === path.sep || !targetFolder) {
            return null; // Reached the root or an invalid state.
        }
        return path.basename(targetFolder);
    }


    /**
     * Title cleaning
     */

    cleanTitle(simpleTitle: string): string {
        if (!simpleTitle) {
            return null;
        }
        simpleTitle = this.fileNameCleaner.cleanSpecialChars(simpleTitle);
        simpleTitle = this.serieFilesNameAnalysisTool.removeKeywordsFromFilename(simpleTitle);
        simpleTitle = this.fileNameCleaner.cleanTags(simpleTitle);
        simpleTitle = this.serieFilesNameAnalysisTool.removeBeyondHyphen(simpleTitle);
        simpleTitle = this.fileNameCleaner.removeTagSeparator(simpleTitle);
        simpleTitle = this.fileNameCleaner.removeYear(simpleTitle);
        simpleTitle = this.serieFilesNameAnalysisTool.removeSFV(simpleTitle);
        simpleTitle = this.serieFilesNameAnalysisTool.removeSeasonAndEpisode(simpleTitle);
        simpleTitle = this.fileNameCleaner.cleanDot(simpleTitle);
        //simpleTitle = this.fileNameCleaner.removeNumbers(simpleTitle);
        simpleTitle = this.fileNameCleaner.removeHyphenAtTheEndAndStart(simpleTitle);
        simpleTitle = this.fileNameCleaner.cleanSpace(simpleTitle);
        simpleTitle = this.fileNameCleaner.convertFirstLetterToUpperCase(simpleTitle);
        simpleTitle = this.fileNameCleaner.sanitizeFilename(simpleTitle);
        return simpleTitle;
    }

    computeTitleFromFileName(fileName: string): string {
        return this.cleanTitle(fileName);
    }

    computeTitleFromParentFolder(filePath: string): string {
        return this.cleanTitle(this.getParentFolder(filePath, 1));
    }

    computeTitleFromGrandParentFolder(filePath: string): string {
        return this.cleanTitle(this.getParentFolder(filePath, 2));
    }

    /**
     * Check if a filename contains a season/episode pattern (indicates TV show)
     */
    private filenameHasSeasonEpisodePattern(filename: string): boolean {
        const cleanedFilename = this.serieFilesNameAnalysisTool.removeKeywordsFromFilename(filename);
        const cleanedFilename2 = this.serieFilesNameAnalysisTool.removeSFV(cleanedFilename);
        const cleanedFilename3 = this.fileNameCleaner.cleanSpecialChars(cleanedFilename2);
        const cleanedFilename4 = this.fileNameCleaner.cleanSpace(cleanedFilename3);
        const [season, episode] = this.serieFilesNameAnalysisTool.findSeasonAndEpisode(cleanedFilename4);
        return season >= 0 || episode >= 0;
    }

    computeTitleFromFilePath(filePath: string): string | undefined {
        let filename = this.fileNameCleaner.getFilenameFromPath(filePath);
        let titleFromFileName = this.computeTitleFromFileName(filename);
        let titleFromParentFolder = this.computeTitleFromParentFolder(filePath);
        let titleFromGrandParentFolder = this.computeTitleFromGrandParentFolder(filePath);
        let simpleTitle = this.stringArrayOperation.longestString([titleFromFileName, titleFromParentFolder, titleFromGrandParentFolder]);

        // Check if filename contains season/episode pattern (indicates TV show)
        const isTvShow = this.filenameHasSeasonEpisodePattern(filename);

        let selectedTitle;

        if (isTvShow) {
            // For TV shows, prefer the longer title between filename and folder
            // This handles cases like "S01E01-The Fool.mkv" where "The Fool" is the episode name
            // but "Lord of Mysteries" in the parent folder is the actual series title
            const filenameTitleValid = titleFromFileName && titleFromFileName.length > MIN_TITLE_LENGTH;
            const folderTitleValid = titleFromParentFolder && titleFromParentFolder.length > MIN_TITLE_LENGTH;

            if (filenameTitleValid && folderTitleValid) {
                // Both valid - prefer the longer one (series names are typically longer than episode names)
                // Use strict > to avoid preferring folder when lengths are equal (e.g., "Dexter" vs "Series")
                selectedTitle = titleFromParentFolder.length > titleFromFileName.length
                    ? titleFromParentFolder
                    : titleFromFileName;
            } else if (folderTitleValid) {
                selectedTitle = titleFromParentFolder;
            } else if (filenameTitleValid) {
                selectedTitle = titleFromFileName;
            } else if (titleFromGrandParentFolder && titleFromGrandParentFolder.length > MIN_TITLE_LENGTH) {
                selectedTitle = titleFromGrandParentFolder;
            } else {
                selectedTitle = simpleTitle;
            }
        } else {
            // For non-TV shows (movies, etc.), use original logic: prefer filename
            if (titleFromFileName && titleFromFileName.length > MIN_TITLE_LENGTH) {
                selectedTitle = titleFromFileName;
            } else if (titleFromParentFolder && titleFromParentFolder.length > MIN_TITLE_LENGTH) {
                selectedTitle = titleFromParentFolder;
            } else if (titleFromGrandParentFolder && titleFromGrandParentFolder.length > MIN_TITLE_LENGTH) {
                selectedTitle = titleFromGrandParentFolder;
            } else {
                selectedTitle = simpleTitle;
            }
        }

        if (selectedTitle && selectedTitle.length > MIN_TITLE_LENGTH) {
            return selectedTitle;
        }
        return undefined;
    }

    /**
     * Season Ep cleaning
     */

    computeSeasonFromParentFolder(filePath: string): number {
        let parentFolder = this.getParentFolder(filePath, 1);
        if (!parentFolder) {
            return -1;
        }
        let parentFolderName = path.basename(path.dirname(filePath));
        parentFolderName = this.serieFilesNameAnalysisTool.removeKeywordsFromFilename(parentFolderName);
        parentFolderName = this.fileNameCleaner.cleanTags(parentFolderName);
        parentFolderName = this.fileNameCleaner.cleanSpecialChars(parentFolderName);
        parentFolderName = this.fileNameCleaner.cleanDot(parentFolderName);
        parentFolderName = this.fileNameCleaner.cleanSpace(parentFolderName);
        return this.serieFilesNameAnalysisTool.findSeasonFromParentFolder(parentFolderName);
    }

    computeSeasonAndEpisodeFromFilename(filename: string): [number, number] { // season , episode
        filename = this.serieFilesNameAnalysisTool.removeKeywordsFromFilename(filename);
        filename = this.serieFilesNameAnalysisTool.removeSFV(filename);
        filename = this.fileNameCleaner.cleanSpecialChars(filename);
        filename = this.fileNameCleaner.cleanSpace(filename);
        return this.serieFilesNameAnalysisTool.findSeasonAndEpisode(filename);
    }

    computeSeasonAndEpisodeFromFilePath(filePath: string): { season?: string; episode?: string; increment?: string } {
        const result: { season?: string; episode?: string; increment?: string } = {};
        let filename = this.fileNameCleaner.getFilenameFromPath(filePath);
        const seasonFromParentFolder = this.computeSeasonFromParentFolder(filePath);
        let [sea, ep] = this.computeSeasonAndEpisodeFromFilename(filename);

        //season and ep 0 can exist (but < 0 is not possible)
        // first trust file then trust parent folder
        if (sea >= 0) {
            result.season = "" + sea;
        } else if (seasonFromParentFolder >= 0) {
            sea = seasonFromParentFolder;
            result.season = "" + sea;
        }
        if (ep >= 0) {
            result.episode = "" + ep;
        }
        if (ep >= 0) {
            if (sea < 0) {
                sea = 1;
                //assume season 1
                result.season = "1";
            }
            //max ep is 9999
            result.increment = "" + (sea * 10000 + ep);
        }
        return result;
    }

    /**
     * Movie Year cleaning
     */
    computeMovieYearFromFilename(filename: string): number {
        //year are most probably in a tag so no cleaning eg "(2020) or [2020] or {2020} or 2020"
        return this.serieFilesNameAnalysisTool.findMovieYear(filename);
    }

    computeMovieYearFromParentFolder(filePath: string): number {
        let parentFolder = this.getParentFolder(filePath, 1);
        if (!parentFolder) {
            return null;
        }
        let parentFolderName = path.basename(path.dirname(filePath));
        parentFolderName = this.serieFilesNameAnalysisTool.removeKeywordsFromFilename(parentFolderName);
        parentFolderName = this.fileNameCleaner.cleanSpecialChars(parentFolderName);
        parentFolderName = this.fileNameCleaner.cleanDot(parentFolderName);
        parentFolderName = this.fileNameCleaner.cleanSpace(parentFolderName);
        return this.serieFilesNameAnalysisTool.findMovieYear(parentFolderName);
    }

    computeMovieYearFromFilePath(filePath: string): string | undefined {
        let filename = this.fileNameCleaner.getFilenameFromPath(filePath);
        let movieYear = this.computeMovieYearFromFilename(filename);
        let movieYearFromParentFolder = this.computeMovieYearFromParentFolder(filePath);
        //first trust file then trust parent folder
        if (movieYear > 0) {
            return "" + movieYear;
        } else if (movieYearFromParentFolder > 0) {
            return "" + movieYearFromParentFolder;
        }
        return undefined;
    }

    /**
     * Extract metadata from a video file path
     * @returns Plain object with extracted metadata
     */
    public extractVideoFileMetadata(filePath: string): VideoFileMetadata {
        const result: VideoFileMetadata = {};

        // Extract title
        const title = this.computeTitleFromFilePath(filePath);
        if (title) {
            result.originalTitle = title;
        }

        // Extract movie year
        const movieYear = this.computeMovieYearFromFilePath(filePath);
        if (movieYear) {
            result.movieYear = movieYear;
        }

        // Extract season and episode
        const seasonEpisode = this.computeSeasonAndEpisodeFromFilePath(filePath);
        if (seasonEpisode.season) result.season = seasonEpisode.season;
        if (seasonEpisode.episode) result.episode = seasonEpisode.episode;
        if (seasonEpisode.increment) result.increment = seasonEpisode.increment;

        // Check for extra flag
        if (this.serieFilesNameAnalysisTool.isExtra(filePath)) {
            result.extra = "true";
        }

        // Compute video type
        const season = result.season ? parseInt(result.season) : -1;
        const episode = result.episode ? parseInt(result.episode) : -1;
        const year = result.movieYear ? parseInt(result.movieYear) : -1;

        if (season > 0 || episode > 0) {
            result.videoType = "tvshow";
        } else if (year > 1800 && year < 2100) {
            result.videoType = "movie";
        }

        return result;
    }

    /**
     * @deprecated Use extractVideoFileMetadata instead - returns plain object
     */
    public processVideoFile(filePath: string, metadata: any): void {
        const result = this.extractVideoFileMetadata(filePath);

        // Write to metadata object for backwards compatibility
        if (result.originalTitle) metadata.at("originalTitle").set(result.originalTitle);
        if (result.movieYear) metadata.at("movieYear").set(result.movieYear);
        if (result.season) metadata.at("season").set(result.season);
        if (result.episode) metadata.at("episode").set(result.episode);
        if (result.increment) metadata.at("increment").set(result.increment);
        if (result.extra) metadata.at("extra").set(result.extra);
        if (result.videoType) metadata.at("videoType").set(result.videoType);
    }
}
