const https = require('https');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

// 获取数据库路径
const dbPath = path.join(os.homedir(), 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');

// 读取数据库
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

// 解析所有字段
function parseProto(buf, indent = '') {
    let pos = 0;
    const fields = [];
    while (pos < buf.length) {
        try {
            const { value: tag, newPos: tagEnd } = readVarint(buf, pos);
            const wireType = tag & 0x07;
            const field = tag >> 3;
            pos = tagEnd;

            if (wireType === 2) {
                const { value: len, newPos: lenEnd } = readVarint(buf, pos);
                pos = lenEnd;
                const data = buf.slice(pos, pos + len);
                let strVal = '';
                try {
                    strVal = data.toString('utf-8');
                    // 检查是否可打印
                    if (/^[\x20-\x7E\n\r\t]+$/.test(strVal)) {
                        fields.push({ field, type: 'string', value: strVal.substring(0, 100) });
                    } else {
                        // 可能是嵌套 protobuf
                        fields.push({ field, type: 'bytes', nested: parseProto(data, indent + '  ') });
                    }
                } catch {
                    fields.push({ field, type: 'bytes', len });
                }
                pos += len;
            } else if (wireType === 0) {
                const { value, newPos } = readVarint(buf, pos);
                fields.push({ field, type: 'varint', value });
                pos = newPos;
            } else if (wireType === 1) {
                fields.push({ field, type: 'fixed64' });
                pos += 8;
            } else if (wireType === 5) {
                fields.push({ field, type: 'fixed32' });
                pos += 4;
            } else {
                break;
            }
        } catch {
            break;
        }
    }
    return fields;
}

console.log('=== Protobuf 结构 ===\n');
const fields = parseProto(buffer);

function printFields(fields, indent = '') {
    for (const f of fields) {
        if (f.nested && f.nested.length > 0) {
            console.log(`${indent}Field ${f.field} (nested):`);
            printFields(f.nested, indent + '  ');
        } else if (f.value !== undefined) {
            const val = typeof f.value === 'string' ? f.value.substring(0, 80) : f.value;
            console.log(`${indent}Field ${f.field} (${f.type}): ${val}`);
        }
    }
}

printFields(fields);

// 找 field 6 里的 token 信息
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

console.log('\n=== OAuth 信息 (Field 6) ===');
const oauth = findField(buffer, 6);
if (oauth) {
    const oauthFields = parseProto(oauth);
    printFields(oauthFields);
}

// 看看有没有 field 里包含 project 相关字符串
console.log('\n=== 搜索 project 相关字段 ===');
const str = buffer.toString('utf-8');
const projectMatch = str.match(/[a-z]+-[a-z]+-[a-z0-9]+/gi);
if (projectMatch) {
    console.log('可能的 Project ID:', [...new Set(projectMatch)]);
}
