import {TypedRecordSet} from "./basic/RecordSet.js";
import {ISO639_1_CODE} from "./basic/LanguageData.js";

export interface LanguagesMeta{
    languages?: TypedRecordSet<ISO639_1_CODE>;
}

export const LanguagesMetaFields = [
    "languages",
];