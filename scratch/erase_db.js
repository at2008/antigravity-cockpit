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
    
    // 擦除缓存状态键
    db.run('DELETE FROM ItemTable WHERE key = ?', ['antigravityAuthStatus']);
    db.run('DELETE FROM ItemTable WHERE key = ?', ['antigravityUnifiedStateSync.userStatus']);
    
    // 保存并写回磁盘
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    db.close();
    
    console.log('✅ 临时擦除成功！');
    console.log('👉 [antigravityAuthStatus] 已从数据库移出');
    console.log('👉 [antigravityUnifiedStateSync.userStatus] 已从数据库移出');
    console.log('ℹ️ 此时，仅保留了 [antigravityUnifiedStateSync.oauthToken] 作为唯一登录凭证。');
}).catch(err => {
    console.error('❌ 擦除时发生错误:', err.message);
});
