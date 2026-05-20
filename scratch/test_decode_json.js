const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

console.log('🏁 开始深度解码 oauthToken...');

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
    console.log('原始 Base64 长度:', value.length);
    
    const outerProto = Buffer.from(value, 'base64');
    console.log('外层二进制长度:', outerProto.length);
    
    // 打印外层二进制中所有的明文字符串
    const asciiText = outerProto.toString('ascii').replace(/[^\x20-\x7E]/g, ' ');
    console.log('外层二进制中包含的明文字符串:');
    console.log(asciiText);
    
    // 找出所有的 JSON 子串
    console.log('\n--- 尝试提取 JSON 内容 ---');
    const fullText = outerProto.toString('utf-8');
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        console.log('提取到的 JSON 串:', jsonMatch[0]);
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            console.log('✅ JSON 成功解析为对象:', JSON.stringify(parsed, null, 2));
        } catch (e) {
            console.log('⚠️ 提取到的字符串似乎不完整，无法直接 JSON.parse:', e.message);
        }
    } else {
        console.log('❌ 未在二进制中找到任何匹配的 JSON 大括号结构！');
    }
    
}).catch(err => {
    console.error('❌ 运行失败:', err);
});
