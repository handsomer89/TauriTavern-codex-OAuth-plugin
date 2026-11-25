import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppError, canUsePlan, clearSession, randomSecret, refresh } from './oauth.mjs';

export const stateDir = join(homedir(), '.tauritavern-plus');
const stateFile = join(stateDir, 'state.json');

export async function saveState(state) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const temporary = join(stateDir, '.' + randomUUID());
    await writeFile(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    try {
        await rename(temporary, stateFile);
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function loadState(create = false) {
    let data;
    try {
        data = await readFile(stateFile, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return null;
        const state = { hostId: 'urn:uuid:' + randomUUID(), key: randomSecret(), active: null, accounts: [] };
        await saveState(state);
        return state;
    }
    const state = JSON.parse(data);
    if (typeof state?.hostId !== 'string' || typeof state.key !== 'string' || !Array.isArray(state.accounts)) {
        throw new Error('本机配置文件格式无效。');
    }
    await chmod(stateFile, 0o600);
    return state;
}

export function activeAccount(state) {
    return state?.accounts.find(account => account.clientId === state.active);
}

export async function replaceAccount(state, account, activate = false) {
    const accounts = state.accounts.filter(entry => entry.clientId !== account.clientId);
    const next = { ...state, accounts: [...accounts, account], active: activate ? account.clientId : state.active };
    await saveState(next);
    Object.assign(state, next);
}

export function createTokenProvider(state, { renew = refresh, replace = replaceAccount } = {}) {
    let inFlight;
    return async function getAccessToken(rejectedToken) {
        let account = activeAccount(state);
        if (!account || !canUsePlan(account.scope)) {
            throw new AppError(403, 'plan_consent_required', '请先运行 login，并在 ChatGPT 登录页授权使用订阅额度。');
        }
        if (account.accessToken && account.accessToken !== rejectedToken && account.expiresAt > Date.now() + 60_000) {
            return account.accessToken;
        }
        if (!account.refreshToken) {
            throw new AppError(401, 'oauth_login_required', '此 ChatGPT 会话需要重新登录。');
        }
        inFlight ??= (async () => {
            try {
                await replace(state, await renew(account));
            } catch (error) {
                if (error.code === 'oauth_login_required') await replace(state, clearSession(account));
                throw error;
            }
        })().finally(() => { inFlight = undefined; });
        await inFlight;
        account = activeAccount(state);
        if (!account?.accessToken || !canUsePlan(account.scope)) {
            throw new AppError(403, 'plan_consent_required', '订阅授权已失效，请重新运行 login。');
        }
        return account.accessToken;
    };
}
