/**
 * Convert the keywords string to an array manually for readability
 * Create regex from keyword, ensuring word boundaries, case insensitive ('i') and global ('g') to replace all occurrences
 * order matters longest first
 * Try not to put real word in order to avoid corrupting the title
 **/
export const keywordsArray = [
    'VF', 'aXXo', 'STFR', 'SUBFORCED', 'BrRipx264', 'YIFY', 'TRUEFRENCH', 'VFF', 'ATVP','RenewalEX','BD','DD','8bits', '8 bits' ,'10bits','10 bits', 'part 1','part 2', 'part 3', 'part 4', 'part A', 'part B', 'part C', 'part D',
    'AAC5', 'AAC5.1','1080i', '1080p', '2160p', '480i', '480p', '4k', '576i', '576p', '720',
    '720i', '720p', 'aac', 'aac4', 'ac3', 'amzn', 'apple tv+', 'avi', 'bbc',
    'bd5', 'bdrip', 'blu-ray', 'bluray', 'brrip', 'cam', 'cw', 'dc', 'dcu', 'ddp5.1', "director's cut", 'disney+',
    'divx', 'divx5', 'dl', 'dsr', 'dsrip', 'dts', 'dual audio', 'dubbed', 'dvd', 'dvdivx',
    'dvdr', 'dvdrip', 'dvdscr', 'dvdscreener', 'eng', 'eng sub',
    'esp', 'fan edit', 'fhd', 'flv', 'fs', 'ger', 'german', 'h.264', 'h.265', 'h264',
    'h265', 'hardcoded', 'hbo', 'hd', 'hddvd', 'hdr', 'hdrip', 'hdtv', 'hdtvrip',
    'hevc', 'hq', 'hrhd', 'hrhdtv', 'hulu', 'imax', 'ita', 'jpn', 'ld',
    'md', 'mkv', 'mp3', 'mp4', 'mpeg', 'mpg', 'mq', 'multi',
    'multisubs', 'netflix', 'nf', 'nfofix', 'ntsc', 'ogg', 'ogm', 'ova',
    'pal', 'pdtv', 'r3', 'r5', 'rerip', 'rsvcd', 'screener', 'sd', 'se',
    'subbed', 'svcd', 'tc', 'telecine','telesync', 'ts', 'tv series', 'uhd', 'uhdtv',
    'uhdv', 'v2', 'vcd', 'vostfr', 'web', 'web-dl', 'webcast',
    'webrip', 'wmv', 'ws', 'www', 'x264', 'x265', 'xsvcd', 'xvid', 'xvidvd',
    'xxx','bits','AnimeServ'
];

/**
 * Same as keywordsArray but for substring (aka no word boundary)
 * Needs to be filled with extra care to avoid corrupting the title
 */
export const substringArray = [
    'v1','v2', 'v3', 'v4', 'v5'
];

export const extraEpKeyWords = [
    'Extras','OVA','OAV','SP','NCOP','NCED','OP','ED','PV','CM','NC','NCOPED','NCOP'
]

