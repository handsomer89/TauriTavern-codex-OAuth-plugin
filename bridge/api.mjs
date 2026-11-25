import { once } from 'node:events';
import { AppError, equalSecret, RESOURCE } from './oauth.mjs';

const MAX_JSON = 24 * 1024 * 1024;
const TIMEOUT = 10 * 60_000;
const RESPONSES_FIELDS = ['model', 'input', 'instructions', 'reasoning', 'text', 'include'];
const TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);
const PLAN_ERRORS = {
    subscription_sharing_user_not_eligible: [403, '当前 ChatGPT 账号、工作区或策略不允许使用订阅额度。'],
    subscription_sharing_usage_limit_exceeded: [429, '订阅用量已达到限制。请在 ChatGPT → 设置 → 用量查看。'],
    subscription_sharing_usage_unavailable: [503, 'OpenAI 暂时无法检查订阅用量。请稍后重试。'],
    model_not_found: [404, '此模型对当前 ChatGPT 账号不可用。请重新连接并选择模型。'],
};

export function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}

export function errorResult(error) {
    if (error instanceof AppError) return { code: error.code, message: error.message };
    return { code: 'bridge_error', message: '本地桥接服务出错。' };
}

function upstreamError(code, status = 502) {
    const known = Object.hasOwn(PLAN_ERRORS, code) ? PLAN_ERRORS[code] : null;
    if (known) return new AppError(known[0], code, known[1]);
    if (status === 401) return new AppError(401, 'oauth_login_required', 'OpenAI 未接受当前登录凭据。请重新运行 login。');
    if (status === 429) return new AppError(429, 'upstream_rate_limit', 'OpenAI 请求达到限制。请在 ChatGPT 设置查看用量。');
    return new AppError(status >= 400 && status < 600 ? status : 502, 'openai_error',
        'OpenAI 无法完成请求（HTTP ' + status + '）。请确认所选模型支持此请求。');
}

export async function readBytes(req, max) {
    if (Number(req.headers['content-length']) > max) {
        throw new AppError(413, 'request_too_large', '请求体超出本地服务允许的大小。');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > max) throw new AppError(413, 'request_too_large', '请求体超出本地服务允许的大小。');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export function adaptResponses(input) {
    if (!input || typeof input.model !== 'string' || !input.model.trim() || !Array.isArray(input.input)) {
        throw new AppError(400, 'invalid_request', '请求必须包含模型 ID 和 Responses 格式的对话历史。');
    }
    if (input.tools?.length || input.tool_choice || input.previous_response_id
        || input.input.some(item => item?.type?.includes?.('call') || ['function', 'tool'].includes(item?.role))) {
        throw new AppError(400, 'unsupported_feature', '此版本支持普通聊天。请关闭工具、Agent 和联网搜索，并使用完整对话历史。');
    }
    const result = Object.fromEntries(RESPONSES_FIELDS.filter(key => input[key] != null).map(key => [key, input[key]]));
    result.input = input.input.map(item => item?.role === 'system' ? { ...item, role: 'developer' } : item);
    result.store = false;
    result.stream = true;
    return result;
}

async function* responseEvents(body) {
    const decoder = new TextDecoder();
    let line = '';
    let parts = [];
    let size = 0;
    for await (const chunk of body) {
        const lines = (line + decoder.decode(chunk, { stream: true })).split('\n');
        line = lines.pop();
        if (line.length > MAX_JSON) throw streamError();
        for (const raw of lines) {
            const current = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            if (!current && parts.length) {
                const data = parts.join('\n');
                parts = [];
                size = 0;
                if (data === '[DONE]') return;
                const event = JSON.parse(data);
                if (typeof event?.type !== 'string') throw streamError();
                yield event;
                if (TERMINAL.has(event.type)) return;
            } else if (current.startsWith('data:')) {
                const data = current.slice(5).replace(/^ /, '');
                size += data.length;
                if (size > MAX_JSON) throw streamError();
                parts.push(data);
            }
        }
    }
}

function streamError() {
    return new AppError(502, 'stream_interrupted', 'OpenAI 响应中断，未返回响应完成事件。');
}

function eventError(event) {
    if (event.type === 'response.incomplete') {
        return new AppError(502, 'response_incomplete', 'OpenAI 返回了未完成的响应。');
    }
    return upstreamError(event.response?.error?.code ?? event.code ?? event.error?.code);
}

async function writeEvent(res, event, signal) {
    if (!res.write('data: ' + JSON.stringify(event) + '\n\n')) await once(res, 'drain', { signal });
}

async function forwardResponses(res, upstream, listenStream, signal) {
    if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
        await upstream.body?.cancel().catch(() => {});
        throw streamError();
    }
    if (listenStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        res.flushHeaders();
    }
    try {
        for await (const event of responseEvents(upstream.body)) {
            if (event.type === 'response.completed') {
                if (!event.response || event.response.status !== 'completed') throw streamError();
                if (listenStream) {
                    await writeEvent(res, event, signal);
                    res.end();
                } else {
                    json(res, 200, event.response);
                }
                return;
            }
            if (TERMINAL.has(event.type)) throw eventError(event);
            if (listenStream) await writeEvent(res, event, signal);
        }
        throw streamError();
    } catch (error) {
        if (res.destroyed) return;
        const failure = error instanceof AppError ? error : streamError();
        if (!listenStream) throw failure;
        res.end('data: ' + JSON.stringify({ type: 'response.failed', response: { error: errorResult(failure) } }) + '\n\n');
    }
}

