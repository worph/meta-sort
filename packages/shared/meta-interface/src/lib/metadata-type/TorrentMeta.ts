import {RecordSet} from "./basic/RecordSet.js";

export interface TorrentMeta {
    announce?: string;
    announceList?: RecordSet;
    comment?: string;
    createdBy?: string;
    creationDate?: number;
    info: {
        files: Record<string, {
            length: number;
            path: string;
        }>;// key is the "0" "1" "2" etc
        name: string;
    };
}

export const TorrentMetaFields = [
    "announce",
    "announceList",
    "comment",
    "createdBy",
    "creationDate",
    "info",
];