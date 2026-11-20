/** One registration per method/path; no mirrored pathname list. */
export function createSessionRoutes(context) {
  const { kernel, capabilities, currentQrPayload, computePhase, login, stream, instance } = context;
  return new Map([
    ['GET /health', async ({ send }) => send(200, { ok: true, mode: kernel.mode })],
    ["GET /api/status", async ({ url, request, body, send }) => {

      const status = kernel.status();
      const phase = computePhase(status);
      const report = capabilities();
      return send(200, {
        // 旧义不改：已授权且消息服务可用，旧读者用它做在线门禁。
        message_ready: Boolean(status.authorized && status.messageReady),
        // 新字段：消息服务的原始就绪位，不参与账号状态推断。
        message_service_ready: Boolean(status.messageReady),
        authorized: Boolean(status.authorized),
        account_state: status.accountState ?? (status.authorized ? 'authorized' : 'unknown'),
        msf_status: Number(status.msf ?? 0),
        self_id: status.authorized ? Number(kernel.uin) : 0,
        // 账号本次登录的起始时间（毫秒），控制台据此显示持续在线时长。
        login_at: Number((status && status.loginAt) || 0),
        nickname: status.nick,
        avatar: status.avatar,
        version: kernel.version,
        phase,
        login_mode: login.enabled ? 'active' : 'passive',
        qr_ready: Boolean(kernel.currentQr() && !kernel.currentQr().expired),
        mode: kernel.mode,
        contract: 3,
        instance,
        capabilities: report.capabilities,
        features: report.features,
        send_segments: report.sendSegments,
        recv_segments: report.recvSegments,
        download_segments: report.downloadSegments,
        outbound: typeof kernel.outboundStatus === 'function' ? kernel.outboundStatus() : null,
        ...(typeof kernel.diagnostics === 'function' ? { native_probe: kernel.diagnostics() } : {}),
        ...(Array.isArray(kernel.pendingNative) && kernel.pendingNative.length > 0
          ? { pending_native: kernel.pendingNative }
          : {}),
      });

    }],
    ["GET /api/qr", async ({ url, request, body, send }) => {

      const live = kernel.status();
      if (live.authorized && !live.online && !kernel.currentQr()?.picture) {
        return send(200, {
          state: 'none',
          seq: kernel.qrSeq ?? 0,
          refreshable: false,
          loginMode: login.enabled ? 'active' : 'passive',
          hint: '已授权，等待消息网络连接（MSF=' + Number(live.msf ?? 0) + '）；无需再次扫码',
          phase: 'authenticated',
        });
      }
      const payload = currentQrPayload();
      if (!payload.picture) {
        const waitingHint = login.enabled
          ? login.automatic ? '暂无二维码，运行时会在后台请求' : '请在 QQ 客户端登录，或手动获取二维码'
          : '请在 QQ 客户端登录';
        const hint = payload.state === 'scanned' ? payload.hint : payload.hint ?? waitingHint;
        return send(200, { ...payload, hint, phase: computePhase() });
      }
      return send(200, { ...payload, phase: computePhase(), login_mode: login.enabled ? 'active' : 'passive' });

    }],
    ["POST /api/login", async ({ url, request, body, send }) => {

      if (!kernel.login) return send(501, { error: '运行时未实现密码登录' });
      if (body.method === 'quick') {
        if (typeof kernel.quickLogin !== 'function') return send(501, { error: '运行时未实现快速登录' });
        try {
          await kernel.quickLogin(String(body.uin ?? ''));
          return send(202, { accepted: true });
        } catch (error) {
          return send(502, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (body.method !== 'password') return send(400, { error: 'method 只能是 password 或 quick' });
      try {
        await kernel.login({ method: 'password', uin: String(body.uin ?? ''), password: String(body.password ?? '') });
        return send(202, { accepted: true });
      } catch (error) {
        return send(502, { error: error instanceof Error ? error.message : String(error) });
      }

    }],
    ["POST /api/qr/refresh", async ({ url, request, body, send }) => {

      if (kernel.status().authorized && url.searchParams.get('force') !== '1') return send(409, { error: '账号已授权；如设备已被下线，请在账号页手动选择重新取码' });
      if (!login.enabled) return send(409, { error: '被动模式：请在 QQ 窗口刷新二维码' });
      try {
        const accepted = await login.request();
        return send(202, { accepted: Boolean(accepted) });
      } catch (error) {
        return send(503, { error: '主动取码失败（待实机验证）：' + (error instanceof Error ? error.message : String(error)) });
      }

    }],
    ["GET /api/events", async ({ url, request, body, send }) => {

      const after = Number(url.searchParams.get('after') ?? 0);
      return send(200, { ...stream.after(after), instance });

    }]
  ]);
}
