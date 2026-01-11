import crc32 from "crc-32";
import {SimpleHash} from "@root/file-id/SimpleHash";

export class Crc32Hash implements SimpleHash {
    private _crc: number = undefined;

    update(data: Buffer): SimpleHash {
        // Update the CRC-32 checksum with the new chunk of data
        this._crc = crc32.buf(data, this._crc);
        return this;
    }

    digest(): Buffer {
        const buffer = Buffer.alloc(4); // Create a buffer of 4 bytes (32 bits)
        buffer.writeInt32BE(this._crc, 0); // Write the unsigned integer to the buffer in big-endian format
        return buffer;
    }
}