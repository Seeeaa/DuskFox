export function createLoginPump(kernel, options, note, isHalted) {
  let qrRefreshEnabled = options.qrPump !== false;
  const autoQr = options.autoQr ?? (kernel.mode !== 'native');
  const qrCooldownMs = Number(options.qrCooldownMs ?? 90_000);
  let phase = 'starting';
  let lastQrRequest = 0;
  let qrInFlight = false;
  function currentQrPayload() {
    const qr = kernel.currentQr?.() ?? null;
    const loginMode = qrRefreshEnabled ? 'active' : 'passive';
    if (!qr) {
      return { state: phase === 'qr_failed' ? 'expired' : 'unavailable', seq: kernel.qrSeq ?? 0, loginMode, refreshable: qrRefreshEnabled };
    }
    if (qr.expired) {
      phase = 'qr_failed';
      return { state: 'expired', seq: qr.seq, loginMode, hint: '二维码已过期，请刷新' };
    }
    if (kernel.qrState === 'scanned') {
      return { state: 'scanned', seq: qr.seq, loginMode, hint: '已扫码，请在手机上确认登录' };
    }
    return {
      state: kernel.qrState === 'confirmed' ? 'confirmed' : 'waiting',
      picture: qr.picture,
      seq: qr.seq,
      expiresAt: qr.expiresAt,
      loginMode,
      refreshable: qrRefreshEnabled,
    };
  }

  function computePhase(status = kernel.status()) {
    if (status.online && (status.messageReady ?? true)) return 'online';
    // Authorised but the message network is not up yet: never fall back to QR.
    if (status.authorized) return 'authenticated';
    if (kernel.qrState === 'scanned') return 'confirm_on_phone';
    if (kernel.qrState === 'waiting') return 'scan_qr';
    if (kernel.qrState === 'confirmed') return 'authenticated';
    if (kernel.qrState === 'expired') return 'qr_failed';
    return 'waiting_login';
  }

  async function pumpQr() {
    if (isHalted() || !qrRefreshEnabled) return;
    const status = kernel.status();
    // Once the account is authorised there is nothing to scan; requesting more
    // codes only makes the console bounce back to the QR screen.
    if (status.online || status.authorized || status.accountState === 'signed_out') return;
    if (kernel.currentQr() && !kernel.currentQr().expired) return;
    if (qrInFlight) return;
    if (Date.now() - lastQrRequest < qrCooldownMs) return;
    qrInFlight = true;
    lastQrRequest = Date.now();
    try {
      const accepted = await kernel.requestQr();
      if (!accepted) note('主动取码未被接受');
    } catch (error) {
      note('主动取码失败（待实机验证）：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      qrInFlight = false;
    }
  }
  return {
    get enabled() { return qrRefreshEnabled; },
    set enabled(value) { qrRefreshEnabled = value; },
    get automatic() { return autoQr; },
    payload: currentQrPayload,
    phase(status) { phase = computePhase(status); return phase; },
    async request() { const accepted = await kernel.requestQr(); lastQrRequest = Date.now(); return accepted; },
    start() { const timer = autoQr ? setInterval(() => void pumpQr(), 3000) : null; timer?.unref?.(); return timer; },
  };
}
