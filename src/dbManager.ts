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
