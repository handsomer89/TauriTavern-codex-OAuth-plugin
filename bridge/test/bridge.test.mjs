import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { createApi } from '../api.mjs';
import { listen } from '../bridge.mjs';
import { AUTH, completeAttempt, makeAttempt, PLAN_SCOPE, refresh, RESOURCE, revoke } from '../oauth.mjs';
import { createTokenProvider } from '../state.mjs';

const scope = 'openid resource.invoke ' + PLAN_SCOPE;
const fakeClient = 'oaiapp_example';
const json = (data, status = 200) => Response.json(data, { status });
const key = 'local-test-key';
const localHeaders = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
const savedAccount = { clientId: fakeClient, sub: 'example-user', scope, refreshToken: 'old', expiresAt: 0 };

test('OAuth registers with PKCE, rejects bad state, verifies the signed identity, and refreshes and revokes with the issued client', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const redirect = 'http://127.0.0.1:18765/auth/callback';
    const attempt = makeAttempt('urn:uuid:123', redirect);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = {
        aud: fakeClient, iss: AUTH, sub: savedAccount.sub, nonce: attempt.nonce,
        exp: Math.floor(Date.now() / 1000) + 120, email_verified: true, email: 'user@example.test',
    };
    const jwt = overrides => {
        const message = encode({ alg: 'RS256', kid: 'fixture' }) + '.' + encode({ ...claims, ...overrides });
        return message + '.' + sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url');
    };
    const tokens = { access_token: 'access', refresh_token: 'renewable', expires_in: 1800, token_type: 'Bearer' };
    const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256' }] };
    let reportScope = scope;
    let idToken = jwt();
    let tokenCalls = 0;
    async function request(url, params) {
        if (url.endsWith('/jwks.json')) return json(jwks);
        assert.equal(params.redirect, 'error');
        assert.equal(params.body.get('client_id'), fakeClient);
        if (url.endsWith('/revoke')) {
            assert.equal(params.body.get('token'), 'replacement');
            return new Response('');
        }
        tokenCalls++;
        assert.equal(params.body.get('resource'), RESOURCE);
        if (params.body.get('grant_type') === 'refresh_token') {
            assert.equal(params.body.get('refresh_token'), 'renewable');
            return json({ ...tokens, access_token: 'new-access', refresh_token: 'replacement' });
        }
        assert.equal(params.body.get('redirect_uri'), redirect);
        assert.equal(createHash('sha256').update(params.body.get('code_verifier')).digest('base64url'),
            attempt.params.get('code_challenge'));
        return json({ ...tokens, id_token: idToken, scope: reportScope });
    }

    assert.equal(attempt.params.get('client_id'), 'dynamic_agent_client');
    assert.equal(attempt.params.get('code_challenge_method'), 'S256');
    const callback = new URLSearchParams({ state: attempt.state, code: 'authorization-code', client_id: fakeClient });
    await assert.rejects(completeAttempt(attempt, new URLSearchParams({ ...Object.fromEntries(callback), state: 'wrong' }), undefined, request),
        { code: 'oauth_state_mismatch' });
    assert.equal(tokenCalls, 0);
    const account = await completeAttempt(attempt, callback, undefined, request);
    assert.equal(account.sub, savedAccount.sub);
    assert.equal(account.email, 'user@example.test');
    assert.equal(account.accessToken, 'access');
    const renewed = await refresh(account, request);
    assert.equal(renewed.accessToken, 'new-access');
    assert.equal(renewed.scope, scope);
    assert.equal(await revoke(renewed, request), true);
    reportScope = 'openid';
    assert.equal((await completeAttempt(attempt, callback, undefined, request)).accessToken, undefined);
    idToken = jwt({ nonce: 'unrelated' });
    await assert.rejects(completeAttempt(attempt, callback, undefined, request), { code: 'oauth_tokens_invalid' });
    assert.equal(makeAttempt('urn:uuid:123', redirect, account).params.get('client_id'), fakeClient);
});

