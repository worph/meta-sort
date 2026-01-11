import yaml from 'yaml';
const { stringify: yamlStringify } = yaml;
import { Builder } from 'xml2js';

/**
 * Supported metadata format types
 */
export enum MetadataFormatType {
    META = 'meta',
    JELLYFIN = 'jellyfin'
}

/**
 * Interface for metadata format handlers
 * Note: metadata parameter uses `any` type because it combines multiple metadata interfaces
 * (HashMeta, JellyfinMeta, VideoMeta, etc.) and TypeScript doesn't have a single type for this union
 */
export interface IMetadataFormatHandler {
    /**
     * The file extension for this format (e.g., '.meta', '.nfo')
     */
    readonly extension: string;

    /**
     * The format type identifier
     */
    readonly formatType: MetadataFormatType;

    /**
     * Serialize metadata to string format
     * @param metadata The metadata to serialize (combination of various metadata interfaces)
     * @returns Serialized string content
     */
    serialize(metadata: any): string;
}

/**
 * Handler for .meta YAML format
 */
export class MetaFormatHandler implements IMetadataFormatHandler {
    readonly extension = '.meta';
    readonly formatType = MetadataFormatType.META;

    serialize(metadata: any): string {
        return yamlStringify(metadata);
    }
}

/**
 * Handler for Jellyfin .nfo XML format
 */
export class JellyfinFormatHandler implements IMetadataFormatHandler {
    readonly extension = '.nfo';
    readonly formatType = MetadataFormatType.JELLYFIN;

    serialize(metadata: any): string {
        // Only include Jellyfin-compatible fields
        const jellyfinData = this.filterJellyfinFields(metadata);

        // Determine root element based on video type
        const rootElementName = this.isMovieOrTvShow(jellyfinData) === "tvshow" ? 'episodedetails' : "movie";

        // Convert to XML-friendly format
        const xmlData = this.convertToJsonXml(jellyfinData);

        // Build XML
        const obj = {
            [rootElementName]: xmlData
        };

        const builder = new Builder({
            xmldec: { version: '1.0', encoding: 'UTF-8', standalone: true }
        });

        return builder.buildObject(obj);
    }

    private filterJellyfinFields(metadata: any): any {
        const jellyfinFields: any = {};

        // Video metadata
        if (metadata.videoType) jellyfinFields.videoType = metadata.videoType;
        if (metadata.season) jellyfinFields.season = metadata.season;
        if (metadata.episode) jellyfinFields.episode = metadata.episode;
        if (metadata.originalTitle) jellyfinFields.originalTitle = metadata.originalTitle;
        if (metadata.movieYear) jellyfinFields.year = metadata.movieYear;

        // Titles (first title or original title)
        if (metadata.titles) {
            const titleEntries = Object.entries(metadata.titles);
            if (titleEntries.length > 0) {
                jellyfinFields.title = titleEntries[0][1];
            }
        }

        // IDs
        if (metadata.imdbid) jellyfinFields.imdbid = metadata.imdbid;
        if (metadata.tmdbid) jellyfinFields.tmdbid = metadata.tmdbid;
        if (metadata.anidbid) jellyfinFields.anidbid = metadata.anidbid;

        // Additional fields
        if (metadata.rating) jellyfinFields.rating = metadata.rating;
        if (metadata.plot) jellyfinFields.plot = metadata.plot;
        if (metadata.studio) jellyfinFields.studio = metadata.studio;
        if (metadata.releasedate) jellyfinFields.releasedate = metadata.releasedate;
        if (metadata.mpaa) jellyfinFields.mpaa = metadata.mpaa;

        // Sets (genres, tags, languages)
        if (metadata.genres) jellyfinFields.genre = metadata.genres;
        if (metadata.tags) jellyfinFields.tag = metadata.tags;
        if (metadata.languages) jellyfinFields.language = metadata.languages;

        // Art
        if (metadata.art) {
            if (metadata.art.poster) jellyfinFields.poster = metadata.art.poster;
            if (metadata.art.fanart) jellyfinFields.fanart = metadata.art.fanart;
        }

        return jellyfinFields;
    }

    private isMovieOrTvShow(metadata: any): "tvshow" | "movie" {
        if (metadata.videoType) {
            return metadata.videoType;
        } else if (metadata.episode) {
            return "tvshow";
        } else {
            return "movie";
        }
    }

    private convertToJsonXml(input: any): any {
        const output: any = {};

        for (const [key, value] of Object.entries(input)) {
            if (value instanceof Set) {
                // Convert Set to array of items for XML
                const array = Array.from(value as any);
                if (array.length > 0) {
                    output[key] = array;
                }
            } else if (value instanceof Array) {
                output[key] = value;
            } else if (typeof value === 'object' && value !== null) {
                // For nested objects, recursively convert
                output[key] = [this.convertToJsonXml(value)];
            } else {
                output[key] = [value];
            }
        }

        return output;
    }
}

/**
 * Registry for metadata format handlers
 */
export class MetadataFormatRegistry {
    private handlers: Map<MetadataFormatType, IMetadataFormatHandler> = new Map();

    constructor() {
        // Register default handlers
        this.registerHandler(new MetaFormatHandler());
        this.registerHandler(new JellyfinFormatHandler());
    }

    /**
     * Register a new format handler
     */
    registerHandler(handler: IMetadataFormatHandler): void {
        this.handlers.set(handler.formatType, handler);
    }

    /**
     * Get handler by format type
     */
    getHandler(formatType: MetadataFormatType): IMetadataFormatHandler | undefined {
        return this.handlers.get(formatType);
    }

    /**
     * Get handler by format name (case-insensitive)
     */
    getHandlerByName(formatName: string): IMetadataFormatHandler | undefined {
        const normalizedName = formatName.toLowerCase();
        for (const [type, handler] of this.handlers.entries()) {
            if (type.toLowerCase() === normalizedName) {
                return handler;
            }
        }
        return undefined;
    }

    /**
     * Get all registered handlers
     */
    getAllHandlers(): IMetadataFormatHandler[] {
        return Array.from(this.handlers.values());
    }

    /**
     * Get handlers for specified format names
     */
    getHandlersForFormats(formatNames: string[]): IMetadataFormatHandler[] {
        const handlers: IMetadataFormatHandler[] = [];
        for (const name of formatNames) {
            const handler = this.getHandlerByName(name);
            if (handler) {
                handlers.push(handler);
            } else {
                console.warn(`Unknown metadata format: ${name}. Supported formats: ${Array.from(this.handlers.keys()).join(', ')}`);
            }
        }
        return handlers;
    }
}
