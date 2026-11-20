// WSSシグナリングのクライアント（自動で再接続する）
export type SignalMsg =
  | { type: 'joined'; role: 'main' | 'sub'; peerPresent: boolean }
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'error'; reason: string }
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: RTCIceCandidateInit | null }
  | { type: 'pong' };

export class SignalingClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retryMs = 500;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  onMessage: (m: SignalMsg) => void = () => {};
  onState: (s: 'connecting' | 'open' | 'closed' | 'rejected') => void = () => {};
  rejected = false;

  constructor(
    private role: 'main' | 'sub',
    private url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.rejected = false;
    this.open();
  }

  private open(): void {
    this.onState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      this.onState('open');
      ws.send(JSON.stringify({ type: 'join', role: this.role }));
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 10_000);
    };
    ws.onmessage = (e) => {
      let m: SignalMsg;
      try {
        m = JSON.parse(String(e.data)) as SignalMsg;
      } catch {
        return;
      }
      if (m.type === 'error' && m.reason === 'role-taken') {
        this.rejected = true;
        this.onState('rejected');
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      this.onState('closed');
      if (!this.closedByUser) {
        // 同じ役割が使われている場合も、相手がいなくなるのを待って再試行する
        const wait = this.rejected ? 3000 : this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, 5000);
        setTimeout(() => !this.closedByUser && this.open(), wait);
      }
    };
    ws.onerror = () => ws.close();
  }

  send(m: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}
