import {LanguageData} from "./basic/LanguageData.js";
import {VideoType} from "./basic/VideoType";

export interface VideoMeta {
    extra?: string;
    season?: string;
    episode?: string;
    increment?: string;
    movieYear?: string;
    videoType?: VideoType;
    title?: string;//display title (localized); the one name to show
    originalTitle?: string;//title in original language
    titles?: LanguageData<Record<string, true>>;// key-set: <ISO 639-3 lang code, {name: true}> — every clean name incl. AKAs (METADATA_KEYS.md §3)
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