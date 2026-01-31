import {readFile, writeFile} from 'fs/promises';
import {Builder, Parser} from 'xml2js';
import {mergeMetadata} from "../logic/tool/MetadataMerger.js";
import {existsAsync} from "@metazla/meta-hash";
import {VideoMeta, JellyfinMeta, FileStatMeta} from "@metazla/meta-interface";
import lodash from 'lodash';
import * as xml2js from "xml2js";

export class JellyfinNfo {

    options = {explicitArray: true, ignoreAttrs: true};

    /**
     * Convert a JSON XML object back to a regular JSON object where arrays containing `set` are converted back to Set objects
     * @param input - The input JSON XML object
     */
    private convertFromJsonXml(input: any): any {
        const output: any = {};

        for (const [key, value] of Object.entries(input)) {
            if (!Array.isArray(value) || value.length === 0) {
                throw new Error("Unexpected format: each property should be an array.");
            }

            const firstElement = value[0];

            if (firstElement && typeof firstElement === 'object') {
                if ('set' in firstElement) {
                    // Convert array from 'set' back to Set object
                    output[key] = new Set(firstElement.set);
                } else {
                    // Recursively convert from JsonXml for nested objects
                    output[key] = this.convertFromJsonXml(firstElement);
                }
            } else {
                // Primitive value, simply assign it as it is the only element in the array
                output[key] = firstElement;
            }
        }

        return output;
    }

    /**
     * Filter only known jellyfin supported data
     * @param data
     */
    filterData(data: any): any {
        const supportedFields = ["originalTitle", "season", "episode", "videoType", "fileType"]
        const result = {};
        for (const key of supportedFields) {
            if (data[key]) {
                result[key] = data[key];
            }
        }
        return result;
    }

    async read<T>(nfoPath: string): Promise<T> {
        if (!nfoPath.endsWith('.nfo')) {
            throw new Error(`NFO file path must end with '.nfo'`);
        }
        let metadata: T = {} as T;
        if (await existsAsync(nfoPath)) {
            try {
                const nfoContent = await readFile(nfoPath, {encoding: 'utf8'});
                const parser = new xml2js.Parser(this.options);
                const result = await parser.parseStringPromise(nfoContent);
                metadata = result.root || result.episodedetails || result.movie || {};
                metadata = this.convertFromJsonXml(metadata);
            } catch (error) {
                console.error(`Error parsing NFO file ${nfoPath}`);
            }
        }

        // we always read the file for meta data but ignore its content except for cid which are long to compute
        return metadata;
    }

    async update<T extends FileStatMeta>(nfoPath: string, data: T): Promise<void> {
        data = this.filterData(data);
        if (!nfoPath.endsWith('.nfo')) {
            throw new Error(`NFO file path must end with '.nfo'`);
        }
        if (data.fileType !== "video") {
            return;//only process video files for writing jellyfin nfo
        }
        if (await existsAsync(nfoPath)) {
            await this.updateNfoFile(nfoPath, data as any);
        } else {
            throw new Error(`NFO file does not exist at path: ${nfoPath}`);
        }
    }

    public async createOrUpdate<T extends FileStatMeta>(nfoPath: string, data: T): Promise<void> {
        data = this.filterData(data);
        if (!nfoPath.endsWith('.nfo')) {
            throw new Error(`NFO file path must end with '.nfo'`);
        }
        if (data.fileType !== "video") {
            return;//only process video files for writing jellyfin nfo
        }
        if (await existsAsync(nfoPath)) {
            await this.updateNfoFile(nfoPath, data as any);
        } else {
            // If the NFO file doesn't exist, just generate a new one
            await this.generateNfoFile(nfoPath, data as any);
        }
    }

    /**
     * Convert a regular JSON object to an XML JSON object (add arrays)
     * @param input
     */
    private convertToJsonXml(input: any): any {
        const output: any = {};

        // Use Object.entries to loop through each key-value pair in the input object
        for (const [key, value] of Object.entries(input)) {
            if (!this.assertLegalName(key)) {
                throw new Error(`Illegal character in key: ${key}`);
            }
            if (value instanceof Set) {
                // If the value is a Set, convert it to an array and then to XmlJson format
                const array = Array.from(value as any);
                if (array.length > 0) {
                    output[key] = [{set: array}];
                }
            } else if (value instanceof Array) {
                throw new Error("unsupported");
            } else if (typeof value === 'object' && value !== null) {
                // For nested objects, recursively convert
                let jsonXml = this.convertToJsonXml(value);
                if (jsonXml instanceof Array) {
                    output[key] = jsonXml;
                } else {
                    output[key] = [jsonXml];
                }
            } else {
                output[key] = [value];
            }
        }

        return output;
    }

