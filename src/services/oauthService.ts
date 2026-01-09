/**
 * Google OAuth 服务
 * 处理授权、Token 刷新等
 */

import * as https from 'https';

// Google OAuth 配置 (来自 Antigravity)
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// 固定的 redirect_uri
const REDIRECT_URI = 'http://localhost:19823/oauth-callback';

const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs'
].join(' ');

export interface TokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
    refresh_token?: string;
}

export interface UserInfo {
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    picture?: string;
}

/**
 * 生成 OAuth 授权 URL
 */
export function getAuthUrl(): string {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true'
    });
    return `${AUTH_URL}?${params.toString()}`;
}

/**
 * 从回调 URL 中提取 code
 */
export function extractCodeFromUrl(url: string): string | null {
    try {
        let urlObj: URL;
        if (url.startsWith('http')) {
            urlObj = new URL(url);
        } else if (url.includes('code=')) {
            urlObj = new URL('http://localhost?' + url);
        } else {
            return null;
        }
        return urlObj.searchParams.get('code');
    } catch {
        const match = url.match(/code=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    }
}

/**
 * 使用 Authorization Code 交换 Token
 */
export function exchangeCode(code: string): Promise<TokenResponse> {
    return new Promise((resolve, reject) => {
        const postData = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code'
        }).toString();

        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            port: 443,
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 15000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.access_token) {
                        resolve(json);
                    } else {
                        reject(new Error(`Token exchange failed: ${data}`));
                    }
                } catch (e) {
                    reject(new Error(`Parse error: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

        req.write(postData);
        req.end();
    });
}

/**
 * 刷新 Access Token
 */
export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    return new Promise((resolve, reject) => {
        const postData = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        }).toString();

        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            port: 443,
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 15000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.access_token) {
                        resolve(json);
                    } else {
                        reject(new Error(`Token refresh failed: ${data}`));
                    }
                } catch (e) {
                    reject(new Error(`Parse error: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

        req.write(postData);
        req.end();
    });
}

/**
 * 获取用户信息
 */
export function getUserInfo(accessToken: string): Promise<UserInfo> {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'www.googleapis.com',
            port: 443,
            path: '/oauth2/v2/userinfo',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.email) {
                        resolve(json);
                    } else {
                        reject(new Error(`Get user info failed: ${data}`));
                    }
                } catch (e) {
                    reject(new Error(`Parse error: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

        req.end();
    });
}
