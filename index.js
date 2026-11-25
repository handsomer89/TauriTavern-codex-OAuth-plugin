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

    const updateVisibility = () => {
        panel.hidden = source.value !== 'custom_openai_responses';
        usage.hidden = endpointInput.value.trim() !== endpoint;
    };

    button.addEventListener('click', () => {
        if (source.value !== 'custom_openai_responses') return;
        endpointInput.value = endpoint;
        endpointInput.dispatchEvent(new Event('input', { bubbles: true }));
        const websocket = document.getElementById('custom_openai_responses_websocket');
        if (websocket?.checked) {
            websocket.checked = false;
            websocket.dispatchEvent(new Event('input', { bubbles: true }));
        }
        status.textContent = '填入 Termux 生成的本机密钥，再点击「连接」并选择模型。';
    });

    panel.append(button, usage, document.createTextNode(' '), status);
    endpointInput.parentElement.after(panel);
    if (globalThis.jQuery) {
        globalThis.jQuery(source).on('change', updateVisibility);
    } else {
        source.addEventListener('change', updateVisibility);
    }
    endpointInput.addEventListener('input', updateVisibility);
    updateVisibility();
}
