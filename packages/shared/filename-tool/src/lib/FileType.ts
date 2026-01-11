import {FileTypeConfigurable} from "./tools/FileTypeConfigurable.js";
import {extensionMappings} from "./config/ExtentionsMapping.js";
import {mimeTypeMappings} from "./config/MimeTypeMapping.js";

export class FileType extends FileTypeConfigurable {

    constructor() {
        super(extensionMappings,mimeTypeMappings);
    }
}
