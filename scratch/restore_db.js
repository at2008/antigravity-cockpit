const fs = require('fs');
const path = require('path');

const dbPath = path.join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
const backupPath = dbPath + '.experiment_backup';

if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, dbPath);
    fs.unlinkSync(backupPath);
    console.log('✅ 备份已还原！实验临时数据已清除，日常数据库归位成功。');
} else {
    console.error('❌ 未找到备份文件！');
}