test('concurrent requests share one rotating refresh and reuse its replacement', async () => {
    const state = { active: fakeClient, accounts: [savedAccount] };
    const { promise, resolve } = Promise.withResolvers();
    let calls = 0;
    const getToken = createTokenProvider(state, {
        renew: async () => { calls++; return promise; },
        replace: async (state, account) => { state.accounts = [account]; },
    });
    const first = getToken();
    const second = getToken();
    resolve({ ...savedAccount, accessToken: 'renewed', refreshToken: 'replacement', expiresAt: Date.now() + 300_000 });
    assert.deepEqual(await Promise.all([first, second]), ['renewed', 'renewed']);
    assert.equal(await getToken('stale-access-token'), 'renewed');
    assert.equal(calls, 1);
});

async function fixture(t, request) {
    const auth = [];
    const api = createApi({
        key, request,
        getAccessToken: async rejected => {
            auth.push(rejected);
            return rejected ? 'refreshed' : 'oauth-access';
        },
    });
    const server = await listen(api, 0);
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    return { auth, base };
}

const completion = { type: 'response.completed', response: { status: 'completed', id: 'resp_1' } };
function eventStream(...events) {
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''),
        { headers: { 'Content-Type': 'text/event-stream' } });
}

test('loopback API checks the local key, lists account models, and serves streaming and JSON responses', async t => {
    let tries = 0;
    const { auth, base } = await fixture(t, async (url, options) => {
        if (url === RESOURCE + '/models') {
            if (++tries === 1) return json({}, 401);
            assert.equal(options.headers.Authorization, 'Bearer refreshed');
            return json({ models: [
                { visibility: 'hidden', slug: 'hidden' },
                { visibility: 'list', slug: 'example', display_name: 'Example Model' },
            ] });
        }
        assert.equal(options.headers.Authorization, 'Bearer oauth-access');
        assert.equal(url, RESOURCE + '/responses');
        assert.deepEqual(JSON.parse(options.body), {
            model: 'example', input: [{ type: 'message', role: 'developer', content: '规则' },
                { role: 'user', content: '你好' }], store: false, stream: true,
        });
        return eventStream({ type: 'response.output_text.delta', delta: '你好' }, completion);
    });
    assert.equal((await fetch(base + '/v1/models')).status, 401);
    assert.equal((await fetch(base + '/v1/models', { headers: { ...localHeaders, Origin: 'https://some-site.test' } })).status, 401);
    const models = await (await fetch(base + '/v1/models', { headers: localHeaders })).json();
    assert.deepEqual(models.data, [{ id: 'example', object: 'model', name: 'Example Model' }]);
    assert.deepEqual(auth, [undefined, 'oauth-access']);

    for (const stream of [true, false]) {
        const response = await fetch(base + '/v1/responses', {
            method: 'POST', headers: localHeaders,
            body: JSON.stringify({ model: 'example', input: [
                { type: 'message', role: 'system', content: '规则' }, { role: 'user', content: '你好' },
            ], stream, max_output_tokens: 100, temperature: 0.5, top_p: 0.9, store: true }),
        });
        assert.equal(response.status, 200);
        if (stream) {
            assert.match(response.headers.get('content-type'), /event-stream/);
            const events = await response.text();
            assert.match(events, /"delta":"你好"/);
            assert.match(events, /"type":"response.completed"/);
        } else {
            assert.deepEqual(await response.json(), completion.response);
        }
    }
});

test('failed and truncated upstream streams never report fabricated completion', async t => {
    const limit = 'subscription_sharing_usage_limit_exceeded';
    let calls = 0;
    const { base } = await fixture(t, async () => {
        calls++;
        if (calls === 2) return eventStream({ type: 'response.failed', response: { error: { code: limit } } });
        return eventStream({ type: 'response.output_text.delta', delta: 'partial' });
    });
    async function send(stream) {
        return fetch(base + '/v1/responses', {
            method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'example', input: [], stream }),
        });
    }
    const interrupted = await (await send(true)).text();
    assert.match(interrupted, /stream_interrupted/);
    assert.doesNotMatch(interrupted, /response.completed/);
    const failure = await send(false);
    assert.equal(failure.status, 429);
    assert.equal((await failure.json()).error.code, limit);
});
