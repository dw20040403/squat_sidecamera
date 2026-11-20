// 時刻同期（spec 5.3）。NTPと同じ方式の往復計測。DOMに依存しない

import { median } from '../fusion/math';
import type { ClockSyncParams } from '../params';

export interface SyncSample {
  offset: number;
  rtt: number;
}

export interface SyncReq {
  type: 'sync-req';
  t0: number;
  id: number;
  kind?: 'offset' | 'probe';
}
export interface SyncRes {
  type: 'sync-res';
  t0: number;
  t1: number;
  t2: number;
  id: number;
  kind?: 'offset' | 'probe';
}

/** offset = ((t1 − t0) + (t2 − t3)) / 2、rtt = (t3 − t0) − (t2 − t1) */
export function syncSample(t0: number, t1: number, t2: number, t3: number): SyncSample {
  return { offset: (t1 - t0 + (t2 - t3)) / 2, rtt: t3 - t0 - (t2 - t1) };
}

/** 往復時間が小さいほうからbest回分のずれの中央値 */
export function estimateOffset(samples: SyncSample[], best: number): number | null {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, best));
  return median(s.map((x) => x.offset));
}

export function emaUpdate(prev: number, next: number, alpha: number): number {
  return prev + alpha * (next - prev);
}

/** 主端末側：sync-reqに応答する */
export function respondSync(req: SyncReq, t1: number, now: () => number): SyncRes {
  return { type: 'sync-res', t0: req.t0, t1, t2: now(), id: req.id, kind: req.kind };
}

export interface ClockSyncState {
  synced: boolean;
  /** 自分の時計に加えると主時計になる値（ms） */
  offset: number;
  /** 直近のずれ計測での往復時間の中央値 */
  rttMs: number | null;
  /** 1秒ごとの監視用の往復時間 */
  probeRttMs: number | null;
  samples: number;
}

export interface ClockSyncDeps {
  send: (m: SyncReq) => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

/** 副端末側：往復計測を行い、ずれを推定する */
export class ClockSyncClient {
  state: ClockSyncState = { synced: false, offset: 0, rttMs: null, probeRttMs: null, samples: 0 };
  onUpdate: (s: ClockSyncState) => void = () => {};
  private nextId = 1;
  private pending = new Map<number, { resolve: (s: SyncSample | null) => void; timer: unknown }>();
  private periodicTimer: unknown = null;
  private probeTimer: unknown = null;
  private running = false;
  private stopped = false;

  constructor(
    private p: ClockSyncParams,
    private d: ClockSyncDeps,
  ) {}

  /** 主時計に換算する */
  toMain(localMs: number): number {
    return localMs + this.state.offset;
  }

  handle(res: SyncRes): void {
    const t3 = this.d.now();
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    this.d.clearTimer(p.timer);
    p.resolve(syncSample(res.t0, res.t1, res.t2, t3));
  }

  private measure(kind: 'offset' | 'probe'): Promise<SyncSample | null> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = this.d.setTimer(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.p.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      this.d.send({ type: 'sync-req', t0: this.d.now(), id, kind });
    });
  }

  private async burst(n: number): Promise<SyncSample[]> {
    const out: SyncSample[] = [];
    for (let i = 0; i < n && !this.stopped; i++) {
      const s = await this.measure('offset');
      if (s) out.push(s);
    }
    return out;
  }

  /** 接続直後の初期同期（20回）。成功したらtrue */
  async initial(): Promise<boolean> {
    const samples = await this.burst(this.p.initialSamples);
    const off = estimateOffset(samples, this.p.initialBest);
    if (off === null) return false;
    const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, this.p.initialBest);
    this.state = {
      ...this.state,
      synced: true,
      offset: off,
      rttMs: median(best.map((s) => s.rtt)),
      samples: samples.length,
    };
    this.onUpdate(this.state);
    return true;
  }

  /** 定期的なずれの更新（5回計測し、中央値を指数移動平均で反映） */
  async periodic(): Promise<void> {
    const samples = await this.burst(this.p.periodicSamples);
    const off = estimateOffset(samples, samples.length);
    if (off === null) return;
    if (!this.state.synced) {
      this.state = { ...this.state, synced: true, offset: off };
    } else {
      this.state = { ...this.state, offset: emaUpdate(this.state.offset, off, this.p.emaAlpha) };
    }
    this.state.rttMs = median(samples.map((s) => s.rtt));
    this.state.samples += samples.length;
    this.onUpdate(this.state);
  }

  /** 監視用の往復時間の計測（ずれの更新には使わない） */
  async probe(): Promise<void> {
    const s = await this.measure('probe');
    this.state = { ...this.state, probeRttMs: s ? s.rtt : this.p.requestTimeoutMs };
    this.onUpdate(this.state);
  }

  async start(): Promise<void> {
    this.stop();
    this.stopped = false;
    this.running = true;
    this.state = { synced: false, offset: 0, rttMs: null, probeRttMs: null, samples: 0 };
    let ok = await this.initial();
    while (!ok && this.running) ok = await this.initial();
    if (!this.running) return;
    const loopPeriodic = () => {
      if (!this.running) return;
      void this.periodic().finally(() => {
        if (this.running) this.periodicTimer = this.d.setTimer(loopPeriodic, this.p.periodicIntervalS * 1000);
      });
    };
    const loopProbe = () => {
      if (!this.running) return;
      void this.probe().finally(() => {
        if (this.running) this.probeTimer = this.d.setTimer(loopProbe, this.p.rttProbeIntervalS * 1000);
      });
    };
    this.periodicTimer = this.d.setTimer(loopPeriodic, this.p.periodicIntervalS * 1000);
    loopProbe();
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.periodicTimer !== null) this.d.clearTimer(this.periodicTimer);
    if (this.probeTimer !== null) this.d.clearTimer(this.probeTimer);
    this.periodicTimer = this.probeTimer = null;
    for (const [, p] of this.pending) {
      this.d.clearTimer(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }
}
