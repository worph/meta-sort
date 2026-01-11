import {LanguageData} from "./basic/LanguageData.js";
import {VideoType} from "./basic/VideoType";

export interface VideoMeta {
    extra?: string;
    season?: string;
    episode?: string;
    increment?: string;
    movieYear?: string;
    videoType?: VideoType;
    originalTitle?: string;//title in original language
    titles?: LanguageData<string>;// <ISO 639-3 lang codes, title>
}

export const VideoMetaFields = [
    "extra",
    "season",
    "episode",
    "increment",
    "movieYear",
    "videoType",
    "originalTitle",
    "titles",
];