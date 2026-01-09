const https = require('https');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

// 获取数据库路径
const dbPath = path.join(os.homedir(), 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
const base64Data = execSync(`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'jetskiStateSync.agentManagerInitState'"`).toString().trim();
const buffer = Buffer.from(base64Data, 'base64');

function readVarint(buf, pos) {
    let result = 0, shift = 0;
    while (pos < buf.length) {
        const byte = buf[pos];
        result |= (byte & 0x7f) << shift;
        pos++;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result, newPos: pos };
}

function findField(buf, fieldNum) {
    let pos = 0;
    while (pos < buf.length) {
        try {
            const { value: tag, newPos: tagEnd } = readVarint(buf, pos);
            const wireType = tag & 0x07;
            const field = tag >> 3;
            pos = tagEnd;
            if (wireType === 2) {
                const { value: len, newPos: lenEnd } = readVarint(buf, pos);
                pos = lenEnd;
                if (field === fieldNum) return buf.slice(pos, pos + len);
                pos += len;
            } else if (wireType === 0) {
                const { newPos } = readVarint(buf, pos);
                pos = newPos;
            } else if (wireType === 1) pos += 8;
            else if (wireType === 5) pos += 4;
            else break;
        } catch { break; }
    }
    return null;
}

function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function main() {
    // 1. 从数据库获取 access_token
    const oauth = findField(buffer, 6);
    const accessToken = findField(oauth, 1).toString();
    const refreshToken = findField(oauth, 3).toString();
    console.log('1. 从数据库读取 Token');
    console.log('   refresh_token:', refreshToken.substring(0, 20) + '...');
    console.log('   access_token:', accessToken.substring(0, 30) + '...');

    // 2. 尝试不同的 loadCodeAssist 参数
    console.log('\n2. 尝试 loadCodeAssist API (使用不同参数)');

    const variants = [
        { metadata: { ideType: 'ANTIGRAVITY' } },
        { metadata: { ideType: 'VSCODE' } },
        { metadata: { ideType: 'GEMINI_CODE_ASSIST' } },
        {},
    ];

    for (const body of variants) {
        const projectBody = JSON.stringify(body);
        const projectRes = await httpsRequest({
            hostname: 'cloudcode-pa.googleapis.com',
            port: 443,
            path: '/v1internal:loadCodeAssist',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + accessToken,
                'Content-Length': Buffer.byteLength(projectBody)
            }
        }, projectBody);

        try {
            const json = JSON.parse(projectRes.data);
            console.log(`\n   Params: ${JSON.stringify(body)}`);
            console.log(`   cloudaicompanionProject: ${json.cloudaicompanionProject || 'NOT FOUND'}`);
            if (json.allowedTiers) {
                console.log('   allowedTiers:', json.allowedTiers.map(t => t.id).join(', '));
            }
        } catch (e) {
            console.log(`   Error: ${projectRes.data.substring(0, 100)}`);
        }
    }

    // 3. 尝试直接从数据库提取 Project ID (搜索 bamboo 或 project 相关字段) 
    console.log('\n3. 尝试从数据库搜索 Project ID');
    const allStr = buffer.toString('utf-8');
    const matches = allStr.match(/[a-z]+-[a-z]+-[a-z0-9]{5,}/gi);
    if (matches) {
        const candidates = [...new Set(matches)].filter(m =>
            !m.includes('video') && !m.includes('audio') && !m.includes('image') &&
            !m.includes('text') && !m.includes('python') && !m.includes('fcfc')
        );
        console.log('   候选 Project ID:', candidates);

        // 尝试用这些 project ID 获取配额
        for (const projectId of candidates.slice(0, 3)) {
            const quotaBody = JSON.stringify({ project: projectId });
            const quotaRes = await httpsRequest({
                hostname: 'cloudcode-pa.googleapis.com',
                port: 443,
                path: '/v1internal:fetchAvailableModels',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + accessToken,
                    'Content-Length': Buffer.byteLength(quotaBody)
                }
            }, quotaBody);

            console.log(`   尝试 ${projectId}: ${quotaRes.status}`);
            if (quotaRes.status === 200) {
                console.log('   ✅ 成功！');
                const json = JSON.parse(quotaRes.data);
                if (json.models) {
                    for (const [name, info] of Object.entries(json.models)) {
                        if (info.quotaInfo && (name.includes('claude') || name.includes('gemini'))) {
                            const pct = Math.round((info.quotaInfo.remainingFraction || 0) * 100);
                            console.log(`      ${name}: ${pct}%`);
                        }
                    }
                }
                return;
            }
        }
    }

    // 4. 尝试从 google.geminicodeassist 读取
    console.log('\n4. 检查 google.geminicodeassist 数据');
    try {
        const geminiData = execSync(`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'google.geminicodeassist'"`).toString().trim();
        console.log('   内容:', geminiData.substring(0, 300));
    } catch (e) {
        console.log('   未找到');
    }
}

main().catch(console.error);
