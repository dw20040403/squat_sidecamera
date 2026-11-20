// 推論結果 → 統合 → 指標 の流れ。リアルタイム処理・オフライン処理・テストで共通に使う

import { DltFuser, type Fuser, type FuserCameras } from './fuser';
import { PoseBuffer, samplePoseAt, type SampleResult, type TimedPose } from './interp';
import { JOINT_INDICES, type Pose2D } from './landmarks';
import { computeAngles, roundAngles } from '../metrics/angles';
import type { FusionParams, MetricsParams, Params } from '../params';
import type { SessionFrame } from '../record/session';

/** 1フレーム分の統合と指標の計算 */
export function fuseFrame(
  fuser: Fuser,
  metricsParams: MetricsParams,
  t: number,
  main2d: Pose2D | null,
  sub2d: Pose2D | null,
): { frame: SessionFrame; joints: ReturnType<Fuser['process']> } {
  const fused = fuser.process({ t, main: main2d, sub: sub2d });
  const angles = roundAngles(computeAngles(fused.joints, metricsParams));
  return {
    frame: { t, main2d, sub2d, joints3d: fused.joints3d, angles, quality: fused.quality },
    joints: fused,
  };
}

export function sampleOptions(p: FusionParams) {
  return { maxPairGapMs: p.maxPairGapMs, maxExtrapMs: p.maxExtrapMs };
}

/**
 * 主端末と副端末のフレーム列（いずれも主時計・時刻順）から、セッションのフレーム列を作る。
 * オフライン処理で使う。副端末のデータはすべて揃っているので待ち時間はない。
 */
export function processSequence(
  mainFrames: readonly TimedPose[],
  subFrames: readonly TimedPose[],
  cams: FuserCameras,
  params: Pick<Params, 'fusion' | 'metrics'>,
  fuser: Fuser = new DltFuser(cams, params.fusion),
): SessionFrame[] {
  const opt = sampleOptions(params.fusion);
  // オフラインでは後ろのフレームも揃っているので、通常は補間になる（外挿は末尾だけ）
  return mainFrames.map((m) => {
    const s = samplePoseAt(subFrames, m.t, opt);
    return fuseFrame(fuser, params.metrics, m.t, m.pose, s.pose).frame;
  });
}

/** 記録済みの2Dデータ（main2d・補間後のsub2d）から統合と指標を計算し直す */
export function recomputeFrames(
  frames: readonly Pick<SessionFrame, 't' | 'main2d' | 'sub2d'>[],
  cams: FuserCameras,
  params: Pick<Params, 'fusion' | 'metrics'>,
  fuser: Fuser = new DltFuser(cams, params.fusion),
): SessionFrame[] {
  return frames.map((f) => fuseFrame(fuser, params.metrics, f.t, f.main2d, f.sub2d).frame);
}

export { JOINT_INDICES };

export interface ReadyFrame {
  main: TimedPose;
  sub: SampleResult;
}

/**
 * リアルタイム処理で、主端末のフレームを副端末のデータが届くまで待たせる（最大fusionDelayMs）。
 * 待つ時間の基準は主端末のフレーム時刻t_m（撮影時刻）とする：t_m + fusionDelayMs を過ぎたら処理する。
 */
export class FusionScheduler {
  readonly subBuffer = new PoseBuffer(2000);
  private queue: TimedPose[] = [];

  constructor(private p: FusionParams) {}

  pushMain(f: TimedPose): void {
    this.queue.push(f);
    // 古すぎるものは捨てる（処理が詰まった場合の保険）
    if (this.queue.length > 30) this.queue.splice(0, this.queue.length - 30);
  }

  pushSub(f: TimedPose): void {
    this.subBuffer.push(f);
  }

  /** 処理できるようになった主端末のフレームを、時刻順に返す */
  poll(now: number): ReadyFrame[] {
    const out: ReadyFrame[] = [];
    const opt = sampleOptions(this.p);
    while (this.queue.length) {
      const m = this.queue[0];
      const latest = this.subBuffer.latestT;
      const hasAfter = latest !== null && latest >= m.t;
      if (!hasAfter && now < m.t + this.p.fusionDelayMs) break;
      this.queue.shift();
      out.push({ main: m, sub: this.subBuffer.sample(m.t, opt) });
    }
    return out;
  }

  clear(): void {
    this.queue = [];
    this.subBuffer.clear();
  }

  get pending(): number {
    return this.queue.length;
  }
}