    private async updateNfoFile(nfoFilePath: string, data: JellyfinMeta) {
        try {
            const existingContent = await readFile(nfoFilePath, {encoding: "utf-8"});
            const parser = new Parser(this.options);
            let existingData = await parser.parseStringPromise(existingContent);
            let hasChanged = false;

            // 1st try to update the type of the metadata (root can be "root" or "movie" or "episodedetails") and
            // according to the 'jelly' parameter and the isMovieOrTvShow function
            const targetRoot = (this.isMovieOrTvShow(data) === "tvshow" ? 'episodedetails' : "movie");
            if (existingData.root) {
                existingData[targetRoot] = existingData.root;
                delete existingData.root;
                hasChanged = true;
            } else if (existingData.movie && "movie" !== targetRoot) {
                existingData[targetRoot] = existingData.movie;
                delete existingData.movie;
                hasChanged = true;
            } else if (existingData.episodedetails && "episodedetails" !== targetRoot) {
                existingData[targetRoot] = existingData.episodedetails;
                delete existingData.episodedetails;
                hasChanged = true;
            }

            //2nd update the data
            let root = existingData[targetRoot];
            if (typeof root !== 'object') {
                root = {};//don't allow primitive type in root
                hasChanged = true;
            }
            const convertedData = this.convertToJsonXml(data);
            hasChanged = mergeMetadata(root, convertedData, nfoFilePath) || hasChanged;
            root = this.sanitizeData(root);
            existingData[targetRoot] = root;

            if (hasChanged) {
                const builder = new Builder();
                // Convert the updated object back to XML
                try {
                    const updatedContent = builder.buildObject(existingData);
                    await writeFile(nfoFilePath, updatedContent, {encoding: "utf-8"});
                } catch (error) {
                    console.error(`Failed to write updated NFO content to ${nfoFilePath} : ${error}`);
                }
            }
        } catch (error) {
            console.error(`Failed to parse existing NFO content ${nfoFilePath} : ${error}`);
            return;
        }
    }

    private isMovieOrTvShow(data: VideoMeta): "tvshow" | "movie" {
        if (data.videoType) {
            return data.videoType;
        } else if (data.episode) {
            return "tvshow";
        } else {
            return "movie";
        }
    }

    private assertLegalChar(str): boolean {
        return str.match(/[\0\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/);
    };

    private assertLegalName(str: string) {
        if (this.assertLegalChar(str)) {
            return false;
        }
        const regex = /^([:A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]|[\uD800-\uDB7F][\uDC00-\uDFFF])([\x2D\.0-:A-Z_a-z\xB7\xC0-\xD6\xD8-\xF6\xF8-\u037D\u037F-\u1FFF\u200C\u200D\u203F\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]|[\uD800-\uDB7F][\uDC00-\uDFFF])*$/;
        if (!str.match(regex)) {
            return false;
        }
        return true;
    };

    private sanitizeData(data: any): any {
        const sanitize = (value: any): any => {
            if (typeof value === 'string') {
                // Escaping the string values
                return lodash.escape(value);
            } else if (Array.isArray(value)) {
                throw new Error(`Arrays are not supported in NFO files`);
            } else if (typeof value === 'object' && value !== null) {
                // Recursively sanitize each property in the object
                let result = {};
                for (const key of Object.keys(value)) {
                    if (this.assertLegalName(key)) {
                        result[key] = value[key];
                    }
                }
                return result;
            }
            return value;
        };

        return sanitize(data);
    }

    private async generateNfoFile(nfoFilePath: string, data: JellyfinMeta) {
        if (!nfoFilePath.endsWith('.nfo')) {
            throw new Error(`NFO file path must end with '.nfo'`);
        }
        if (await existsAsync(nfoFilePath)) {
            throw new Error(`NFO file already exists at path: ${nfoFilePath}`);
        }

        const rootElementName = data.videoType === "tvshow" ? 'episodedetails' : "movie";
        /*const schemaAttributes = jelly ? {} : {
            'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
            'xsi:schemaLocation': 'http://www.example.com/schema http://www.example.com/schema/mediaFileSchema.xsd'
        };*/
        const schemaAttributes = {};

        const convertedData = this.convertToJsonXml(data);
        const sanitizedData = this.sanitizeData(convertedData);

        // Prepare the data object with the correct root element and attributes
        const obj = {
            [rootElementName]: {
                ...({$: schemaAttributes}),
                ...sanitizedData
            }
        };

        const builder = new Builder({xmldec: {version: '1.0', encoding: 'UTF-8', standalone: true}});
        const nfoContent = builder.buildObject(obj);
        await writeFile(nfoFilePath, nfoContent, {encoding: "utf-8"});
    }

}
