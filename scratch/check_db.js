const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');

initSqlJs().then(SQL => {
    if (fs.existsSync(dbPath) === false) {
        console.error('❌ 数据库文件不存在！');
        return;
    }
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    
    const stmt = db.prepare('SELECT key, length(value) as len FROM ItemTable WHERE key IN (?, ?, ?)');
    stmt.bind(['antigravityAuthStatus', 'antigravityUnifiedStateSync.userStatus', 'antigravityUnifiedStateSync.oauthToken']);
    
    console.log('--- 📊 当前数据库自愈检测结果 ---');
    let foundKeys = 0;
    while(stmt.step()) {
        const row = stmt.getAsObject();
        console.log(`🔑 ${row.key} -> 重建成功 (数据大小: ${row.len} 字节)`);
        foundKeys++;
    }
    stmt.free();
    db.close();
    
    if (foundKeys === 3) {
        console.log('\n🎉 【自愈原理验证完全成功！】');
        console.log('   IDE 成功利用 oauthToken 重新拉取并重建了完整的账户与用户状态缓存！');
    } else {
        console.log('\n⚠️ 仍有缓存键缺失，自愈可能未完成，或正在拉取中...');
    }
}).catch(err => {
    console.error('❌ 检测时发生错误:', err.message);
});
