/**
 * key is language ISO 639-3 code
 * https://en.wikipedia.org/wiki/List_of_ISO_639-3_codes
 */
export type LanguageData<T> = Record<string, T>;
export type ISO639_1_CODE = string;

/**
 * jpn, jpr and jpa already exist. Creating jpl is for japan-latin. Used for japanese romaji NON ISO 639-3 standard.
 * */
export const romajiIsoCode = "jpl";
export const englishIsoCode = "eng";