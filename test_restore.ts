import { extractLatestSessionId, openSession } from './src/services/chatSessionService';
import * as vscode from 'vscode';

async function testSessionRestoration() {
    console.log('--- Starting Session Restoration Test ---');

    // 1. 尝试提取会话ID
    const sessionId = extractLatestSessionId();
    if (!sessionId) {
        console.error('Failed to extract session ID from backup');
        return;
    }
    console.log(`Extracted Session ID: ${sessionId}`);

    // 2. 尝试打开会话
    const success = await openSession(sessionId);
    if (success) {
        console.log('Successfully triggered session restoration commands');
    } else {
        console.log('Failed to restore session via direct commands, used fallback open chat');
    }

    console.log('--- Test Finished ---');
}

// 在这个环境下，我们无法直接运行这个脚本，因为需要 vscode 环境。
// 我将通过创建一个临时的测试文件并让用户查看，或者通过 run_command 尝试运行（如果环境支持）。
// 这里我们只是准备逻辑来展示我们将如何“尝试”。
