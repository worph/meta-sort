import {FileNameCleaner} from "./tools/FileNameCleaner.js";
import {FileType} from "./FileType.js";
import path from 'path';

import {episodePatterns, seasonAndEpisodePatterns, seasonPatterns, soloEp} from "./config/SeasonAndEpisodePatterns.js";
import {extraEpKeyWords, keywordsArray, substringArray} from "./config/KeywordsArray.js";
import {existsSync, readFileSync} from "fs";
import {extensionMappings} from "./config/ExtentionsMapping.js";
import {mimeTypeMappings} from "./config/MimeTypeMapping.js";
import {FileNameVideoMetaExtractor, VideoFileMetadata} from "./FileNameVideoMetaExtractor.js";
import {FileTypeConfigurable} from "./tools/FileTypeConfigurable.js";

/**
 * Result of file metadata extraction
 */
export interface FileMetadata extends VideoFileMetadata {
    fileName?: string;
    extension?: string;
    fileType?: string;
    tags?: string[];
}

export class FileNameMetaExtractor {
    fileNameVideoMetaExtractor: FileNameVideoMetaExtractor;
    fileNameCleaner: FileNameCleaner = new FileNameCleaner();
    private fileType: FileType;

    constructor(watchFolderList: string[], jsonConfigFile?: string) {
        // Load the config file
        let config: any = {};
        if (jsonConfigFile && existsSync(jsonConfigFile)) {
            const rawData = readFileSync(jsonConfigFile, 'utf-8');
            config = JSON.parse(rawData);
        }

        // Use the config values or the default ones
        this.fileType = new FileTypeConfigurable(
            config.extensionMappings || extensionMappings,
            config.mimeTypeMappings || mimeTypeMappings
        );

        this.fileNameVideoMetaExtractor = new FileNameVideoMetaExtractor(
            watchFolderList,
            config.episodePatterns || episodePatterns,
            config.seasonAndEpisodePatterns || seasonAndEpisodePatterns,
            config.seasonPatterns || seasonPatterns,
            config.extraEpKeyWords || extraEpKeyWords,
            config.keywordsArray || keywordsArray,
            config.substringArray || substringArray,
            config.soloEp || soloEp);
    }

    /**
     * Extract metadata from a file path
     * @returns Plain object with extracted metadata
     */
    async extractMetadata(filePath: string): Promise<FileMetadata> {
        const result: FileMetadata = {};

        // Get file type using mime type and file extension
        const fileType = await this.fileType.getFileType(filePath);
        const fileName = path.basename(filePath);
        let fileExtension = path.extname(filePath);

        // Remove the dot from the extension
        fileExtension = fileExtension.slice(1);

        result.fileName = fileName;
        result.extension = fileExtension;
        result.fileType = fileType;

        // Extract tags from brackets
        const tags = this.fileNameCleaner.extractTags(filePath);
        if (tags.length > 0) {
            result.tags = tags;
        }

        // For video and subtitle files, extract video-specific metadata
        const supportedVideoType = ['video', 'subtitle'];
        if (supportedVideoType.includes(fileType)) {
            const videoMetadata = this.fileNameVideoMetaExtractor.extractVideoFileMetadata(filePath);
            Object.assign(result, videoMetadata);
        }

        return result;
    }

    /**
     * @deprecated Use extractMetadata instead - returns plain object
     */
    async processFile(filePath: string, metadata: any): Promise<void> {
        const result = await this.extractMetadata(filePath);

        // Write to metadata object for backwards compatibility
        if (result.fileName) metadata.at("fileName").set(result.fileName);
        if (result.extension) metadata.at("extension").set(result.extension);
        if (result.tags) {
            for (const tag of result.tags) {
                metadata.at("tags").add(tag);
            }
        }
        if (result.originalTitle) metadata.at("originalTitle").set(result.originalTitle);
        if (result.movieYear) metadata.at("movieYear").set(result.movieYear);
        if (result.season) metadata.at("season").set(result.season);
        if (result.episode) metadata.at("episode").set(result.episode);
        if (result.increment) metadata.at("increment").set(result.increment);
        if (result.extra) metadata.at("extra").set(result.extra);
        if (result.videoType) metadata.at("videoType").set(result.videoType);
    }
}