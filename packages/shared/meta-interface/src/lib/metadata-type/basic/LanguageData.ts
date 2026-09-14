/**
 * key is a `lang3` code: ISO 639-2/**B** — `eng`, `jpn`, `fre`/`ger`/`chi`,
 * NOT the 639-2/T (= 639-3) spellings `fra`/`deu`/`zho`.
 *
 * This is the vocabulary the stack compares against: `languages:` query filters
 * match it literally, and `meta_feeder_sdk::lang::normalize_lang_code` folds
 * incoming codes onto it. See METADATA_KEYS.md §"Value formats" and §14.3 —
 * the card tier (`titles/*`, `posters/*`) is still on /T and has not converged.
 * https://en.wikipedia.org/wiki/List_of_ISO_639-2_codes
 */
export type LanguageData<T> = Record<string, T>;
export type LANG3_CODE = string;

/**
 * @deprecated Misnamed: no writer has ever emitted 2-letter ISO 639-1 codes
 * here. Use {@link LANG3_CODE}. Kept as an alias so existing imports compile.
 */
export type ISO639_1_CODE = LANG3_CODE;

/**
 * jpn, jpr and jpa already exist. Creating jpl is for japan-latin. Used for japanese romaji NON ISO 639-3 standard.
 * */
export const romajiIsoCode = "jpl";
export const englishIsoCode = "eng";