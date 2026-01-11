import {StringBoolean} from "./basic/StringBoolean.js";
import {ArrayKey} from "./basic/ArrayKey";

export interface VideoStream {
    width?: string;
    height?: string;
    bitrate?: string;
    frameRate?: string;
    rotation?: string;
    language?: string;
}

export interface SubtitleStream {
    language?: string;
    title?: string;
}

export interface AudioStream {
    sampleRate?: string;
    bitrate?: string;
    language?: string;
    channelLayout?: string;
}

export interface CommonStream {
    index?: string;
    duration?: string;
    codecType?: string;
    codec?: string;
    language?: string;
    title?: string;
    default?: StringBoolean;
    forced?: StringBoolean;
}

export type Stream = VideoStream & SubtitleStream & AudioStream & CommonStream;

/**
 * StreamList is a list of streams
 * key is stream index in string "0","1","2" etc
 */
export type StreamList = Record<ArrayKey,Stream>;

export interface MediaStreamMeta {
    fileinfo?: {
        duration?: string;
        formatName?: string;
        streamdetails?: {
            video: StreamList;
            audio: StreamList;
            subtitle: StreamList;
            embeddedimage: StreamList;
        }
    }
}

export const MediaStreamMetaFields = [
    "fileinfo",
];