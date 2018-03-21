const codec = require('./codec');
const util = require('./util');

class Decoder {
    constructor() {
        this.protos = null;
        this.buffer = null;
        this.offset = 0;
    }

    /**
     * Get property head from protobuf
     */
    getHead() {
        let tag = codec.decodeUInt32(this.getBytes());

        return {
            type: tag & 0x7,
            tag: tag >> 3
        };
    }

    /**
     * Get tag head without move the offset
     */
    peekHead() {
        let tag = codec.decodeUInt32(this.peekBytes());

        return {
            type: tag & 0x7,
            tag: tag >> 3
        };
    }

    /**
     * Test if the given msg is finished
     */
    isFinish(msg, protos) {
        return (!protos.__tags[this.peekHead().tag]);
    }

    init(protos) {
        this.protos = protos || {};
    }

    setProtos(protos) {
        if (!!protos) {
            this.protos = protos;
        }
    }

    decode(route, buf) {
        let protos = this.protos[route];

        this.buffer = buf;
        this.offset = 0;

        if (!!protos) {
            return this.decodeMsg({}, protos, this.buffer.length);
        }

        return null;
    }

    decodeMsg(msg, protos, length) {
        while (this.offset < length) {
            let head = this.getHead();
            let tag = head.tag;
            let name = protos.__tags[tag];

            switch (protos[name].option) {
                case 'optional':
                case 'required':
                    msg[name] = this.decodeProp(protos[name].type, protos);
                    break;
                case 'repeated':
                    if (!msg[name]) {
                        msg[name] = [];
                    }
                    this.decodeArray(msg[name], protos[name].type, protos);
                    break;
            }
        }

        return msg;
    }

    decodeProp(type, protos) {
        let float;
        let double;
        let length;
        let str;
        let message;
        switch (type) {
            case 'uInt32':
                return codec.decodeUInt32(this.getBytes());
            case 'int32':
            case 'sInt32':
                return codec.decodeSInt32(this.getBytes());
            case 'float':
                float = this.buffer.readFloatLE(this.offset);
                this.offset += 4;
                return float;
            case 'double':
                double = this.buffer.readDoubleLE(this.offset);
                this.offset += 8;
                return double;
            case 'string':
                length = codec.decodeUInt32(this.getBytes());

                str = this.buffer.toString('utf8', this.offset, this.offset + length);
                this.offset += length;

                return str;
            default:
                message = protos && (protos.__messages[type] || Decoder.protos['message ' + type]);
                if (message) {
                    length = codec.decodeUInt32(this.getBytes());
                    let msg = {};
                    this.decodeMsg(msg, message, this.offset + length);
                    return msg;
                }
                break;
        }
    }

    decodeArray(array, type, protos) {
        if (util.isSimpleType(type)) {
            let length = codec.decodeUInt32(this.getBytes());

            for (let i = 0; i < length; i++) {
                array.push(this.decodeProp(type));
            }
        } else {
            array.push(this.decodeProp(type, protos));
        }
    }

    getBytes(flag) {
        let bytes = [];
        let pos = this.offset;
        flag = flag || false;

        let b;
        do {
            b = this.buffer.readUInt8(pos);
            bytes.push(b);
            pos++;
        } while (b >= 128);

        if (!flag) {
            this.offset = pos;
        }
        return bytes;
    }

    peekBytes() {
        return this.getBytes(true);
    }
}

module.exports = Decoder;
