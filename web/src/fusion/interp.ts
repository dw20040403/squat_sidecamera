// 時刻による2D姿勢の線形補間・外挿と、副端末のデータを貯めるバッファ

import { LR_PAIRS, swapLeftRight, type Landmark2D, type Pose2D } from './landmarks';

export interface TimedPose {
  /** 主時計の時刻（ms） */
  t: number;
  /** 未検出ならnull */
  pose: Pose2D | null;
  w?: number;
  h?: number;
  seq?: number;
}

export type SampleMode = 'interp' | 'extrap' | 'none';

export interface SampleResult {
  pose: Pose2D | null;
  mode: SampleMode;
}

/**
 * 2つのフレームの左右の対応を揃える。MediaPipeはフレームごとに左右を取り違えることがあり、
 * そのまま補間すると左右の点が混ざるため、bの左右を入れ替えたほうがaに近ければ入れ替える。
 */
export function alignLeftRight(a: Pose2D, b: Pose2D): Pose2D {
  let same = 0;
  let crossed = 0;
  for (const [l, r] of LR_PAIRS) {
    same +=
      Math.hypot(a[l][0] - b[l][0], a[l][1] - b[l][1]) + Math.hypot(a[r][0] - b[r][0], a[r][1] - b[r][1]);
    crossed +=
      Math.hypot(a[l][0] - b[r][0], a[l][1] - b[r][1]) + Math.hypot(a[r][0] - b[l][0], a[r][1] - b[l][1]);
  }
  return crossed < same ? swapLeftRight(b) : b;
}

/** 線形補間（s=0でa、s=1でb。s>1は外挿）。bの左右はaに揃える */
export function interpolatePose(a: Pose2D, bIn: Pose2D, s: number): Pose2D {
  const b = alignLeftRight(a, bIn);
  const out: Pose2D = [];
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    out.push([
      pa[0] + (pb[0] - pa[0]) * s,
      pa[1] + (pb[1] - pa[1]) * s,
      Math.min(pa[2], pb[2]),
    ] as Landmark2D);
  }
  return out;
}

export interface SampleOptions {
  /** 前後のフレームとの時刻差の上限（ms） */
  maxPairGapMs: number;
  /** 外挿する時間の上限（ms）。0なら外挿しない */
  maxExtrapMs: number;
}

/**
 * 時刻順に並んだフレーム列から、時刻tの姿勢を求める（純粋な関数）。
 * - tを前後から挟む2つ（それぞれ時刻差maxPairGapMs以内）があれば線形補間。可視度は小さいほう。
 * - 後ろのフレームがなければ、直前の2フレームからmaxExtrapMsまで線形外挿。
 * - それ以外はnull。
 */
export function samplePoseAt(frames: readonly TimedPose[], t: number, opt: SampleOptions): SampleResult {
  const none: SampleResult = { pose: null, mode: 'none' };
  if (frames.length === 0) return none;
  // 二分探索：t以上の最初のフレーム
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (frames[m].t < t) lo = m + 1;
    else hi = m;
  }
  const after = lo < frames.length ? frames[lo] : null;
  const before = lo > 0 ? frames[lo - 1] : null;

  if (after && after.t === t) return after.pose ? { pose: after.pose, mode: 'interp' } : none;

  if (after && before) {
    if (t - before.t > opt.maxPairGapMs || after.t - t > opt.maxPairGapMs) return none;
    if (!before.pose || !after.pose) return none;
    const s = (t - before.t) / (after.t - before.t);
    return { pose: interpolatePose(before.pose, after.pose, s), mode: 'interp' };
  }

  if (!after && before && opt.maxExtrapMs > 0) {
    if (t - before.t > opt.maxExtrapMs) return none;
    const prev = lo > 1 ? frames[lo - 2] : null;
    if (!prev || !prev.pose || !before.pose) return none;
    const dt = before.t - prev.t;
    if (!(dt > 0) || dt > opt.maxPairGapMs) return none;
    const s = (t - prev.t) / dt; // > 1
    return { pose: interpolatePose(prev.pose, before.pose, s), mode: 'extrap' };
  }
  return none;
}

/** 副端末の姿勢を時刻順に保持するリングバッファ（約2秒分） */
export class PoseBuffer {
  private frames: TimedPose[] = [];
  constructor(private spanMs = 2000) {}

  push(f: TimedPose): void {
    const n = this.frames.length;
    if (n === 0 || f.t > this.frames[n - 1].t) this.frames.push(f);
    else {
      // 順序が入れ替わって届いた場合（ordered:false）は挿入する。同じ時刻は捨てる
      let i = n - 1;
      while (i >= 0 && this.frames[i].t > f.t) i--;
      if (i >= 0 && this.frames[i].t === f.t) return;
      this.frames.splice(i + 1, 0, f);
    }
    const latest = this.frames[this.frames.length - 1].t;
    while (this.frames.length > 0 && this.frames[0].t < latest - this.spanMs) this.frames.shift();
  }

  get latestT(): number | null {
    return this.frames.length ? this.frames[this.frames.length - 1].t : null;
  }

  get size(): number {
    return this.frames.length;
  }

  clear(): void {
    this.frames = [];
  }

  sample(t: number, opt: SampleOptions): SampleResult {
    return samplePoseAt(this.frames, t, opt);
  }

  all(): readonly TimedPose[] {
    return this.frames;
  }
}
