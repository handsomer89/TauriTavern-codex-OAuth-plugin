const endpoint = 'http://127.0.0.1:18765/v1';
const form = document.getElementById('custom_form');
const source = document.getElementById('chat_completion_source');
const endpointInput = document.getElementById('custom_api_url_text');

if (form && source && endpointInput && !document.getElementById('tauritavern-plus-bridge')) {
    const panel = document.createElement('div');
    panel.id = 'tauritavern-plus-bridge';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.textContent = '填入本机 Plus 地址';

    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    const usage = document.createElement('a');
    usage.href = 'https://chatgpt.com/settings/usage';
    usage.target = '_blank';
    usage.rel = 'noopener noreferrer';
    usage.textContent = '管理 ChatGPT 用量';

    const streamOption = document.createElement('label');
    streamOption.className = 'checkbox_label';
    const streamInput = document.createElement('input');
    streamInput.type = 'checkbox';
    streamOption.append(streamInput, document.createTextNode('流式传输（普通聊天）'));
    const streamToggle = document.getElementById('stream_toggle');

    const updateVisibility = () => {
        panel.hidden = source.value !== 'custom_openai_responses';
        const localConnection = endpointInput.value.trim().replace(/\/+$/, '') === endpoint;
        usage.hidden = !localConnection;
        streamOption.hidden = !localConnection || !streamToggle;
        if (streamToggle) streamInput.checked = streamToggle.checked;
    };

    streamInput.addEventListener('change', () => {
        if (!streamToggle || streamOption.hidden || panel.hidden) return;
        streamToggle.checked = streamInput.checked;
        streamToggle.dispatchEvent(new Event('change', { bubbles: true }));
    });

    button.addEventListener('click', () => {
        if (source.value !== 'custom_openai_responses') return;
        endpointInput.value = endpoint;
        endpointInput.dispatchEvent(new Event('input', { bubbles: true }));
        const websocket = document.getElementById('custom_openai_responses_websocket');
        if (websocket?.checked) {
            websocket.checked = false;
            websocket.dispatchEvent(new Event('input', { bubbles: true }));
        }
        status.textContent = '填入伴侣 App 或 Termux 生成的本机密钥，再连接并选择模型。';
    });

    panel.append(button, streamOption, usage, document.createTextNode(' '), status);
    endpointInput.parentElement.after(panel);
    if (globalThis.jQuery) {
        globalThis.jQuery(source).on('change', updateVisibility);
        if (streamToggle) globalThis.jQuery(streamToggle).on('change', updateVisibility);
    } else {
        source.addEventListener('change', updateVisibility);
        streamToggle?.addEventListener('change', updateVisibility);
    }
    endpointInput.addEventListener('input', updateVisibility);
    updateVisibility();
}
