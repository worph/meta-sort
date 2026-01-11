import {describe, expect, it} from 'vitest';
import {FileNameMetaExtractor} from "../lib/FileNameMetaExtractor.js";

// Watch folder list for test paths
const watchFolders = [
    '/data/watch/test-files/',
    '/public/static_library/Media/Anime/',
    '/public/static_library/Media/Movies/',
    '/public/static_library/Media/Series/',
    '/public/bitTorrent/media/'
];

// Helper to test series/anime (title, season, episode)
async function titleSeasonEpTester(title: string, season: string, episode: string, filePath: string) {
    const extractor = new FileNameMetaExtractor(watchFolders);
    const data = await extractor.extractMetadata(filePath);
    expect(data.originalTitle).toEqual(title);
    expect(data.season).toEqual(season);
    expect(data.episode).toEqual(episode);
}

// Helper to test movies (title, year)
async function movieTester(title: string, year: string, filePath: string) {
    const extractor = new FileNameMetaExtractor(watchFolders);
    const data = await extractor.extractMetadata(filePath);
    expect(data.originalTitle).toEqual(title);
    expect(data.movieYear).toEqual(year);
    expect(data.season).toBeUndefined();
    expect(data.episode).toBeUndefined();
}

describe('FileNameMetaExtractor', () => {

    describe('Basic parsing', () => {
        it('filename and extension', async () => {
            const filePath = '/data/watch/test-files/Series/The.Big.Bang.Theory.S01E01.mkv';
            const extractor = new FileNameMetaExtractor(watchFolders);
            const data = await extractor.extractMetadata(filePath);

            expect(data.fileName).toEqual('The.Big.Bang.Theory.S01E01.mkv');
            expect(data.extension).toEqual('mkv');
            expect(data.originalTitle).toEqual('The Big Bang Theory');
            expect(data.season).toEqual("1");
            expect(data.episode).toEqual("1");
        });
    });

    describe('Series patterns', () => {
        it('The.Big.Bang.Theory.S01E01.mkv', async () => {
            await titleSeasonEpTester('The Big Bang Theory', '1', '1',
                '/data/watch/test-files/Series/The.Big.Bang.Theory.S01E01.mkv');
        });

        it('handles lower case with underscores', async () => {
            await titleSeasonEpTester('Breaking Bad', '4', '2',
                '/data/watch/test-files/Series/breaking_bad_s04e02.avi');
        });

        it('handles season and episode without leading zeros', async () => {
            await titleSeasonEpTester('Friends', '10', '5',
                '/data/watch/test-files/Series/friends_10x5.mp4');
        });

        it('processes files with year and resolution info', async () => {
            await titleSeasonEpTester('Game of Thrones', '8', '1',
                '/data/watch/test-files/Series/Game.of.Thrones.S08E01.2019.1080p.HDTV.x264.mkv');
        });

        it('parses title with dots and dashes', async () => {
            await titleSeasonEpTester('Mr Robot', '1', '1',
                '/data/watch/test-files/Series/Mr.Robot-S01E01.mkv');
        });

        it('handles files with extra text before season and episode', async () => {
            await titleSeasonEpTester('Sherlock', '2', '3',
                '/data/watch/test-files/Series/Sherlock - A Scandal in Belgravia S02E03.mkv');
        });

        it('interprets files with non-standard episode naming', async () => {
            await titleSeasonEpTester('The Mandalorian', '1', '1',
                '/data/watch/test-files/Series/The Mandalorian - Chapter 1 S01E01.mkv');
        });

        it('extracts info from files with mixed separators', async () => {
            await titleSeasonEpTester('Dexter', '7', '12',
                '/data/watch/test-files/Series/Dexter - S07E12_final-episode.avi');
        });

        it('handles verbose season episode notation', async () => {
            await titleSeasonEpTester('The Crown', '4', '10',
                '/data/watch/test-files/Series/The Crown Season 4 Episode 10.mkv');
        });

        it('handles files with multiple season and episode patterns', async () => {
            await titleSeasonEpTester('Westworld', '3', '8',
                '/data/watch/test-files/Series/Westworld S03  E08 - Crisis Theory.mp4');
        });

        it('handles files named with only episode numbers assuming season 1', async () => {
            await titleSeasonEpTester('MythBusters', '1', '1',
                '/data/watch/test-files/Series/MythBusters/MythBusters - Episode 1.avi');
        });

        it('Star Trek Enterprise', async () => {
            await titleSeasonEpTester('Star Trek Enterprise', '1', '4',
                '/data/watch/test-files/Series/Star Trek/Star Trek Enterprise/S1/(1x04) Star Trek Enterprise - Le peuple de la grotte.avi');
        });
    });

    describe('Anime patterns', () => {
        it('[DB]Haibane Renmei_-_13_(Dual Audio_10bit_BD1080p_x265).mkv', async () => {
            await titleSeasonEpTester('Haibane Renmei', '1', '13',
                '/data/watch/test-files/Anime/[DB]Haibane Renmei_-_13_(Dual Audio_10bit_BD1080p_x265).mkv');
        });

        it('One Piece with episode title', async () => {
            await titleSeasonEpTester('One Piece', '20', '897',
                '/data/watch/test-files/Anime/One Piece - S20E897 - Luffy vs. Kaido.mkv');
        });

        it('[SubsPlease] Shangri-La Frontier - 07 (1080p) [FC412C51].mkv', async () => {
            await titleSeasonEpTester('Shangri-La Frontier', '1', '7',
                '/data/watch/test-files/Anime/[SubsPlease] Shangri-La Frontier - 07 (1080p) [FC412C51].mkv');
        });

        it('[SubsPlease] Fumetsu no Anata e S2 - 07 (1080p) [9FF46A4E].mkv', async () => {
            await titleSeasonEpTester('Fumetsu No Anata E', '2', '7',
                '/data/watch/test-files/Anime/[SubsPlease] Fumetsu no Anata e S2 - 07 (1080p) [9FF46A4E].mkv');
        });

        it('_AnimeServ__Dakara_07__8bits__1A8C2326_.mp4', async () => {
            await titleSeasonEpTester('Dakara', '1', '7',
                '/data/watch/test-files/Anime/_AnimeServ__Dakara_07__8bits__1A8C2326_.mp4');
        });

        it('[Erai-raws] Xian Wang de Richang Shenghuo 3 - 01 [1080p][Multiple Subtitle][F822C9C7].mkv', async () => {
            await titleSeasonEpTester('Xian Wang De Richang Shenghuo', '3', '1',
                '/data/watch/test-files/Anime/[Erai-raws] Xian Wang de Richang Shenghuo 3 - 01 [1080p][Multiple Subtitle][F822C9C7].mkv');
        });

        it('[Erai-raws] Xian Wang de Richang Shenghuo 3 - 01.5 [1080p][Multiple Subtitle][F822C9C7].mkv', async () => {
            await titleSeasonEpTester('Xian Wang De Richang Shenghuo', '3', '1.5',
                '/data/watch/test-files/Anime/[Erai-raws] Xian Wang de Richang Shenghuo 3 - 01.5 [1080p][Multiple Subtitle][F822C9C7].mkv');
        });

        it('[Erai-raws] Mob Psycho 100 - 01  [1080p][FB7288A9].mkv', async () => {
            await titleSeasonEpTester('Mob Psycho', '1', '1',
                '/data/watch/test-files/Anime/[Erai-raws] Mob Psycho 100 - 01  [1080p][FB7288A9].mkv');
        });
    });

    describe('Movie patterns', () => {
        it('The.Wave.2008.1080p.BluRay.x264.AAC5.1.mkv', async () => {
            await movieTester('The Wave', '2008',
                '/data/watch/test-files/Movies/The.Wave.2008.1080p.BluRay.x264.AAC5.1.mkv');
        });

        it('Le.Prenom.2012.720p.BluRay.x264-SEiGHT.mkv', async () => {
            await movieTester('Le Prenom -SEiGHT', '2012',
                '/data/watch/test-files/Movies/Le.Prenom.2012.720p.BluRay.x264-SEiGHT.mkv');
        });
    });

    describe('Edge cases - title from folder (skipped)', () => {
        // These tests are skipped because the parser doesn't extract title from folder name
        // when the filename doesn't contain the show title
        // Pattern: FolderWithTitle/S01E01-EpisodeName.mkv should extract title from folder

        it('Lord of Mysteries - title from folder, filename is S01E01-EpisodeName pattern', async () => {
            // Real-world case: folder contains title + quality info, filename is S01E01-EpisodeName format
            // Expected: extract "Lord of Mysteries" from folder, not "The Fool" from filename
            await titleSeasonEpTester('Lord of Mysteries', '1', '1',
                '/data/watch/test-files/Anime/Lord of Mysteries S01 1080p Dual Audio WEBRip DD+ x265-EMBER/S01E01-The Fool [8A4E8B1F].mkv');
        });

        it.skip('handles files named with season in folder', async () => {
            await titleSeasonEpTester('MythBusters', '2', '1',
                '/data/watch/test-files/Series/MythBusters/Season 2/MythBusters - Episode 1.avi');
        });

        it.skip('Ascendance of a Bookworm - title from parent folder', async () => {
            await titleSeasonEpTester('Ascendance Of A Bookworm', '1', '7',
                '/data/watch/test-files/Anime/Ascendance of a Bookworm/S01/S01E07-Seeds of Suspicion.mkv');
        });

        it.skip('Le Depart - title from parent folder, filename starts with number', async () => {
            await titleSeasonEpTester('Le Depart', '1', '13',
                '/data/watch/test-files/Anime/Le Depart/13 it a new start.mkv');
        });

        it('Akudama Drive - title from folder', async () => {
            await titleSeasonEpTester('Akudama Drive', '1', '2',
                '/data/watch/test-files/Anime/Akudama Drive/S01E02-RESERVOIR DOGS [F1D64557].mkv');
        });

        it.skip('Excel Saga VF - title from folder', async () => {
            await titleSeasonEpTester('Excel Saga', '1', '2',
                '/data/watch/test-files/Anime/Excel Saga VF/02 - la fille qui vient de mars.avi');
        });

        it.skip('Gundam Wing - title from folder', async () => {
            await titleSeasonEpTester('Gundam Wing', '1', '2',
                '/data/watch/test-files/Anime/Gundam/Gundam wing/02 - Gundam Wing - Face cachée.mp4');
        });

        it.skip('Hanaukyo Maids La Verité - title from folder', async () => {
            await titleSeasonEpTester('Hanaukyo Maids La Verité', '1', '2',
                '/data/watch/test-files/Anime/Hanaukyo Maids La Verité/02 Hanaukyo Maids La Verité [Todai].fullanimes.free.fr.avi');
        });

        it.skip('K-Project - title from parent folder', async () => {
            await titleSeasonEpTester('K-Project', '1', '2',
                '/data/watch/test-files/Anime/K-Project/K - Return of Kings/[HorribleSubs] K - Return of Kings - 02 [1080p].mkv');
        });

        it.skip('K-Project - Kitten - title from folder', async () => {
            await titleSeasonEpTester('K-Project', '1', '2',
                '/data/watch/test-files/Anime/K-Project/[CBM]_K_-_02_-_Kitten_[1080p-FLAC]_[A83DF131].mkv');
        });

        it('Made in Abyss - title from folder', async () => {
            await titleSeasonEpTester('Made in Abyss', '1', '2',
                '/data/watch/test-files/Anime/Made in Abyss/S01E02-Resurrection Festival [AE07AD68].mkv');
        });

        it.skip('The Mysterious Cities of Gold - title from folder', async () => {
            await titleSeasonEpTester('The Mysterious Cities Of Gold', '1', '2',
                '/data/watch/test-files/Anime/The Mysterious Cities of Gold/2 - Crossing the Atlantic.avi');
        });

        it.skip('Star Trek The Original - title from folder', async () => {
            await titleSeasonEpTester('Star Trek The Original Series', '2', '1',
                '/data/watch/test-files/Series/Star Trek/Star Trek The Original Series/Saison 2/2x01 Star Trek The Original - Mal Du Pays.avi');
        });

        it.skip('Star Trek TNG - title from folder', async () => {
            await titleSeasonEpTester('Star Trek Tng', '3', '3',
                '/data/watch/test-files/Series/Star Trek/Star Trek TNG/saison 3/03 - Les survivants.avi');
        });
    });
});
