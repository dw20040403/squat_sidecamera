// 測定中の異常の検知（spec 5.9）。時系列を与えると、中止の時刻と原因を返す純粋なロジック

import type { MonitorParams } from '../params';
import type { AbortInfo, AbortReason } from '../record/session';

export interface MonitorSample {
  /** 主時計（ms） */
  now: number;
  /** DataChannel（pose/ctrl）が開いているか */
  channelOpen: boolean;
  /** 最後に副端末の姿勢データを受け取った時刻（主時計）。まだならnull */
  lastSubPoseAt: number | null;
  /** 必須の関節の可視度がすべてminVisibility以上か（nullは判定なし） */
  mainRequiredVisible: boolean | null;
  subRequiredVisible: boolean | null;
  /** 再投影誤差の平均（px）。計算できなければnull */
  reprojErrPx: number | null;
  /** 主端末の処理fps、副端末のデータの受信レート */
  mainFps: number | null;
  subFps: number | null;
  /** 1秒ごとの監視用の往復時間（ms） */
  rttMs: number | null;
}

export const ABORT_MESSAGES: Record<AbortReason, string> = {
  'peer-timeout': '副端末との接続が切れたか、データが届きません',
  'low-visibility': '必須の関節（肩・腰・膝・足首・かかと・足先）が見えていません',
  'high-reproj': '再投影誤差が大きくなりました（カメラが動いたか、校正が合っていません）',
  'low-fps': '処理速度が低下しました',
  'high-rtt': '時刻同期の往復時間が長くなりました（通信が不安定です）',
  error: 'エラーが発生しました',
};

/** 条件が続いている時間を測る */
class Persist {
  private since: number | null = null;
  update(active: boolean, now: number): number {
    if (!active) {
      this.since = null;
      return 0;
    }
    if (this.since === null) this.since = now;
    return now - this.since;
  }
  reset(): void {
    this.since = null;
  }
}

export class AnomalyMonitor {
  private startedAt = 0;
  private vis = new Persist();
  private reproj = new Persist();
  private fps = new Persist();
  private rtt = new Persist();
  private closed = new Persist();
  private aborted: AbortInfo | null = null;

  constructor(private p: MonitorParams) {}

  start(now: number): void {
    this.startedAt = now;
    this.aborted = null;
    [this.vis, this.reproj, this.fps, this.rtt, this.closed].forEach((x) => x.reset());
  }

  get result(): AbortInfo | null {
    return this.aborted;
  }

  /** 新しい観測を与える。中止すべきならAbortInfoを返す（一度中止したら同じものを返し続ける） */
  update(s: MonitorSample): AbortInfo | null {
    if (this.aborted) return this.aborted;
    const p = this.p;
    const abort = (reason: AbortReason, detail: string): AbortInfo => {
      this.aborted = { reason, at: s.now, detail };
      return this.aborted;
    };

    // 1. 切断・データが届かない
    const closedFor = this.closed.update(!s.channelOpen, s.now);
    const lastPose = s.lastSubPoseAt ?? this.startedAt;
    const silentFor = s.now - Math.max(lastPose, this.startedAt);
    if (closedFor >= p.peerTimeoutS * 1000)
      return abort('peer-timeout', `DataChannelの切断が${(closedFor / 1000).toFixed(1)}秒続きました`);
    if (silentFor >= p.peerTimeoutS * 1000)
      return abort('peer-timeout', `副端末のデータが${(silentFor / 1000).toFixed(1)}秒届いていません`);

    // 2. 必須の関節の可視度
    const lowVis = s.mainRequiredVisible === false || s.subRequiredVisible === false;
    const visFor = this.vis.update(lowVis, s.now);
    if (visFor >= p.lowVisibilityS * 1000) {
      const which = [
        s.mainRequiredVisible === false ? '主カメラ' : '',
        s.subRequiredVisible === false ? '副カメラ' : '',
      ]
        .filter(Boolean)
        .join('・');
      return abort('low-visibility', `${which}で${(visFor / 1000).toFixed(1)}秒続きました`);
    }

    // 3. 再投影誤差
    const highErr = s.reprojErrPx !== null && s.reprojErrPx > p.maxReprojErrPx;
    const errFor = this.reproj.update(highErr, s.now);
    if (errFor >= p.highReprojS * 1000)
      return abort(
        'high-reproj',
        `平均${s.reprojErrPx!.toFixed(1)}px（しきい値${p.maxReprojErrPx}px）が${(errFor / 1000).toFixed(1)}秒続きました`,
      );

    // 4. 処理速度
    const lowFps = (s.mainFps !== null && s.mainFps < p.minFps) || (s.subFps !== null && s.subFps < p.minFps);
    const fpsFor = this.fps.update(lowFps, s.now);
    if (fpsFor >= p.lowFpsS * 1000)
      return abort(
        'low-fps',
        `主端末${fmt(s.mainFps)}fps・副端末${fmt(s.subFps)}fps（しきい値${p.minFps}fps）`,
      );

    // 5. 往復時間
    const highRtt = s.rttMs !== null && s.rttMs > p.maxRttMs;
    const rttFor = this.rtt.update(highRtt, s.now);
    if (rttFor >= p.highRttS * 1000)
      return abort('high-rtt', `往復時間${s.rttMs!.toFixed(0)}ms（しきい値${p.maxRttMs}ms）`);

    return null;
  }
}

const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(1));
