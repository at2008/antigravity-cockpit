const fs = require('fs');
const path = require('path');

const dbPath = path.join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
const backupPath = dbPath + '.experiment_backup';

if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, backupPath);
    console.log('✅ 数据库备份成功！');
    console.log('📂 备份路径: ' + backupPath);
} else {
    console.error('❌ 未找到数据库文件，请确认 IDE 路径！');
}