export function createApi({ key, getAccessToken, request = fetch }) {
    return async function api(req, res, url) {
        const route = req.method + ' ' + url.pathname;
        if (!['GET /v1/models', 'POST /v1/responses'].includes(route) || url.search) {
            throw new AppError(404, 'not_found', '此端点不存在。');
        }
        if (req.headers.origin || !equalSecret(req.headers.authorization, 'Bearer ' + key)) {
            throw new AppError(401, 'invalid_bridge_key', '请在 TauriTavern 填入 Termux 显示的本机密钥。');
        }

        const isModels = route === 'GET /v1/models';
        let input;
        let payload;
        if (!isModels) {
            const bytes = await readBytes(req, MAX_JSON);
            try {
                input = JSON.parse(bytes.toString('utf8'));
            } catch {
                throw new AppError(400, 'invalid_json', '请求正文不是有效的 JSON。');
            }
            payload = adaptResponses(input);
        }
        const disconnect = new AbortController();
        res.once('close', () => disconnect.abort());
        const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(TIMEOUT)]);

        async function call(token) {
            try {
                return await request(RESOURCE + (isModels ? '/models' : '/responses'), {
                    method: req.method,
                    redirect: 'error',
                    headers: {
                        Authorization: 'Bearer ' + token,
                        Accept: isModels ? 'application/json' : 'text/event-stream',
                        ...(isModels ? {} : { 'Content-Type': 'application/json' }),
                        'User-Agent': 'tauritavern_plus_bridge/0.1.1',
                    },
                    body: isModels ? undefined : JSON.stringify(payload),
                    signal,
                });
            } catch {
                throw new AppError(502, 'openai_network_error', '无法连接 OpenAI 推理接口，或请求已超时。');
            }
        }

        const token = await getAccessToken();
        let upstream = await call(token);
        if (upstream.status === 401) {
            await upstream.body?.cancel().catch(() => {});
            signal.throwIfAborted();
            upstream = await call(await getAccessToken(token));
        }
        if (!upstream.ok) {
            const data = await upstream.json().catch(() => null);
            throw upstreamError(data?.error?.code, upstream.status);
        }
        if (!isModels) return forwardResponses(res, upstream, input.stream === true, signal);

        const catalog = await upstream.json().catch(() => null);
        if (!Array.isArray(catalog?.models)) {
            throw new AppError(502, 'invalid_model_catalog', 'OpenAI 返回了无法读取的 ChatGPT 模型列表。');
        }
        const models = catalog.models.filter(model => model?.visibility === 'list' && typeof model.slug === 'string' && model.slug);
        json(res, 200, { object: 'list', data: models.map(model => ({
            id: model.slug, object: 'model', name: model.display_name ?? model.slug,
        })) });
    };
}
