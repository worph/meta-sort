// Definition of the patterns used to match season and episode numbers in file names (order matters longest first).
const ep4 = "((?:\\d{1,4})(?:\\.5)?)" // Matches "1" up to "9999" and "1.5" up to "9999.5"
const ep2 = "((?:\\d{1,2})(?:\\.5)?)" // Matches "1" up to "99" and "1.5" up to "99.5"
const ep3 = "((?:\\d{1,3})(?:\\.5)?)" // Matches "1" up to "999" and "1.5" up to "999.5"
const sea = "((?:\\d{1,2})(?:\\.5)?)" // Matches "1" up to "99"
const ep4mY = "((?:\\d{1,3}|1[0-7]\\d{2}|1800)(?:\\.5)?)" // Matches "1" up to "1800"
const sw = "(?:\\.|\\b)" // a dot or word boundary
const end = "(?:(?:\\.|\\b).*)" // any character after a season pattern is matched to be removed
const s = "(?:\\.|\\b|\\s)"

export const soloEp = `${sw}${ep3}${sw}` // Matches "1" up to "9999" and "1.5" up to "9999.5"

//mind the parenthesis
export const seasonAndEpisodePatterns = [
    `${sw}Season${s}*${sea}${s}*Episode${s}*${ep4}${end}`, // Verbose "Season 1 Episode 02" and "Season 1 Episode 02.5" format
    `${sw}Saison${s}*${sea}${s}*Episode${s}*${ep4}${end}`, // French "Saison 1 Episode 02" and "Saison 1 Episode 02.5" format
    `${sw}\\[${sea}${s}*x${s}*${ep4}\\]${end}`, // Matches concise "[1x02]" and "[1x02.5]" format
    `${sw}\\(${sea}${s}*x${s}*${ep4}\\)${end}`, // Matches concise "(1x02)" and "(1x02.5)" format
    `${sw}${sea}${s}*x${s}*${ep4}${end}`, // Matches concise "1x02" and "1x02.5" format
    `${sw}S${sea}${s}*x${s}*${ep4}${end}`, // Matches "S1x02" and "S1x02.5" format
    `${sw}S${sea}${s}*E${ep4}${end}`, // Strict "S01E03" and "S01E03.5" format
    `${sw}${sea}${s}*E${ep4}${end}`, // Matches "03E04" and "03E04.5" format
    `${sw}S${s}*${sea}${s}*E${s}*${ep2}${end}`, // Spaced "S 3 E 06" and "S 3 E 06.5" format
    `${sw}S${s}*${sea}${s}+${ep2}${end}`, // Compact "S 03 04" and "S 03 04.5" spacing variant
    `${sw}S${sea}${s}*-${s}*${ep2}${end}`, // Hyphen-separated "S2 - 07" and "S2 - 07.5" format
    `${sw}${sea}${s}*-${s}*${ep2}${end}`, // General "2 - 07" and "2 - 07.5" hyphen-separated format
];



// Episode only patterns E01 etc...
export const episodePatterns = [
    //`${sw}${ep3}${end}`, // Allows "04" or "4.5" - Akiba General Election //NOTE too generic to be managed at this level
    `${sw}Episode${s}*${ep4}${end}`, // Matches "Episode 1" up to "Episode 9999" and "Episode 1.5"
    `${sw}Epizoda${s}*${ep4}${end}`, // Matches "Episode 1" up to "Episode 9999" and "Episode 1.5"
    `${sw}E${s}*${ep4mY}${end}`, // Matches " E 1" up to " E 1800" and " E 1.5"
    `${sw}Ep${ep4mY}${end}`, // Matches "Ep1" up to "Ep1800" and "Ep1.5"
];


//Season only paterns S01 etc...
export const seasonPatterns: string[] = [
    `${sw}Season${s}*${sea}${end}`, // Matches "Season 1" (eng) up to "Season 99"
    `${sw}Saison${s}*${sea}${end}`, // Matches "Saison 1" (fra) up to "Saison 99"
    `${sw}S${s}*${sea}${end}`, // Matches "S 1" up to "S 99"
    `${sw}${sea}${end}`, // Matches "1" up to "99"
];
