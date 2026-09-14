import {TypedRecordSet} from "./basic/RecordSet.js";
import {LANG3_CODE} from "./basic/LanguageData.js";

/**
 * The language triad (METADATA_KEYS.md §9).
 *
 * `languages` is the **union** — every language the record offers by any route
 * — and the only one a query filters on. The two splits refine it and are
 * optional. Rule #7: a writer that adds a member to a split MUST add the same
 * member to the union in the same write; nothing reconciles them afterwards.
 */
export interface LanguagesMeta{
    /** The union: audio ∪ subtitles ∪ bare language statements. Filterable. */
    languages?: TypedRecordSet<LANG3_CODE>;
    /** Spoken/audio-track languages only. Refinement, never filtered on. */
    audioLanguages?: TypedRecordSet<LANG3_CODE>;
    /** Subtitle languages only (§8). Refinement, never filtered on. */
    subtitleLanguages?: TypedRecordSet<LANG3_CODE>;
}

export const LanguagesMetaFields = [
    "languages",
    "audioLanguages",
    "subtitleLanguages",
];