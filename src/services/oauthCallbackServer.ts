/**
 * OAuth 回调服务器
 * 启动本地 HTTP 服务器接收 Google OAuth 回调
 */

import * as http from 'http';
import * as vscode from 'vscode';

const CALLBACK_PORT = 19823;
const CALLBACK_PATH = '/oauth-callback';

let server: http.Server | null = null;
let pendingResolve: ((code: string) => void) | null = null;
let pendingReject: ((error: Error) => void) | null = null;
let serverTimeout: NodeJS.Timeout | null = null;

/**
 * 启动 OAuth 回调服务器并等待授权码
 * @param timeout 超时时间（毫秒），默认 5 分钟
 */
export function startCallbackServer(timeout: number = 5 * 60 * 1000): Promise<string> {
    return new Promise((resolve, reject) => {
        // 如果服务器已经在运行，先关闭
        if (server) {
            stopCallbackServer();
        }

        pendingResolve = resolve;
        pendingReject = reject;

        server = http.createServer((req, res) => {
            const url = new URL(req.url || '', `http://localhost:${CALLBACK_PORT}`);

            if (url.pathname === CALLBACK_PATH) {
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');

                // 设置 CORS 头
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Access-Control-Allow-Origin', '*');

                if (error) {
                    res.writeHead(400);
                    res.end(getErrorHtml(error));
                    // 先保存回调引用，再 cleanup，最后调用回调
                    const reject = pendingReject;
                    cleanup();
                    reject?.(new Error(`OAuth 错误: ${error}`));
                } else if (code) {
                    res.writeHead(200);
                    res.end(getSuccessHtml());
                    // 先保存回调引用，再 cleanup，最后调用回调
                    const resolve = pendingResolve;
                    cleanup();
                    resolve?.(code);
                } else {
                    res.writeHead(400);
                    res.end(getErrorHtml('未收到授权码'));
                }
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                cleanup();
                reject(new Error(`端口 ${CALLBACK_PORT} 已被占用，请稍后重试`));
            } else {
                cleanup();
                reject(err);
            }
        });

        server.listen(CALLBACK_PORT, '127.0.0.1', () => {
            console.log(`[OAuth] Callback server started on port ${CALLBACK_PORT}`);
        });

        // 设置超时
        serverTimeout = setTimeout(() => {
            cleanup();
            reject(new Error('OAuth 授权超时，请重试'));
        }, timeout);
    });
}

/**
 * 停止回调服务器
 */
export function stopCallbackServer(): void {
    cleanup();
}

/**
 * 检查服务器是否在运行
 */
export function isServerRunning(): boolean {
    return server !== null;
}

function cleanup(): void {
    if (serverTimeout) {
        clearTimeout(serverTimeout);
        serverTimeout = null;
    }
    if (server) {
        server.close();
        server = null;
    }
    pendingResolve = null;
    pendingReject = null;
}

function getSuccessHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>授权成功</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        .icon { font-size: 64px; margin-bottom: 20px; }
        h1 { margin: 0 0 10px; font-size: 28px; }
        p { margin: 0; opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✅</div>
        <h1>授权成功！</h1>
        <p>您可以关闭此窗口，返回 VS Code。</p>
    </div>
    <script>
        // 3秒后自动关闭
        setTimeout(() => window.close(), 3000);
    </script>
</body>
</html>`;
}

function getErrorHtml(error: string): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>授权失败</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f44336 0%, #e91e63 100%);
            color: white;
        }
        .container {
            text-align: center;
            padding: 40px;
            background: rgba(255,255,255,0.1);
            border-radius: 20px;
            backdrop-filter: blur(10px);
        }
        .icon { font-size: 64px; margin-bottom: 20px; }
        h1 { margin: 0 0 10px; font-size: 28px; }
        p { margin: 0; opacity: 0.9; }
        .error { font-family: monospace; margin-top: 15px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">❌</div>
        <h1>授权失败</h1>
        <p>请返回 VS Code 重试。</p>
        <div class="error">${error}</div>
    </div>
</body>
</html>`;
}
