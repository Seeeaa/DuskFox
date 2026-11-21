/** HTTP transport has no account or login side effects. */
export class BridgeTransport {
  readonly endpoint: string;
  readonly token: string;
  constructor(endpoint: string, token: string) {
    this.endpoint = endpoint;
    this.token = token;
  }
  async request<T>(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token)
      headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined)
      headers['content-type'] = 'application/json';
    let response: Response;
    // Text sends are quick, but media (RichMedia upload) can take much longer;
    // a 5s cap made image sends look like a dead bridge.
    const fileDownload = path.startsWith('/api/media/probe') ||
      (path.startsWith('/api/media?') && new URL(path, 'http://bridge').searchParams.get('kind') === 'file');
    const timeoutMs = fileDownload ? 250000 : path.startsWith('/api/send') || path.startsWith('/api/media')
      ? 125000 : path.startsWith('/api/forward') || path.startsWith('/api/message') ? 35000 : 5000;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`桥接服务不可达：${this.endpoint}（${reason}）`);
    }
    if (!response.ok) {
      // Surface the runtime's own message (e.g. "密码错误") instead of a bare
      // status code; operators need the real reason.
      let detail = '';
      try {
        const body = (await response.json()) as {
          error?: unknown;
        };
        if (body && typeof body.error === 'string' && body.error)
          detail = '：' + body.error;
        if (body && typeof (body as {
          detail?: unknown;
        }).detail === 'string' && (body as {
          detail?: string;
        }).detail) {
          detail += '（' + String((body as {
            detail?: string;
          }).detail) + '）';
        }
      }
      catch {
        // Non-JSON error bodies keep the generic message.
      }
      throw new Error(`桥接服务返回 HTTP ${response.status}${detail}`);
    }
    return (await response.json()) as T;
  }
}
