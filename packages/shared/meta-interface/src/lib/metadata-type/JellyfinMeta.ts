import {LanguageData} from "./basic/LanguageData.js";
import {RecordSet} from "./basic/RecordSet.js";
import {VideoMeta} from "./VideoMeta.js";
import {TagsMeta} from "./TagsMeta.js";
import {LanguagesMeta} from "./LanguagesMeta.js";
import {GenreMeta} from "./GenreMeta.js";
import {FileRef} from "./basic/FileRef";

export interface IMDBMeta{
    imdbid?: string;
    criticrating?: string;
}

export interface TMDBMeta{
    tmdbid?: string;
}

export interface AnidbMeta{
    anidbid?: string;
}

export interface JellyfinMeta extends
    IMDBMeta,
    TMDBMeta,
    AnidbMeta,
    VideoMeta,
    TagsMeta,
    LanguagesMeta,
    GenreMeta
{
    releasedate?: string;
    plot?: LanguageData<string>;//key is language ISO 639-1 code
    rating?: string;
    studio?: RecordSet;
    art?:{
        poster?: FileRef;
        fanart?: FileRef;
    };
    mpaa?: string;
    //TODO add more fields in the future
}

export const JellyfinMetaFields = [
    "imdbid",
    "tmdbid",
    "anidbid",
    "extra",
    "season",
    "episode",
    "increment",
    "movieYear",
    "videoType",
    "originalTitle",
    "titles",
    "tags",
    "languages",
    "genre",
    "releasedate",
    "plot",
    "rating",
    "studio",
    "art",
    "mpaa",
];