import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApi, errorResult, json } from './api.mjs';
import { AppError, AUTH, canUsePlan, clearSession, completeAttempt, equalSecret, makeAttempt, revoke } from './oauth.mjs';
import { activeAccount, createTokenProvider, loadState, replaceAccount, saveState } from './state.mjs';

const HOST = '127.0.0.1';
const PORT = 18765;
const BASE = 'http://' + HOST + ':' + PORT;
const CALLBACK = '/auth/callback';
const USAGE = 'https://chatgpt.com/settings/usage';
const open = promisify(execFile);

export async function listen(route, port = PORT) {
    const server = createServer({ requestTimeout: 45_000, headersTimeout: 15_000, maxHeaderSize: 16_384 }, (req, res) => {
        const host = HOST + ':' + server.address().port;
        Promise.resolve().then(() => {
            if (req.headers.host !== host || !req.url?.startsWith('/') || req.url.startsWith('//')) {
                throw new AppError(400, 'invalid_local_request', '请使用 127.0.0.1 上的本机地址。');
            }
            return route(req, res, new URL(req.url, 'http://' + host));
        }).catch(error => {
            if (res.destroyed) return;
            if (res.headersSent) return res.destroy();
            json(res, error instanceof AppError ? error.status : 500, { error: errorResult(error) });
        });
    });
    server.listen({ host: HOST, port, exclusive: true });
    await once(server, 'listening');
    return server;
}

function callbackPage(res, status, message) {
    const clearUrl = "history.replaceState(null,'','/auth/callback')";
    const hash = createHash('sha256').update(clearUrl).digest('base64');
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'sha256-" + hash + "'",
    });
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>TauriTavern Plus Bridge</title><p>' + message + '</p><script>' + clearUrl + '</script></html>');
}

async function sendToBrowser(attempt) {
    const url = AUTH + '/api/accounts/authorize?';
    const params = new URLSearchParams(attempt.params);
    if (process.platform === 'android' || process.env.TERMUX_VERSION) {
        try {
            await open('termux-open-url', [url + params], { timeout: 5000 });
            return;
        } catch {
            // The manual URL below omits the retained ID token.
        }
    }
    params.delete('id_token_hint');
    params.delete('login_hint');
    console.log('在同一设备的系统浏览器打开此地址完成登录：\n' + url + params);
}

function findAccount(state, label) {
    const account = state.accounts.find(entry => entry.clientId === label || entry.label === label);
    if (!account) throw new Error('找不到此账号记录。运行 accounts 查看完整客户端 ID。');
    return account;
}

