export function encodeVarint(value: number): Buffer {
    const buf: number[] = [];
    let v = value;
    while (v >= 0x80) {
        buf.push((v & 0x7F) | 0x80);
        v >>= 7;
    }
    buf.push(v);
    return Buffer.from(buf);
}

export function readVarint(data: Buffer, offset: number): [number, number] {
    let result = 0;
    let shift = 0;
    let pos = offset;

    while (true) {
        if (pos >= data.length) {
            throw new Error("Data incomplete");
        }
        const byte = data[pos];
        result |= (byte & 0x7F) << shift;
        pos += 1;
        if ((byte & 0x80) === 0) {
            break;
        }
        shift += 7;
    }

    return [result, pos];
}

export function skipField(data: Buffer, offset: number, wireType: number): number {
    if (wireType === 0) { // Varint
        const [, newOffset] = readVarint(data, offset);
        return newOffset;
    } else if (wireType === 1) { // 64-bit
        return offset + 8;
    } else if (wireType === 2) { // Length-delimited
        const [length, contentOffset] = readVarint(data, offset);
        return contentOffset + length;
    } else if (wireType === 5) { // 32-bit
        return offset + 4;
    } else {
        throw new Error(`Unknown wireType: ${wireType}`);
    }
}

export function removeField(data: Buffer, fieldNum: number): Buffer {
    let result = Buffer.alloc(0);
    let offset = 0;

    while (offset < data.length) {
        const startOffset = offset;
        const [tag, newOffset] = readVarint(data, offset);
        const wireType = tag & 7;
        const currentField = tag >> 3;

        if (currentField === fieldNum) {
            offset = skipField(data, newOffset, wireType);
        } else {
            const nextOffset = skipField(data, newOffset, wireType);
            result = Buffer.concat([result, data.subarray(startOffset, nextOffset)]);
            offset = nextOffset;
        }
    }

    return result;
}
