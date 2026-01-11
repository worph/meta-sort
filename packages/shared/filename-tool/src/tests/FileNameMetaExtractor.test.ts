import {expect} from "chai";
import {FileNameMetaExtractor} from "../lib/FileNameMetaExtractor.js";
describe('FileNameMetaExtractor', () => {
    it('getParent', async () => {
        const list= [
            '/public/static_library/Media/Anime/',
            '/public/static_library/Media/Movies/',
            '/public/static_library/Media/Series/',
            '/public/bitTorrent/media/'];
        let fileNameMetaExtractor = new FileNameMetaExtractor(list);
        let folder = fileNameMetaExtractor.fileNameVideoMetaExtractor.getParentFolder("/public/static_library/Media/Anime/Series/AAAAAA/abcd.mkv",1);
        expect(folder).to.equal("AAAAAA");

    });
});