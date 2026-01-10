/**
 * 账号相关类型定义
 */

export interface Account {
    id: string;
    email: string;
    name?: string;
    token: TokenData;
    quota?: QuotaData;
    created_at: number;
    last_used: number;
    /** 是否禁用自动切换 */
    disabled?: boolean;
    /** 优先级（数字越大优先级越高） */
    priority?: number;
}

export interface TokenData {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    expiry_timestamp: number;
    token_type: string;
}

export interface QuotaData {
    models: ModelQuota[];
    last_updated: number;
    /** 账号是否被禁止（403） */
    is_forbidden?: boolean;
}

export interface ModelQuota {
    name: string;
    displayName: string;
    percentage: number;
    reset_time: string;
}

/** 自动切换配置 */
export interface AutoSwitchConfig {
    /** 是否启用自动切换 */
    enabled: boolean;
    /** 配额阈值（低于此值触发切换） */
    threshold: number;
    /** 检查间隔（秒） */
    checkInterval: number;
    /** 切换模式 */
    switchMode: 'seamless' | 'full';
    /** 切换时是否通知 */
    notifyOnSwitch: boolean;
    /** 是否开启交互式确认切换 */
    interactive: boolean;
}

/** 插件设置 */
export interface PluginSettings {
    /** 自动刷新间隔（秒） */
    refreshInterval: number;
    /** 是否启用 */
    enabled: boolean;
    /** 自动切换配置 */
    autoSwitch: AutoSwitchConfig;
    /** 显示的模型列表 */
    displayModels: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
    refreshInterval: 10,  // 第一版默认值：10 秒及时刷新
    enabled: true,
    autoSwitch: {
        enabled: true,
        threshold: 95,  // 已根据要求更新为 95%
        checkInterval: 30,  // 从60秒缩短到30秒，更及时响应
        switchMode: 'seamless',
        notifyOnSwitch: true,
        interactive: true  // 默认开启交互提示模式
    },
    displayModels: ['claude', 'gemini-pro', 'gemini-flash']
};
