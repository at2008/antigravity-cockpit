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
    static async injectToken(accessToken: string, refreshToken: string, expiry: number) {
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
            // 1. Get current data
            const row: any = await get("SELECT value FROM ItemTable WHERE key = ?", [DB_KEY_AGENT_STATE]);
            if (!row) {
                throw new Error(`Key ${DB_KEY_AGENT_STATE} not found in database.`);
            }

            const currentDataB64 = row.value;
            const blob = Buffer.from(currentDataB64, 'base64');

            // 2. Remove old Field 6
            const cleanData = removeField(blob, 6);

            // 3. Create new Field 6
            const newField = this.createOAuthField(accessToken, refreshToken, expiry);

            // 4. Merge and Encode
            const finalData = Buffer.concat([cleanData, newField]);
            const finalB64 = finalData.toString('base64');

            // 5. Update Database
            await run("UPDATE ItemTable SET value = ? WHERE key = ?", [finalB64, DB_KEY_AGENT_STATE]);
            await run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", [DB_KEY_ONBOARDING, "true"]);

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