async function main([command, accountId, ...extra]) {
    const commands = new Set(['login', 'logout', 'accounts', 'use', 'key', 'serve']);
    if (!commands.has(command) || extra.length || (command === 'use' && !accountId)
            || (accountId && !['login', 'use'].includes(command))) {
        console.log('用法：node bridge/bridge.mjs login [客户端 ID] | logout | accounts | use <客户端 ID> | key | serve');
        process.exitCode = command && command !== '--help' ? 1 : 0;
        return;
    }

    if (command === 'key' || command === 'accounts') {
        const state = await loadState();
        if (!state) throw new Error('请先运行 login 或 serve。');
        if (command === 'key') {
            console.log(state.key);
            return;
        }
        if (!state.accounts.length) console.log('没有已保存的账号。');
        for (const account of state.accounts) {
            const active = state.active === account.clientId ? '（当前）' : '';
            const label = account.email ?? account.label;
            const status = account.accessToken ? '已授权' : '需要登录或授权';
            console.log(label + active + '  ' + status + '  ' + account.clientId);
        }
        return;
    }

    let route = () => { throw new AppError(503, 'bridge_starting', '本机服务正在准备。'); };
    let stopping = false;
    const pending = new Set();
    // Every writer claims the same loopback port before reading the token file.
    const server = await listen(async (req, res, url) => {
        if (stopping) throw new AppError(503, 'bridge_stopping', '本机服务正在停止。');
        const task = Promise.resolve().then(() => route(req, res, url));
        pending.add(task);
        try {
            await task;
        } finally {
            pending.delete(task);
        }
    });
    try {
        const state = await loadState(true);
        if (command === 'use') {
            await replaceAccount(state, findAccount(state, accountId), true);
            console.log('已选择 ChatGPT 账号。');
            return;
        }
        if (command === 'logout') {
            const account = activeAccount(state);
            if (!account) throw new Error('当前没有选中的账号。');
            const revoked = await revoke(account);
            await replaceAccount(state, clearSession(account));
            console.log(revoked ? '已退出登录。' : '已在本机退出；远端撤销未确认，可在 ChatGPT 设置断开授权。');
            return;
        }
        if (command === 'login') {
            const previous = accountId === 'new' ? undefined
                : accountId ? findAccount(state, accountId) : activeAccount(state);
            const account = await authorize(BASE, state.hostId, previous,
                next => saveLogin(state, next), handler => { route = handler; });
            if (!canUsePlan(account.scope)) {
                throw new Error('账号已保存，订阅推理权限未开启。再次运行 login 并授权使用 ChatGPT 订阅。');
            }
            console.log('已授权 ChatGPT 账号 ' + (account.email ?? account.label) + '。下一步运行 node bridge/bridge.mjs serve。');
            if (!canUsePlan(previous?.scope)) {
                console.log('通过此连接发出的合格请求会计入 ChatGPT 订阅用量。管理用量：' + USAGE);
            }
            return;
        }

        route = createApi({ key: state.key, getAccessToken: createTokenProvider(state) });
        const account = activeAccount(state);
        console.log('当前账号：' + (account?.email ?? account?.label ?? '尚未登录'));
        console.log('TauriTavern 自定义端点：' + BASE + '/v1');
        console.log('另开 Termux 会话，在此目录运行 node bridge/bridge.mjs key 查看本机密钥。');
        console.log('ChatGPT 用量：' + USAGE + '\n保持服务运行。按 Ctrl+C 停止。');
        await untilStopped();
    } finally {
        stopping = true;
        // Keep the port until any rotating-token write has finished.
        if (command === 'serve') server.closeAllConnections();
        await Promise.allSettled([...pending]);
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (command === 'serve') server.closeAllConnections();
        await closed;
    }
}

async function saveLogin(state, account) {
    const previous = activeAccount(state);
    const activate = canUsePlan(account.scope) || !previous || previous.clientId === account.clientId;
    await replaceAccount(state, account, activate);
}

function untilStopped() {
    return new Promise(resolve => {
        function stop() {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            resolve();
        }
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}

async function authorize(base, hostId, previous, save, installRoute) {
    const attempt = makeAttempt(hostId, base + CALLBACK, previous);
    let claimed = false;
    const result = Promise.withResolvers();
    installRoute(async (req, res, url) => {
        if (req.method !== 'GET' || url.pathname !== CALLBACK) {
            throw new AppError(404, 'not_found', '此端点不存在。');
        }
        if (claimed) {
            callbackPage(res, 409, '已收到授权回调，请返回 Termux。');
            return;
        }
        if (url.searchParams.getAll('state').length !== 1
                || !equalSecret(url.searchParams.get('state'), attempt.state)) {
            callbackPage(res, 400, '此页面与当前登录请求不匹配，请返回最初打开的登录页。');
            return;
        }
        claimed = true;
        try {
            const account = await completeAttempt(attempt, url.searchParams, previous);
            await save(account);
            const message = canUsePlan(account.scope) ? '授权完成，可以返回 Termux。' : '已登录，请返回 Termux 查看如何开启订阅授权。';
            callbackPage(res, 200, message);
            result.resolve(account);
        } catch (error) {
            callbackPage(res, 400, '登录没有完成，请返回 Termux 查看结果。');
            result.reject(error);
        }
    });
    const timeout = setTimeout(() => {
        if (!claimed) {
            claimed = true;
            result.reject(new Error('登录等待超时。请重新运行 login。'));
        }
    }, 5 * 60_000);
    try {
        await sendToBrowser(attempt);
        return await result.promise;
    } finally {
        clearTimeout(timeout);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv.slice(2)).catch(error => {
        const message = error.code === 'EADDRINUSE'
            ? '端口 18765 已被占用。请先停止当前的桥接服务或登录进程。'
            : error.message;
        console.error(message);
        process.exitCode = 1;
    });
}
