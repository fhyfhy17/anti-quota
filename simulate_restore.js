const fs = require('fs');
const path = require('path');
const os = require('os');

const backupFile = path.join(os.homedir(), '.anti-quota', 'state_backup.json');

async function triggerRestore() {
    console.log('--- 触发聊天恢复逻辑模拟 ---');

    if (!fs.existsSync(backupFile)) {
        console.error('错误: 未找到备份文件 ' + backupFile);
        return;
    }

    // 更新备份文件的修改时间，使其符合 "120秒内" 的判断逻辑
    const now = new Date();
    fs.utimesSync(backupFile, now, now);
    console.log('✅ 已更新备份文件时间戳为当前时间');

    console.log('现在请检查 VS Code：');
    console.log('1. 确保 Anti Quota 插件已加载');
    console.log('2. 插件应该会检测到备份文件并启动恢复流');
    console.log('3. 观察 Output Channel (Anti Quota) 中的日志');

    console.log('--- 模拟结束 ---');
}

triggerRestore();
