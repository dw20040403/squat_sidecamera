// WebRTCの接続（spec 5.2.3）。offerは主端末が作る。STUNは使わない（同一LAN内のhost候補だけ）
// カメラの使用許可を得てから作ること（iOSでは許可前のhost候補がmDNS名で隠されるため）
import { SignalingClient, type SignalMsg } from './signaling';
import type { CtrlMsg, PoseMsg } from './messages';

export type PeerState =
  'idle' | 'signaling' | 'waiting-peer' | 'connecting' | 'connected' | 'disconnected' | 'rejected';

export class PeerLink {
  readonly signaling: SignalingClient;
  private pc: RTCPeerConnection | null = null;
  private pose: RTCDataChannel | null = null;
  private ctrl: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  state: PeerState = 'idle';
  onState: (s: PeerState) => void = () => {};
  onPose: (m: PoseMsg) => void = () => {};
  onCtrl: (m: CtrlMsg) => void = () => {};
  /** 受信したpose/ctrlのバイト数（通信量の確認） */
  bytesIn = 0;
  bytesOut = 0;

  constructor(readonly role: 'main' | 'sub') {
    this.signaling = new SignalingClient(role);
    this.signaling.onMessage = (m) => void this.onSignal(m);
    this.signaling.onState = (s) => {
      if (s === 'rejected') this.setState('rejected');
      else if (s === 'open' && this.state === 'idle') this.setState('signaling');
    };
  }

  start(): void {
    this.setState('signaling');
    this.signaling.connect();
  }

  get channelsOpen(): boolean {
    return this.pose?.readyState === 'open' && this.ctrl?.readyState === 'open';
  }

  private setState(s: PeerState): void {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  private reset(): void {
    this.pose?.close();
    this.ctrl?.close();
    this.pc?.close();
    this.pc = null;
    this.pose = null;
    this.ctrl = null;
    this.pendingIce = [];
  }

  private createPc(): RTCPeerConnection {
    this.reset();
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    pc.onicecandidate = (e) =>
      this.signaling.send({ type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this.updateOpen();
      else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        this.setState('disconnected');
        // 主端末から作り直す
        if (this.role === 'main' && s === 'failed') setTimeout(() => void this.makeOffer(), 1000);
      }
    };
    pc.ondatachannel = (e) => this.attach(e.channel);
    return pc;
  }

  private attach(ch: RTCDataChannel): void {
    if (ch.label === 'pose') this.pose = ch;
    else if (ch.label === 'ctrl') this.ctrl = ch;
    ch.onopen = () => this.updateOpen();
    ch.onclose = () => {
      if (this.state === 'connected') this.setState('disconnected');
    };
    ch.onmessage = (e) => {
      const s = String(e.data);
      this.bytesIn += s.length;
      let m: unknown;
      try {
        m = JSON.parse(s);
      } catch {
        return;
      }
      if (ch.label === 'pose') this.onPose(m as PoseMsg);
      else this.onCtrl(m as CtrlMsg);
    };
  }

  private updateOpen(): void {
    if (this.channelsOpen) this.setState('connected');
  }

  private async makeOffer(): Promise<void> {
    const pc = this.createPc();
    this.attach(pc.createDataChannel('pose', { ordered: false, maxRetransmits: 0 }));
    this.attach(pc.createDataChannel('ctrl'));
    this.setState('connecting');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.send({ type: 'offer', sdp: pc.localDescription!.sdp });
  }

  private async onSignal(m: SignalMsg): Promise<void> {
    switch (m.type) {
      case 'joined':
        if (m.peerPresent && this.role === 'main') await this.makeOffer();
        else this.setState('waiting-peer');
        break;
      case 'peer-joined':
        if (this.role === 'main') await this.makeOffer();
        break;
      case 'peer-left':
        this.reset();
        this.setState('waiting-peer');
        break;
      case 'offer': {
        if (this.role !== 'sub') return;
        const pc = this.createPc();
        this.setState('connecting');
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        this.signaling.send({ type: 'answer', sdp: pc.localDescription!.sdp });
        break;
      }
      case 'answer':
        if (this.pc && this.role === 'main') {
          await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
          for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
        }
        break;
      case 'ice':
        if (!m.candidate) return;
        if (this.pc && this.pc.remoteDescription) await this.pc.addIceCandidate(m.candidate).catch(() => {});
        else this.pendingIce.push(m.candidate);
        break;
      default:
        break;
    }
  }

  sendPose(m: PoseMsg): void {
    if (this.pose?.readyState !== 'open') return;
    // 送信待ちが溜まっていたら古いデータは捨てる
    if (this.pose.bufferedAmount > 64 * 1024) return;
    const s = JSON.stringify(m);
    this.bytesOut += s.length;
    this.pose.send(s);
  }

  sendCtrl(m: CtrlMsg): boolean {
    if (this.ctrl?.readyState !== 'open') return false;
    const s = JSON.stringify(m);
    this.bytesOut += s.length;
    this.ctrl.send(s);
    return true;
  }
}
