import {
    AnimeMeta, FileNameMeta,
    FileStatMeta,
    HashMeta,
    LanguagesMeta, SubtitleFileMeta,
    VersionMeta,
    VideoMeta
} from "@metazla/meta-interface";

type Local =  VideoMeta & HashMeta & FileStatMeta & AnimeMeta & VersionMeta & LanguagesMeta & SubtitleFileMeta & FileNameMeta;

/**
 * return the path relative to the root folder
 */
export function renamingRule(metamesh: Local, filepath?: string): string | null {
    let supported = ['video', 'subtitle', 'torrent'];

    //check if filetype is one of the suported ones
    if (!supported.includes(metamesh.fileType)) {
        return null;
    }

    // Extract the file extension from the original file path
    const extension = metamesh.extension;
    if (!extension) {
        throw new Error(`No extension found for file: ${filepath}`);
    }

    const title = metamesh?.titles?.eng || metamesh.originalTitle;
    if (!title) {
        if (metamesh.fileType !== "torrent") {
            //don't warn for torrent files because they don't always have a title (eg representing a folder of files)
            throw new Error(`No title found for file: ${filepath}`);
        }
        return null;
    }


    let newPath = "";

    const season = metamesh.season ? ("S" + String(metamesh.season).padStart(2, '0')) : "";
    const seasonSpace = metamesh.season ? ` ${season}` : "";
    const episode = metamesh.episode ? ("E" + String(metamesh.episode).padStart(2, '0')) : "";
    const version = metamesh.version ? ` ${metamesh.version}` : "";
    const year = metamesh.movieYear ? ` (${metamesh.movieYear})` : "";
    const subtitle = metamesh.fileType === "subtitle" && metamesh.subtitleLanguage ? `.${metamesh.subtitleLanguage}` : "";
    const fileName = `${title}${seasonSpace}${episode}${year}${subtitle}${version}.${extension}`;

    // Simplified structure: TV Shows for series, Movies for standalone content
    // Note: season can be 0 (special episodes), so check for null/undefined explicitly
    const hasSeason = metamesh.season !== null && metamesh.season !== undefined;
    const hasEpisode = metamesh.episode !== null && metamesh.episode !== undefined;

    if (metamesh.extra) {
        newPath = `TV Shows/${title}/extra/${fileName}`;
    } else if (hasSeason && hasEpisode) {
        newPath = `TV Shows/${title}/${season}/${fileName}`;
    } else {
        newPath = `Movies/${title}${year}/${fileName}`;
    }
    return newPath;
}