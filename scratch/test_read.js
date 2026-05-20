const fs = require('fs');
const path = require('path');

const dbPath = path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

console.log('🏁 开始测试读取数据库...');
console.log('数据库路径:', dbPath);
console.log('文件是否存在:', fs.existsSync(dbPath));

if (fs.existsSync(dbPath)) {
    console.log('尝试异步读取 fs.promises.readFile...');
    const start = Date.now();
    fs.promises.readFile(dbPath)
        .then(buffer => {
            console.log(`✅ 异步读取成功! 耗时: ${Date.now() - start}ms, 读取字节数: ${buffer.length}`);
        })
        .catch(err => {
            console.error('❌ 异步读取失败:', err.message);
        });

    console.log('尝试同步读取 fs.readFileSync...');
    try {
        const startSync = Date.now();
        const bufferSync = fs.readFileSync(dbPath);
        console.log(`✅ 同步读取成功! 耗时: ${Date.now() - startSync}ms, 读取字节数: ${bufferSync.length}`);
    } catch (err) {
        console.error('❌ 同步读取失败:', err.message);
    }
} else {
    console.log('❌ 数据库文件不存在，无法测试！');
}
