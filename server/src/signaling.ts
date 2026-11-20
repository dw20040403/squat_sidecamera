// シグナリングのルーム管理（spec 5.2.2）。WebSocketに依存しないので単体テストできる

export type Role = 'main' | 'sub';

export interface Peer {
  send(msg: unknown): void;
  close(code?: number, reason?: string): void;
}

type ClientMsg =
  | { type: 'join'; role: Role }
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: unknown }
  | { type: 'ping' };

const isRole = (r: unknown): r is Role => r === 'main' || r === 'sub';
const other = (r: Role): Role => (r === 'main' ? 'sub' : 'main');

export class Room {
  private members = new Map<Role, Peer>();
  private roles = new Map<Peer, Role>();

  constructor(
    readonly name = 'default',
    private log: (msg: string) => void = () => {},
  ) {}

  roleOf(p: Peer): Role | undefined {
    return this.roles.get(p);
  }

  has(role: Role): boolean {
    return this.members.has(role);
  }

  /** 受け取ったメッセージ（文字列またはオブジェクト）を処理する */
  handle(peer: Peer, raw: unknown): void {
    let msg: ClientMsg;
    try {
      msg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ClientMsg;
    } catch {
      peer.send({ type: 'error', reason: 'bad-json' });
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      if (!isRole(msg.role)) {
        peer.send({ type: 'error', reason: 'bad-role' });
        return;
      }
      if (this.roles.has(peer)) {
        peer.send({ type: 'error', reason: 'already-joined' });
        return;
      }
      if (this.members.has(msg.role)) {
        // 同じ役割の2台目は後から来たほうを拒否する
        peer.send({ type: 'error', reason: 'role-taken' });
        this.log(`[signaling] reject ${msg.role}: role-taken`);
        return;
      }
      this.members.set(msg.role, peer);
      this.roles.set(peer, msg.role);
      const peerPresent = this.members.has(other(msg.role));
      peer.send({ type: 'joined', role: msg.role, peerPresent });
      if (peerPresent) this.members.get(other(msg.role))!.send({ type: 'peer-joined' });
      this.log(`[signaling] join ${msg.role} (peerPresent=${peerPresent})`);
      return;
    }

    if (msg.type === 'ping') {
      peer.send({ type: 'pong' });
      return;
    }

    const role = this.roles.get(peer);
    if (!role) {
      peer.send({ type: 'error', reason: 'not-joined' });
      return;
    }
    if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
      const target = this.members.get(other(role));
      if (target) target.send(msg);
      return;
    }
    peer.send({ type: 'error', reason: 'unknown-type' });
  }

  /** 切断されたとき */
  leave(peer: Peer): void {
    const role = this.roles.get(peer);
    if (!role) return;
    this.roles.delete(peer);
    if (this.members.get(role) === peer) this.members.delete(role);
    const o = this.members.get(other(role));
    if (o) o.send({ type: 'peer-left' });
    this.log(`[signaling] leave ${role}`);
  }
}
