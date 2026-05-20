import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require('sql.js');
import {
    getVSCDBPath,
    DB_KEY_AGENT_STATE,
    DB_KEY_ONBOARDING
} from './constants';
import { encodeVarint, removeField } from './utils';

// sql.js WASM 初始化（单例，避免多次加载）
let sqlJsPromise: Promise<any> | null = null;
function getSqlJs() {
    if (!sqlJsPromise) {
        sqlJsPromise = initSqlJs();
    }
    return sqlJsPromise;
}

/**
 * 使用 sql.js (纯 WASM) 代替 sqlite3 原生模块
 * 彻底避免 Electron ABI 版本不兼容的问题
 */
export class DBManager {
    private static resolveDbPath(dbPath?: string): string {
        return dbPath && dbPath.trim() ? dbPath.trim() : getVSCDBPath();
    }

    /**
     * 打开数据库文件并返回 sql.js Database 实例
     */
    private static async openDb(dbPath: string): Promise<any> {
        const SQL = await getSqlJs();
        const buffer = await fs.promises.readFile(dbPath);
        return new SQL.Database(buffer);
    }

    /**
     * 将 sql.js Database 实例写回磁盘
     */
    private static saveDb(db: any, dbPath: string) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
    }

    static async injectToken(accessToken: string, refreshToken: string, expiry: number, email: string, dbPath?: string) {
        const resolvedDbPath = this.resolveDbPath(dbPath);

        if (!fs.existsSync(resolvedDbPath)) {
            throw new Error(`Database not found at ${resolvedDbPath}`);
        }

        // Backup
        const backupPath = resolvedDbPath + '.backup';
        fs.copyFileSync(resolvedDbPath, backupPath);

        let db: any = null;
        try {
            db = await this.openDb(resolvedDbPath);
            const KEY_OLD = DB_KEY_AGENT_STATE;
            const KEY_NEW = "antigravityUnifiedStateSync.oauthToken";
            const KEY_ONBOARD = DB_KEY_ONBOARDING;

            // 1. 新格式注入
            try {
                const oauthInfo = this.createOAuthInfo(accessToken, refreshToken, expiry);
                const oauthInfoB64 = oauthInfo.toString('base64');
                const inner2 = this.encodeStringField(1, oauthInfoB64);
                const inner1 = this.encodeStringField(1, "oauthTokenInfoSentinelKey");
                const inner = Buffer.concat([inner1, this.encodeLenDelim(2, inner2)]);
                const outer = this.encodeLenDelim(1, inner);
                const outerB64 = outer.toString('base64');

                db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [KEY_NEW, outerB64]);
            } catch (e) {
                console.error('New format injection failed', e);
            }

            // 2. 旧格式注入
            const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
            stmt.bind([KEY_OLD]);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                try {
                    const blob = Buffer.from(row.value as string, 'base64');
                    let clean = removeField(blob, 1); // UserID
                    clean = removeField(clean, 2); // Email
                    clean = removeField(clean, 6); // OAuthTokenInfo

                    const emailField = this.createEmailField(email);
                    const tokenField = this.createOAuthField(accessToken, refreshToken, expiry);
                    const finalB64 = Buffer.concat([clean, emailField, tokenField]).toString('base64');

                    db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [finalB64, KEY_OLD]);
                } catch (e) {
                    console.error('Old format injection failed', e);
                }
            }
            stmt.free();

            // 3. Onboarding 标记
            db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [KEY_ONBOARD, "true"]);

            // 4. 擦除旧账号可能残留的冲突缓存键，迫使新版 IDE 启动时使用新 Token 触发自愈拉取与状态重建
            db.run("DELETE FROM ItemTable WHERE key = ?", ["antigravityAuthStatus"]);
            db.run("DELETE FROM ItemTable WHERE key = ?", ["antigravityUnifiedStateSync.userStatus"]);

            // 写回磁盘
            this.saveDb(db, resolvedDbPath);
        } finally {
            db?.close();
        }
    }

    private static encodeLenDelim(fieldNum: number, data: Buffer): Buffer {
        const tag = (fieldNum << 3) | 2;
        return Buffer.concat([encodeVarint(tag), encodeVarint(data.length), data]);
    }

    private static encodeStringField(fieldNum: number, value: string): Buffer {
        return this.encodeLenDelim(fieldNum, Buffer.from(value, 'utf-8'));
    }

    private static createOAuthInfo(accessToken: string, refreshToken: string, expiry: number): Buffer {
        const f1 = this.encodeStringField(1, accessToken);
        const f2 = this.encodeStringField(2, "Bearer");
        const f3 = this.encodeStringField(3, refreshToken);
        const timestampTag = (1 << 3) | 0;
        const timestampMsg = Buffer.concat([encodeVarint(timestampTag), encodeVarint(expiry)]);
        const f4 = this.encodeLenDelim(4, timestampMsg);
        return Buffer.concat([f1, f2, f3, f4]);
    }

    private static createEmailField(email: string): Buffer {
        return this.encodeStringField(2, email);
    }

    static async readFullTokenInfo(dbPath?: string): Promise<{ access_token: string, refresh_token: string, expiry: number } | null> {
        const resolvedDbPath = this.resolveDbPath(dbPath);

        if (!fs.existsSync(resolvedDbPath)) {
            return null;
        }

        let db: any = null;
        try {
            db = await this.openDb(resolvedDbPath);
            const KEY_NEW = "antigravityUnifiedStateSync.oauthToken";
            const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
            stmt.bind([KEY_NEW]);

            if (!stmt.step()) {
                stmt.free();
                return null;
            }

            const row = stmt.getAsObject();
            stmt.free();

            if (!row || !row.value) {
                return null;
            }

            // 1. 外层
            const outerProto = Buffer.from(row.value as string, 'base64');

            // 强力防溢出无符号整型读取
            const readVarint = (buf: Buffer, off: number): [number, number] => {
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

            // 2. 寻找 Inner (新版在 field 2，老版在 field 1)
            let innerProto: Buffer | null = null;
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

            // 3. 寻找 B64_OAuthInfo (Field 2)
            let oauthInfoB64Str: string | null = null;
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

            // 4. 解析明文 OAuthInfo
            const oauthInfo = Buffer.from(oauthInfoB64Str, 'base64');
            let accessToken: string | null = null;
            let refreshToken: string | null = null;
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
            console.error('Failed to read access token from DB', e);
            return null;
        } finally {
            db?.close();
        }
    }

    static async readAuthStatus(dbPath?: string): Promise<{
        state: 'authenticated' | 'logged_out' | 'missing';
        email?: string;
        name?: string;
        apiKey?: string;
    }> {
        const resolvedDbPath = this.resolveDbPath(dbPath);

        if (!fs.existsSync(resolvedDbPath)) {
            return { state: 'missing' };
        }

        let db: any = null;
        try {
            db = await this.openDb(resolvedDbPath);
            const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
            stmt.bind(["antigravityAuthStatus"]);

            if (!stmt.step()) {
                stmt.free();
                return { state: 'missing' };
            }

            const row = stmt.getAsObject();
            stmt.free();

            if (!row || !row.value) {
                return { state: 'missing' };
            }

            const rawValue = String(row.value).trim();
            if (!rawValue || rawValue === 'null') {
                return { state: 'logged_out' };
            }

            const parsed = JSON.parse(rawValue);
            if (!parsed || !parsed.email) {
                return { state: 'logged_out' };
            }

            return {
                state: 'authenticated',
                email: parsed.email,
                name: parsed.name,
                apiKey: parsed.apiKey
            };
        } catch (e) {
            console.error('Failed to read auth status from DB', e);
            return { state: 'missing' };
        } finally {
            db?.close();
        }
    }

    private static createOAuthField(accessToken: string, refreshToken: string, expiry: number): Buffer {
        // message OAuthTokenInfo {
        //     optional string access_token = 1;
        //     optional string token_type = 2;
        //     optional string refresh_token = 3;
        //     optional Timestamp expiry = 4;
        // }

        // Field 1: access_token (string, tag=1, wire=2)
        const tag1 = (1 << 3) | 2;
        const field1 = Buffer.concat([
            encodeVarint(tag1),
            encodeVarint(Buffer.byteLength(accessToken)),
            Buffer.from(accessToken)
        ]);

        // Field 2: token_type ("Bearer", tag=2, wire=2)
        const tokenType = "Bearer";
        const tag2 = (2 << 3) | 2;
        const field2 = Buffer.concat([
            encodeVarint(tag2),
            encodeVarint(Buffer.byteLength(tokenType)),
            Buffer.from(tokenType)
        ]);

        // Field 3: refresh_token (string, tag=3, wire=2)
        const tag3 = (3 << 3) | 2;
        const field3 = Buffer.concat([
            encodeVarint(tag3),
            encodeVarint(Buffer.byteLength(refreshToken)),
            Buffer.from(refreshToken)
        ]);

        // Field 4: expiry (Timestamp, tag=4, wire=2)
        // Timestamp: Field 1: seconds (int64, tag=1, wire=0)
        const timestampTag = (1 << 3) | 0;
        const timestampMsg = Buffer.concat([
            encodeVarint(timestampTag),
            encodeVarint(expiry)
        ]);

        const tag4 = (4 << 3) | 2;
        const field4 = Buffer.concat([
            encodeVarint(tag4),
            encodeVarint(timestampMsg.length),
            timestampMsg
        ]);

        const oauthInfo = Buffer.concat([field1, field2, field3, field4]);

        // Field 6 (tag=6, wire=2)
        const tag6 = (6 << 3) | 2;
        return Buffer.concat([
            encodeVarint(tag6),
            encodeVarint(oauthInfo.length),
            oauthInfo
        ]);
    }
}
