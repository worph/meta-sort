import ISO6391 from 'iso-639-1';
import {iso6393To2T} from "iso-639-3";

/**
 * iso6393To1
 * Map of ISO 639-3 codes to ISO 639-1 codes (Record<string, string>).
 *
 * iso6393To2B
 * Map of ISO 639-3 codes to bibliographic ISO 639-2 codes (Record<string, string>).
 *
 * iso6393To2T
 * Map of ISO 639-3 codes to terminologic ISO 639-2 codes (Record<string, string>).
 */

//reverse of iso6393To1
const iso6391To3: Record<string, string> = {};//ISO 639-1 to ISO 639-3
for (const key in iso6393To2T) {
    const value = iso6393To2T[key];
    iso6391To3[value] = key;
}

export function anyTo_iso_639_3(languageName: string) : string | null {
    if (!languageName) {
        return null;
    }
    if (languageName.length === 3) {
        //could be iso 639-3 or iso 639-2T or iso 639-2B
        //all 3 are pretty similar just return the input
        return languageName;
    }
    if (languageName.length === 2) {
        //could be iso 639-1 => validate and convert
        return iso6391To3[languageName] || "und";
    }

    // full language name convert to iso 639-3
    const code1 = ISO6391.getCode(languageName);
    if(iso6391To3[code1]){
        return iso6391To3[code1];
    }

    return null; //undefined
}
