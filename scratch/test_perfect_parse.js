const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

console.log('🏁 开始测试完美的兼容性解析算法...');

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
    console.log('成功读取数据库中的 oauthToken');
    
    const start = Date.now();
    const result = readFullTokenInfoFromValue(value);
    console.log(`🎉 解析完成! 耗时: ${Date.now() - start}ms`);
    console.log('解析结果:', result);
    
}).catch(err => {
    console.error('❌ 运行失败:', err);
});

function readFullTokenInfoFromValue(valueStr) {
    if (!valueStr) return null;

    try {
        const outerProto = Buffer.from(valueStr, 'base64');
        
        // 强力防溢出无符号整型读取
        const readVarint = (buf, off) => {
            let res = 0, shift = 0;
            const startOff = off;
            while (off < buf.length) {
                const b = buf[off++];
                // 使用无符号整型操作防溢出为负数
                res = (res + ((b & 0x7F) << shift)) >>> 0;
                if (!(b & 0x80)) break;
                shift += 7;
                if (off - startOff > 10) {
                    break; // 防 varint 本身死循环
                }
            }
            return [res, off];
        };

        // 1. 寻找 Inner (新版在 field 2，老版在 field 1)
        let innerProto = null;
        let offset = 0;
        let iterations = 0;

        while (offset < outerProto.length) {
            iterations++;
            if (iterations > 1000) {
                console.warn('[Cockpit] 第一层循环触发安全阈值，强退。');
                break;
            }

            const [tag, off1] = readVarint(outerProto, offset);
            const wire = tag & 7;
            const fieldNum = tag >> 3;

            if (fieldNum === 1 || fieldNum === 2) {
                const [len, off2] = readVarint(outerProto, off1);
                const subBuf = outerProto.subarray(off2, off2 + len);
                
                // 检查子 Buffer 中是否包含 'oauthTokenInfoSentinelKey'，若包含则是我们需要的目标子协议
                if (subBuf.toString('utf-8').includes('oauthTokenInfoSentinelKey')) {
                    innerProto = subBuf;
                    break;
                }
                
                // 正常步进
                if (wire === 2) {
                    offset = off2 + len;
                } else if (wire === 0) {
                    offset = off2;
                } else {
                    offset = off1 + 8;
                }
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
            console.log('[Cockpit] 未找到有效的 innerProto');
            return null;
        }

        // 2. 寻找 B64_OAuthInfo (Field 2)
        let oauthInfoB64Str = null;
        offset = 0;
        iterations = 0;
        while (offset < innerProto.length) {
            iterations++;
            if (iterations > 1000) {
                console.warn('[Cockpit] 第二层循环触发安全阈值，强退。');
                break;
            }

            const [tag, off1] = readVarint(innerProto, offset);
            const fieldNum = tag >> 3;
            const wire = tag & 7;

            if (fieldNum === 2) {
                const [len, off2] = readVarint(innerProto, off1);
                oauthInfoB64Str = innerProto.subarray(off2, off2 + len).toString('utf-8');
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
            console.log('[Cockpit] 未找到 oauthInfoB64Str');
            return null;
        }

        // 3. 解析明文 OAuthInfo
        const oauthInfo = Buffer.from(oauthInfoB64Str, 'base64');
        let accessToken = null;
        let refreshToken = null;
        let expiry = 0;

        offset = 0;
        iterations = 0;
        while (offset < oauthInfo.length) {
            iterations++;
            if (iterations > 1000) {
                console.warn('[Cockpit] 第三层循环触发安全阈值，强退。');
                break;
            }

            const [tag, off1] = readVarint(oauthInfo, offset);
            const fieldNum = tag >> 3;
            const wire = tag & 7;

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
                let tsIterations = 0;
                while (tsOff < tsMsg.length) {
                    tsIterations++;
                    if (tsIterations > 100) break;

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

        if (accessToken && refreshToken) {
            return { access_token: accessToken, refresh_token: refreshToken, expiry: expiry };
        }
        return null;

    } catch (e) {
        console.error('[Cockpit] Failed to parse token info', e);
        return null;
    }
}
