const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

console.log('🏁 开始测试 protobuf 解析...');

initSqlJs().then(SQL => {
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    
    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
    stmt.bind(["antigravityUnifiedStateSync.oauthToken"]);
    
    if (!stmt.step()) {
        console.error('❌ 未找到 oauthToken!');
        stmt.free();
        db.close();
        return;
    }
    
    const row = stmt.getAsObject();
    stmt.free();
    db.close();
    
    const value = row.value;
    console.log('成功读取数据库中的 oauthToken, 长度:', value.length);
    
    // 下面运行 DBManager.readFullTokenInfo 内部的解析逻辑
    console.log('开始解析...');
    const result = parseTokenInfo(value);
    console.log('🎉 解析完成！结果:', result);
    
}).catch(err => {
    console.error('❌ 运行失败:', err);
});

function parseTokenInfo(valueStr) {
    const outerProto = Buffer.from(valueStr, 'base64');
    
    const readVarint = (buf, off) => {
        let res = 0, shift = 0;
        let startOff = off;
        while (off < buf.length) {
            const b = buf[off++];
            res |= (b & 0x7F) << shift;
            if (!(b & 0x80)) break;
            shift += 7;
            if (off - startOff > 10) {
                throw new Error("readVarint 疑似死循环！");
            }
        }
        return [res, off];
    };

    let innerProto = null;
    let offset = 0;
    let iterations = 0;
    
    while (offset < outerProto.length) {
        iterations++;
        if (iterations > 1000) {
            throw new Error("第一层 while 循环疑似死循环！offset=" + offset + ", len=" + outerProto.length);
        }
        
        const [tag, off1] = readVarint(outerProto, offset);
        const wire = tag & 7;
        const fieldNum = tag >> 3;

        console.log(`[层1] offset=${offset}, tag=${tag}, wire=${wire}, fieldNum=${fieldNum}, off1=${off1}`);

        if (fieldNum === 1) {
            const [len, off2] = readVarint(outerProto, off1);
            innerProto = outerProto.subarray(off2, off2 + len);
            console.log(`[层1] 找到 innerProto, 长度=${len}`);
            break;
        } else {
            if (wire === 2) {
                const [len, off2] = readVarint(outerProto, off1);
                offset = off2 + len;
            } else if (wire === 0) {
                const [, off2] = readVarint(outerProto, off1);
                offset = off2;
            } else { 
                offset = off1 + 8; 
            }
        }
    }
    
    if (!innerProto) {
        console.log("未找到 innerProto");
        return null;
    }

    let oauthInfoB64Str = null;
    offset = 0;
    iterations = 0;
    while (offset < innerProto.length) {
        iterations++;
        if (iterations > 1000) {
            throw new Error("第二层 while 循环疑似死循环！offset=" + offset + ", len=" + innerProto.length);
        }
        
        const [tag, off1] = readVarint(innerProto, offset);
        const fieldNum = tag >> 3;
        const wire = tag & 7;
        
        console.log(`[层2] offset=${offset}, tag=${tag}, wire=${wire}, fieldNum=${fieldNum}, off1=${off1}`);
        
        if (fieldNum === 2) {
            const [len, off2] = readVarint(innerProto, off1);
            oauthInfoB64Str = innerProto.subarray(off2, off2 + len).toString('utf-8');
            console.log(`[层2] 找到 oauthInfoB64Str, 长度=${len}`);
            break;
        } else {
            if (wire === 2) {
                const [len, off2] = readVarint(innerProto, off1);
                offset = off2 + len;
            } else { 
                offset++; 
            }
        }
    }
    
    if (!oauthInfoB64Str) {
        console.log("未找到 oauthInfoB64Str");
        return null;
    }

    const oauthInfo = Buffer.from(oauthInfoB64Str, 'base64');
    let accessToken = null;
    let refreshToken = null;
    let expiry = 0;

    offset = 0;
    iterations = 0;
    while (offset < oauthInfo.length) {
        iterations++;
        if (iterations > 1000) {
            throw new Error("第三层 while 循环疑似死循环！offset=" + offset + ", len=" + oauthInfo.length);
        }
        
        const [tag, off1] = readVarint(oauthInfo, offset);
        const fieldNum = tag >> 3;
        const wire = tag & 7;

        console.log(`[层3] offset=${offset}, tag=${tag}, wire=${wire}, fieldNum=${fieldNum}, off1=${off1}`);

        if (fieldNum === 1) { // Access Token
            const [len, off2] = readVarint(oauthInfo, off1);
            accessToken = oauthInfo.subarray(off2, off2 + len).toString('utf-8');
            offset = off2 + len;
        } else if (fieldNum === 3) { // Refresh Token
            const [len, off2] = readVarint(oauthInfo, off1);
            refreshToken = oauthInfo.subarray(off2, off2 + len).toString('utf-8');
            offset = off2 + len;
        } else if (fieldNum === 4) { // Expiry (Timestamp)
            const [len, off2] = readVarint(oauthInfo, off1);
            const tsMsg = oauthInfo.subarray(off2, off2 + len);
            let tsOff = 0;
            while (tsOff < tsMsg.length) {
                const [tsTag, tsOff1] = readVarint(tsMsg, tsOff);
                if ((tsTag >> 3) === 1) {
                    const [sec, tsOff2] = readVarint(tsMsg, tsOff1);
                    expiry = sec;
                    tsOff = tsOff2;
                } else { 
                    tsOff++; 
                }
            }
            offset = off2 + len;
        } else {
            if (wire === 2) {
                const [len, off2] = readVarint(oauthInfo, off1);
                offset = off2 + len;
            } else if (wire === 0) {
                const [, off2] = readVarint(oauthInfo, off1);
                offset = off2;
            } else { 
                offset++; 
            }
        }
    }

    return { access_token: accessToken, refresh_token: refreshToken, expiry: expiry };
}
