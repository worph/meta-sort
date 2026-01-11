import {LanguageData} from "./basic/LanguageData.js";
import {TypedRecordSet} from "./basic/RecordSet.js";
import {FileRef} from "./basic/FileRef.js";

//used by video files to store the subtitle files
export interface SubtitleMeta {
    subtitles?:LanguageData<TypedRecordSet<FileRef>>;//key is the language code, value is a set of ipfs hash of the subtitle file
}

//used by subtitle files to store the video files
export interface SubtitleFileMeta {
    videos?:TypedRecordSet<FileRef>;//a set of ipfs hash of the video file
    subtitleLanguage?:string;//the language of the subtitle file
}

export const SubtitleMetaFields = [
    "subtitles",
];

export const SubtitleFileMetaFields = [
    "videos",
    "subtitleLanguage",
];