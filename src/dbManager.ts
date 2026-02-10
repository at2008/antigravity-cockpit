import * as fs from 'fs';
import * as path from 'path';
import * as sqlite3 from 'sqlite3';
import { promisify } from 'util';
import {
    VSCDB_PATH,
    DB_KEY_AGENT_STATE,
    DB_KEY_ONBOARDING
} from './constants';
import { encodeVarint, removeField } from './utils';

export class DBManager {
    static async injectToken(accessToken: string, refreshToken: string, expiry: number, email: string) {
        if (!fs.existsSync(VSCDB_PATH)) {
            throw new Error(`Database not found at ${VSCDB_PATH}`);
        }

        // Backup
        const backupPath = VSCDB_PATH + '.backup';
        fs.copyFileSync(VSCDB_PATH, backupPath);

        const db = new sqlite3.Database(VSCDB_PATH);
        const get = (sql: string, params: any[]) => new Promise<any>((resolve, reject) => {
            db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
        });
        const run = (sql: string, params: any[]) => new Promise<void>((resolve, reject) => {
            db.run(sql, params, (err) => err ? reject(err) : resolve());
        });

        try {
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

                await run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [KEY_NEW, outerB64]);
            } catch (e) {
                console.error('New format injection failed', e);
            }

            // 2. 旧格式注入
            const row: any = await get("SELECT value FROM ItemTable WHERE key = ?", [KEY_OLD]);
            if (row) {
                const blob = Buffer.from(row.value, 'base64');
                let clean = removeField(blob, 1); // UserID
                clean = removeField(clean, 2); // Email
                clean = removeField(clean, 6); // OAuthTokenInfo

                const emailField = this.createEmailField(email);
                const tokenField = this.createOAuthField(accessToken, refreshToken, expiry);
                const finalB64 = Buffer.concat([clean, emailField, tokenField]).toString('base64');

                await run("UPDATE ItemTable SET value = ? WHERE key = ?", [finalB64, KEY_OLD]);
            }

            // 3. Onboarding 标记
            await run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [KEY_ONBOARD, "true"]);

        } finally {
            db.close();
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

    static async readFullTokenInfo(): Promise<{ access_token: string, refresh_token: string, expiry: number } | null> {
        if (!fs.existsSync(VSCDB_PATH)) {
            return null;
        }

        const db = new sqlite3.Database(VSCDB_PATH);
        const get = (sql: string, params: any[]) => new Promise<any>((resolve, reject) => {
            db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
        });

        try {
            const KEY_NEW = "antigravityUnifiedStateSync.oauthToken";
            const row: any = await get("SELECT value FROM ItemTable WHERE key = ?", [KEY_NEW]);

            if (!row || !row.value) {
                return null;
            }

            // 1. 外层
            const outerProto = Buffer.from(row.value, 'base64');

            // 简易 protobuf reader (支持到 32位 整数)
            const readVarint = (buf: Buffer, off: number): [number, number] => {
                let res = 0, shift = 0;
                while (off < buf.length) {
                    const b = buf[off++];
                    res |= (b & 0x7F) << shift;
                    if (!(b & 0x80)) break;
                    shift += 7;
                }
                return [res, off];
            };

            // 2. 寻找 Inner (Field 1)
            let innerProto: Buffer | null = null;
            let offset = 0;
            while (offset < outerProto.length) {
                const [tag, off1] = readVarint(outerProto, offset);
                const wire = tag & 7;
                const fieldNum = tag >> 3;

                if (fieldNum === 1) {
                    const [len, off2] = readVarint(outerProto, off1);
                    innerProto = outerProto.subarray(off2, off2 + len);
                    break;
                } else {
                    if (wire === 2) {
                        const [len, off2] = readVarint(outerProto, off1);
                        offset = off2 + len;
                    } else if (wire === 0) {
                        const [, off2] = readVarint(outerProto, off1);
                        offset = off2;
                    } else { offset = off1 + 8; }
                }
            }
            if (!innerProto) return null;

            // 3. 寻找 B64_OAuthInfo (Field 2)
            let oauthInfoB64Str: string | null = null;
            offset = 0;
            while (offset < innerProto.length) {
                const [tag, off1] = readVarint(innerProto, offset);
                const fieldNum = tag >> 3;
                if (fieldNum === 2) {
                    const [len, off2] = readVarint(innerProto, off1);
                    oauthInfoB64Str = innerProto.subarray(off2, off2 + len).toString('utf-8');
                    break;
                } else {
                    const wire = tag & 7;
                    if (wire === 2) {
                        const [len, off2] = readVarint(innerProto, off1);
                        offset = off2 + len;
                    } else { offset++; }
                }
            }
            if (!oauthInfoB64Str) return null;

            // 4. 解析 OAuthInfo
            const oauthInfo = Buffer.from(oauthInfoB64Str, 'base64');
            let accessToken: string | null = null;
            let refreshToken: string | null = null;
            let expiry: number = 0;

            offset = 0;
            while (offset < oauthInfo.length) {
                const [tag, off1] = readVarint(oauthInfo, offset);
                const fieldNum = tag >> 3;

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
                    // 解析 Timestamp { seconds: 1 }
                    let tsOff = 0;
                    while (tsOff < tsMsg.length) {
                        const [tsTag, tsOff1] = readVarint(tsMsg, tsOff);
                        if ((tsTag >> 3) === 1) {
                            const [sec, tsOff2] = readVarint(tsMsg, tsOff1);
                            expiry = sec;
                            tsOff = tsOff2;
                        } else { tsOff++; }
                    }
                    offset = off2 + len;
                } else {
                    // Skip
                    const wire = tag & 7;
                    if (wire === 2) {
                        const [len, off2] = readVarint(oauthInfo, off1);
                        offset = off2 + len;
                    } else if (wire === 0) {
                        const [, off2] = readVarint(oauthInfo, off1);
                        offset = off2;
                    } else { offset++; }
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
            db.close();
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
