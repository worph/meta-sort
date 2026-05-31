export const FileMetaDataName = [
    "fileType",
    "mimeType",
    "byteSize",
]

// Sibling CIDs are stored as the bare-CID key-set `cids/<cid>` (see HashMeta),
// not as per-algorithm cid_* fields. The single member prefix is `cids`.
export const hashMetaDataName = [
    "cids",
];

export const AnimeMetaData = [
    "anime"
];

export const FFMpegMetaData = [
    "fileinfo"
];

export const FileNameMetaData = [
    "fileName",
    "extension",
    "videoType",
    "extra",
    "season",
    "episode",
    "increment",
    "movieYear",
    "title",
    "titles",
];

export const TorrentMetaData = [
    "trakers"
];

export const VideoMetaData = [
    "subtitles"
];

export const JellyfinMetaData = [
    "videoType", // Noted as optional and with specific types in your comment, but listed as a simple string here
    "episode",
    "season",
    "title",
    "year",
    "originaltitle",
    "imdbid",
    "tmdbid",
    "anidbid",
    "premiered",
    "genre",
    "releasedate",
    "plot",
    "director",
    "rating",
    "runtime",
    "studio",
    "art",
    "actor",
    "showtitle",
    "aired",
    "customrating",
    "dateadded",
    "sorttitle",
    "mpaa",
    "aspectratio",
    "collectionnumber",
    "criticrating",
];