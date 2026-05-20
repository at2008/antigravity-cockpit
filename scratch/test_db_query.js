const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

console.log('🏁 开始测试 sql.js 读取数据库...');

initSqlJs().then(SQL => {
    console.log('✅ sql.js 初始化成功！');
    if (!fs.existsSync(dbPath)) {
        console.error('❌ 数据库文件不存在！');
        return;
    }
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    console.log('✅ 数据库载入成功，开始查询 ItemTable...');

    // 1. 查询 antigravityAuthStatus
    try {
        console.log('尝试查询 antigravityAuthStatus...');
        const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
        stmt.bind(["antigravityAuthStatus"]);
        if (stmt.step()) {
            const row = stmt.getAsObject();
            console.log('✅ 找到 antigravityAuthStatus:', row.value);
        } else {
            console.log('ℹ️ 未找到 antigravityAuthStatus');
        }
        stmt.free();
    } catch (err) {
        console.error('❌ 查询 antigravityAuthStatus 出错:', err);
    }

    // 2. 查询 antigravityUnifiedStateSync.oauthToken
    try {
        console.log('尝试查询 antigravityUnifiedStateSync.oauthToken...');
        const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
        stmt.bind(["antigravityUnifiedStateSync.oauthToken"]);
        if (stmt.step()) {
            const row = stmt.getAsObject();
            console.log('✅ 找到 oauthToken (前 100 字符):', row.value ? row.value.substring(0, 100) : null);
        } else {
            console.log('ℹ️ 未找到 oauthToken');
        }
        stmt.free();
    } catch (err) {
        console.error('❌ 查询 oauthToken 出错:', err);
    }

    db.close();
    console.log('🏁 测试完成！');
}).catch(err => {
    console.error('❌ sql.js 初始化失败！', err);
});
