import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

export const AUTH = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const INVOKE_SCOPE = 'resource.invoke';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', INVOKE_SCOPE, PLAN_SCOPE];
const TOKEN_ENDPOINT = AUTH + '/api/accounts/oauth/token';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
export const APP_NAME = 'TauriTavern Plus Bridge';

export class AppError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function randomSecret() {
    return randomBytes(32).toString('base64url');
}

export function equalSecret(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function canUsePlan(scope) {
    const grants = String(scope ?? '').split(/\s+/);
    return grants.includes(PLAN_SCOPE) && grants.includes(INVOKE_SCOPE);
}

export function makeAttempt(hostId, redirect, account) {
    const state = randomSecret();
    const nonce = randomSecret();
    const verifier = randomSecret();
    const params = new URLSearchParams({
        client_id: account?.clientId ?? DYNAMIC_CLIENT,
        ext_agent_host_id: hostId,
        response_type: 'code',
        redirect_uri: redirect,
        resource: RESOURCE,
        scope: SCOPES.join(' '),
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
    });
    if (!account) params.set('agent_name_hint', APP_NAME);
    if (account?.idToken) params.set('id_token_hint', account.idToken);
    if (account?.email) params.set('login_hint', account.email);
    if (account && !canUsePlan(account.scope)) params.set('prompt', 'consent');
    return { state, nonce, verifier, redirect, params };
}

export async function completeAttempt(attempt, query, previous, request = fetch) {
    if (query.getAll('state').length !== 1 || !equalSecret(query.get('state'), attempt.state)) {
        throw new AppError(400, 'oauth_state_mismatch', 'OAuth 回调与本次登录不匹配。');
    }
    if (query.has('error')) {
        throw new AppError(403, 'oauth_declined', '登录或订阅授权未完成。可重新运行 login。');
    }
    const callbackClient = query.get('client_id');
    const clientId = previous?.clientId ?? callbackClient;
    const code = query.get('code');
    if (!code || query.getAll('code').length !== 1 || query.getAll('client_id').length > 1
            || !/^[\w-]{1,200}$/.test(clientId ?? '') || clientId === DYNAMIC_CLIENT
            || (query.has('client_id') && callbackClient !== clientId)) {
        throw new AppError(400, 'oauth_callback_invalid', 'OAuth 回调缺少有效的授权码或客户端 ID。');
    }
    const tokens = await exchange({
        grant_type: 'authorization_code', client_id: clientId, code,
        code_verifier: attempt.verifier, redirect_uri: attempt.redirect, resource: RESOURCE,
    }, request);
    const identity = await verifyIdToken(tokens.id_token, clientId, attempt.nonce, request);
    if (previous && identity.sub !== previous.sub) {
        throw new AppError(403, 'oauth_account_mismatch', '验证到的 ChatGPT 账号与所选记录不同。');
    }
    if (typeof tokens.scope !== 'string') throw invalidTokens();
    const account = {
        clientId, sub: identity.sub, email: identity.email_verified === true ? identity.email : undefined,
        idToken: tokens.id_token, scope: tokens.scope,
        label: previous?.label ?? ('账号 ' + clientId.slice(-8)),
    };
    if (!canUsePlan(account.scope)) {
        return { ...account, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined };
    }
    return { ...account, ...sessionFields(tokens) };
}

function invalidTokens() {
    return new AppError(502, 'oauth_tokens_invalid', 'OpenAI 返回了无效或不完整的登录凭据。请重新登录。');
}

function sessionFields(tokens) {
    if (typeof tokens.access_token !== 'string' || !tokens.access_token
            || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
            || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer'
            || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
        throw invalidTokens();
    }
    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
    };
}

async function exchange(form, request) {
    const response = await authRequest(TOKEN_ENDPOINT, request, form);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        if (['invalid_grant', 'invalid_client'].includes(data?.error)) {
            throw new AppError(401, 'oauth_login_required', 'OpenAI 无法继续此会话。请重新运行 login。');
        }
        throw new AppError(502, 'oauth_exchange_failed', 'OpenAI 暂时无法交换登录凭据（HTTP ' + response.status + '）。');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidTokens();
    return data;
}

async function authRequest(url, request, form) {
    try {
        return await request(url, {
            method: form ? 'POST' : 'GET',
            body: form ? new URLSearchParams(form) : undefined,
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(20_000),
        });
    } catch {
        throw new AppError(502, 'oauth_network_error', '无法连接 OpenAI 登录服务。请检查网络后重试。');
    }
}

export async function verifyIdToken(token, clientId, nonce, request = fetch) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || parts.some(part => !/^[\w-]+$/.test(part))) throw invalidTokens();
    let header;
    let claims;
    try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url'));
        claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    } catch {
        throw invalidTokens();
    }
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !claims) throw invalidTokens();
    const response = await authRequest(AUTH + '/.well-known/jwks.json', request);
    const jwks = response.ok ? await response.json().catch(() => null) : null;
    const jwk = Array.isArray(jwks?.keys) && jwks.keys.find(key => key?.kid === header.kid && key.kty === 'RSA'
        && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (!jwk) throw invalidTokens();
    let validSignature;
    try {
        validSignature = verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
            createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    } catch {
        throw invalidTokens();
    }
    const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    const now = Date.now() / 1000;
    if (!validSignature || claims.iss !== AUTH || !Array.isArray(audience) || !audience.includes(clientId)
            || ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== clientId)
            || !Number.isFinite(claims.exp) || claims.exp <= now
            || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30))
            || !equalSecret(claims.nonce, nonce) || typeof claims.sub !== 'string' || !claims.sub) {
        throw invalidTokens();
    }
    return claims;
}

export async function refresh(account, request = fetch) {
    const tokens = await exchange({
        grant_type: 'refresh_token', client_id: account.clientId,
        refresh_token: account.refreshToken, resource: RESOURCE,
    }, request);
    const scope = tokens.scope ?? account.scope;
    if (!canUsePlan(scope)) {
        return clearSession({ ...account, scope }, tokens.refresh_token ?? account.refreshToken);
    }
    return { ...account, ...sessionFields(tokens), scope };
}

export function clearSession(account, refreshToken) {
    const { accessToken, expiresAt, idToken, ...registration } = account;
    return { ...registration, refreshToken };
}

export async function revoke(account, request = fetch) {
    if (!account?.refreshToken) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await authRequest(AUTH + '/api/accounts/oauth/revoke', request, {
                token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId,
            });
            if (response.ok) return true;
            if (response.status < 500) return false;
        } catch {
            // Retry boundedly while the renewable token is still available.
        }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (2 ** attempt)));
    }
    return false;
}
