export function mountOfficialWindow(root, api, authorized) {
  root.innerHTML = '<p role="status">正在连接 QQ 窗口…</p><div data-display style="width:100%;height:min(70vh,640px)"></div><button class="btn g s" type="button" data-reconnect>重新连接窗口</button>';
  const hint = root.querySelector('[role=status]');
  const view = root.querySelector('[data-display]');
  const button = root.querySelector('[data-reconnect]');
  let client;
  let stopped = false;
  let timer;
  let poll;
  let generation = 0;
  function disconnect() {
    generation++;
    clearTimeout(timer);
    const old = client;
    client = null;
    old?.disconnect();
    view.replaceChildren();
  }
  function cleanup() {
    stopped = true;
    clearInterval(poll);
    disconnect();
    observer.disconnect();
    window.removeEventListener('pagehide', cleanup);
  }
  function confirmed() {
    disconnect();
    view.hidden = true;
    button.hidden = true;
    hint.textContent = '已登录';
    clearInterval(poll);
  }
  async function connect() {
    disconnect();
    const current = generation;
    button.disabled = true;
    view.hidden = false;
    hint.textContent = '正在连接 QQ 窗口…';
    try {
      const { default: RFB } = await import('/novnc/core/rfb.js');
      const { ticket } = await api('POST', '/api/official-login/display/ticket', {});
      if (stopped || current !== generation) return;
      const endpoint = new URL('/api/official-login/display', location.href);
      endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      endpoint.searchParams.set('ticket', ticket);
      client = new RFB(view, endpoint.href);
      client.scaleViewport = true;
      timer = setTimeout(() => {
        if (current !== generation) return;
        disconnect();
        hint.textContent = 'QQ 窗口连接超时';
      }, 10000);
      client.addEventListener('connect', () => {
        if (current !== generation) return;
        clearTimeout(timer);
        hint.textContent = '';
      }, { once: true });
      client.addEventListener('disconnect', (event) => {
        if (current !== generation) return;
        disconnect();
        hint.textContent = event.detail?.clean ? '窗口已断开' : 'QQ 窗口传输失败';
      }, { once: true });
      client.addEventListener('securityfailure', (event) => {
        hint.textContent = event.detail?.reason || 'QQ 窗口认证失败';
      });
    } catch (error) {
      if (stopped || current !== generation) return;
      disconnect();
      hint.textContent = error?.message || String(error);
    } finally { if (!stopped) button.disabled = false; }
  }
  let polling = false;
  async function readState() {
    if (polling || stopped) return;
    polling = true;
    try {
      const status = await api('GET', '/api/official-login/frame');
      if (!stopped && status.state === 'confirmed') confirmed();
    } catch (error) {
      if (!stopped) hint.textContent = error?.message || String(error);
    } finally { polling = false; }
  }
  const observer = new MutationObserver(() => { if (!root.isConnected) cleanup(); });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pagehide', cleanup, { once: true });
  button.onclick = connect;
  if (authorized) confirmed();
  else {
    connect();
    poll = setInterval(readState, 2000);
  }
  return cleanup;
}
