/**
 * 调试脚本：查看 fetchAvailableModels API 返回的原始 resetTime 数据
 * 只读操作，不会触发任何配额消耗
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 读取已保存的账号
const accountsPath = path.join(os.homedir(), '.anti-quota', 'accounts.json');
const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));

// 只取第一个账号测试
const testAccount = accounts[0];
console.log(`\n🔍 调试账号: ${testAccount.email}\n`);

function httpsPost(hostname, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const req = https.request({
            hostname,
            port: 443,
            path: urlPath,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 15000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, data: null });
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function refreshToken(refreshTokenStr) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
            client_secret: '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',
            refresh_token: refreshTokenStr,
            grant_type: 'refresh_token'
        }).toString();

        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            port: 443,
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function main() {
    // 1. 刷新 Token
    console.log('1. 刷新 access_token...');
    const tokenRes = await refreshToken(testAccount.token.refresh_token);
    if (!tokenRes.access_token) {
        console.log('Token 刷新失败:', tokenRes);
        return;
    }
    const accessToken = tokenRes.access_token;

    // 2. 获取 Project ID
    console.log('2. 获取 Project ID...');
    const projectRes = await httpsPost('cloudcode-pa.googleapis.com', '/v1internal:loadCodeAssist', {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'antigravity/1.11.3 Darwin/arm64'
    }, { metadata: { ideType: 'ANTIGRAVITY' } });

    const projectId = projectRes.data?.cloudaicompanionProject || 'bamboo-precept-lgxtn';
    console.log('   Project ID:', projectId);

    // 3. 获取配额（只读操作）
    console.log('3. 获取配额数据 (fetchAvailableModels)...\n');
    const quotaRes = await httpsPost('cloudcode-pa.googleapis.com', '/v1internal:fetchAvailableModels', {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'antigravity/1.11.3 Darwin/arm64'
    }, { project: projectId });

    if (quotaRes.status !== 200) {
        console.log('API 错误:', quotaRes.status, quotaRes.data);
        return;
    }

    // 4. 打印所有模型的 quotaInfo 原始数据
    console.log('='.repeat(60));
    console.log('原始 quotaInfo 数据');
    console.log('='.repeat(60));

    const now = new Date();
    console.log(`当前时间: ${now.toISOString()}\n`);

    const models = quotaRes.data.models || {};
    for (const [name, info] of Object.entries(models)) {
        const qi = info.quotaInfo;
        if (!qi) continue;

        // 只显示我们关心的模型
        const nameLower = name.toLowerCase();
        if (!nameLower.includes('claude') && !nameLower.includes('gemini')) continue;
        if (nameLower.includes('thinking') || nameLower.includes('lite')) continue;

        const pct = Math.round((qi.remainingFraction || 0) * 100);
        const resetTime = qi.resetTime || '(无)';

        // 计算距离重置的时间
        let diffStr = '';
        if (qi.resetTime) {
            const resetDate = new Date(qi.resetTime);
            const diffMs = resetDate.getTime() - now.getTime();
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            diffStr = diffMs > 0 ? `(+${diffHours}h ${diffMins}m)` : `(已过期 ${-diffHours}h ${-diffMins}m)`;
        }

        console.log(`模型: ${name}`);
        console.log(`  remainingFraction: ${qi.remainingFraction} (${pct}%)`);
        console.log(`  resetTime: ${resetTime} ${diffStr}`);
        console.log(`  完整 quotaInfo: ${JSON.stringify(qi)}`);
        console.log('');
    }
}

main().catch(console.error);
