import {describe, beforeEach, it} from 'mocha';
import {expect} from 'chai';
import {from, MetadataNode} from './MetaDataAPI.js';
import {VideoMeta} from "./metadata-type/VideoMeta";
import {GenreMeta} from "./metadata-type/GenreMeta";

type TypedMetaData = VideoMeta & GenreMeta;

describe('MetaData', () => {
    let root: MetadataNode<TypedMetaData>;
    let meta = {};

    beforeEach(() => {
        // Reset meta for each test to ensure no test pollution
        meta = {};
        root = from<TypedMetaData>(meta);
    });

    it('should set and get a simple key-value pair', () => {
        root.at('originalTitle').set("Star Wars");
        expect(root.at('originalTitle').get()).to.equal("Star Wars");
    });

    it('should set and get nested metadata using nested keys', () => {
        root.at('titles').at('eng').set("Star Wars");
        root.at('titles').at('jpn').set("Staru Warsu");
        expect(root.at('titles').at('eng').get()).to.equal("Star Wars");
        expect(root.at('titles').at('jpn').get()).to.equal("Staru Warsu");
        expect(root.at('titles').get()).to.deep.equal({eng: "Star Wars", jpn: "Staru Warsu"});
        expect(root.get()).to.deep.equal({
            titles: {eng: "Star Wars", jpn: "Staru Warsu"}
        });
    });

    it('should return undefined for non-existent keys', () => {
        expect(root.at<any>('nonexistent').at<any>('nonexistent2').get()).to.equal(undefined);
    });

    it('should handle overriding existing keys with new values', () => {
        root.at('genres').add("Sci-fi");
        expect(root.at('genres').getKeysAsSet()).to.deep.equal(new Set(["Sci-fi"]));
        // Override the value
        root.at('genres').add("Adventure");
        expect(root.at('genres').getKeysAsSet()).to.deep.equal(new Set(['Sci-fi', 'Adventure']));
        root.at('genres').add("Sci-fi");
        expect(root.at('genres').getKeysAsSet()).to.deep.equal(new Set(['Sci-fi', 'Adventure']));
        //root.at('genres').remove('Sci-fi');
        //expect(root.at('genres').getKeys()).to.deep.equal(new Set(['Adventure']));
    });
});
