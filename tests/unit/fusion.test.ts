import { describe, expect, it } from 'vitest';
import params from '../../config/params.json';
import layout from '../../config/layout.json';
import { DltFuser } from '../../web/src/fusion/fuser';
import { FusionScheduler, processSequence } from '../../web/src/fusion/pipeline';
import { computeAngles } from '../../web/src/metrics/angles';
import { JOINT_INDICES } from '../../web/src/fusion/landmarks';
import type { Params } from '../../web/src/params';
import { makeSequence, squatMotion } from '../synthetic/generator';

const P = params as unknown as Params;
const preset = layout.presets.find((p) => p.id === layout.default)!;
const NO_FILTER: Params = { ...P, fusion: { ...P.fusion, oneEuro: { minCutoff: 1e6, beta: 0, dCutoff: 1 } } };

function errors(seq: ReturnType<typeof makeSequence>, frames: ReturnType<typeof processSequence>) {
  const jointErr: number[] = [];
  const kneeErr: number[] = [];
  frames.forEach((f, i) => {
    const truth = seq.truth[i].joints;
    JOINT_INDICES.forEach((j, k) => {
      const X = f.joints3d[k];
      if (X) jointErr.push(Math.hypot(X[0] - truth[j][0], X[1] - truth[j][1], X[2] - truth[j][2]));
    });
    const ta = computeAngles(truth);
    for (const key of ['kneeFlexL', 'kneeFlexR'] as const) {
      if (f.angles[key] !== null) kneeErr.push(Math.abs(f.angles[key]! - ta[key]!));
    }
  });
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  return { joint: mean(jointErr), knee: mean(kneeErr), jointN: jointErr.length };
}

describe('3D統合（合成データ）', () => {
  it('ノイズなし：関節位置の誤差1mm未満（平滑化なし）', () => {
    const seq = makeSequence({ durationS: 3, layout: preset, noise: { sigmaPx: 0 }, subPhaseMs: 0 });
    const frames = processSequence(seq.main, seq.sub, seq.cams, NO_FILTER);
    const e = errors(seq, frames);
    expect(e.jointN).toBe(frames.length * JOINT_INDICES.length);
    expect(e.joint).toBeLessThan(0.001);
    expect(frames.every((f) => f.quality.reprojErrPx! < 0.01)).toBe(true);
  });

  it('ノイズ2px：関節位置の誤差がcmオーダー、膝の曲げ角度の誤差が±3°以内（平滑化なし）', () => {
    const seq = makeSequence({ durationS: 9, layout: preset, noise: { sigmaPx: 2 }, seed: 3 });
    const frames = processSequence(seq.main, seq.sub, seq.cams, NO_FILTER);
    const e = errors(seq, frames);
    expect(e.joint).toBeLessThan(0.03);
    expect(e.knee).toBeLessThan(3);
    // 平滑化ありでも大きく崩れない（遅れによる誤差の比較はレポートで行う）
    const ef = errors(seq, processSequence(seq.main, seq.sub, seq.cams, P));
    expect(ef.joint).toBeLessThan(0.03);
    expect(ef.knee).toBeLessThan(6);
  });

  it('体の向きが回っていても（yaw 30°）精度が保たれる', () => {
    const seq = makeSequence({
      durationS: 6,
      layout: preset,
      noise: { sigmaPx: 2 },
      seed: 9,
      motion: (t) => ({ ...squatMotion(t), yawDeg: 30 }),
    });
    const e = errors(seq, processSequence(seq.main, seq.sub, seq.cams, NO_FILTER));
    expect(e.joint).toBeLessThan(0.03);
    expect(e.knee).toBeLessThan(3);
  });

  it('副端末の左右の取り違えを補正する', () => {
    const seq = makeSequence({
      durationS: 6,
      layout: preset,
      noise: { sigmaPx: 1 },
      subNoise: { sigmaPx: 1, swapProb: 0.3 },
      seed: 5,
    });
    const frames = processSequence(seq.main, seq.sub, seq.cams, NO_FILTER);
    const swaps = frames.filter((f) => f.quality.swapApplied).length;
    expect(swaps).toBeGreaterThan(5);
    const e = errors(seq, frames);
    expect(e.joint).toBeLessThan(0.02);
    // 補正しない場合は大きく崩れる
    const noSwap = processSequence(seq.main, seq.sub, seq.cams, {
      ...NO_FILTER,
      fusion: { ...NO_FILTER.fusion, swapCorrection: false },
    });
    expect(errors(seq, noSwap).joint).toBeGreaterThan(e.joint * 2);
  });

  it('左右対称の配置（交差角30〜120°）でも、誤った左右の対応を選ばない', () => {
    for (const theta of [30, 60, 90, 120]) {
      const lay = {
        main: { azimuthDeg: -theta / 2, distanceM: 2.5, heightM: 1.0 },
        sub: { azimuthDeg: theta / 2, distanceM: 2.5, heightM: 1.0 },
      };
      const seq = makeSequence({
        durationS: 3,
        layout: lay,
        noise: { sigmaPx: 3 },
        subNoise: { sigmaPx: 3, swapProb: 0.2 },
        seed: theta,
      });
      const e = errors(seq, processSequence(seq.main, seq.sub, seq.cams, NO_FILTER));
      expect(e.joint, `交差角${theta}°`).toBeLessThan(0.04);
    }
  });

  it('欠損は最大300ms保持し、それを超えたらnull', () => {
    const seq = makeSequence({ durationS: 2, layout: preset, noise: { sigmaPx: 0.5 } });
    const fuser = new DltFuser(seq.cams, P.fusion);
    const t0 = seq.main[0].t;
    const first = fuser.process({ t: t0, main: seq.main[0].pose, sub: seq.main[0].pose && seq.sub[1].pose });
    expect(first.quality.validJoints).toBeGreaterThan(0);
    const held = fuser.process({ t: t0 + 250, main: null, sub: null });
    expect(held.joints[25]).not.toBeNull();
    expect(held.fresh[25]).toBe(false);
    const gone = fuser.process({ t: t0 + 400, main: null, sub: null });
    expect(gone.joints[25]).toBeNull();
  });

  it('再投影誤差がmaxReprojPxを超えた関節は無効', () => {
    const seq = makeSequence({ durationS: 1, layout: preset, noise: { sigmaPx: 0 }, subPhaseMs: 0 });
    const sub = seq.sub
      .find((s) => s.t === seq.main[0].t)!
      .pose!.map((p) => [...p] as [number, number, number]);
    sub[25] = [sub[25][0], sub[25][1] + 200, sub[25][2]]; // 左膝だけ大きくずらす
    const fuser = new DltFuser(seq.cams, P.fusion);
    const f = fuser.process({ t: seq.main[0].t, main: seq.main[0].pose, sub });
    expect(f.joints[25]).toBeNull();
    expect(f.jointErrPx[25]!).toBeGreaterThan(P.fusion.maxReprojPx);
    expect(f.joints[26]).not.toBeNull();
  });
});

describe('FusionScheduler', () => {
  const pose = makeSequence({ durationS: 0.1, layout: preset, noise: { sigmaPx: 0 } }).main[0].pose;

  it('副端末の後ろのフレームが届けばすぐ処理する', () => {
    const s = new FusionScheduler(P.fusion);
    s.pushSub({ t: 950, pose });
    s.pushMain({ t: 1000, pose });
    expect(s.poll(1010)).toHaveLength(0);
    s.pushSub({ t: 1040, pose });
    const r = s.poll(1060);
    expect(r).toHaveLength(1);
    expect(r[0].sub.mode).toBe('interp');
  });

  it('届かなければfusionDelayMsまで待ち、外挿または欠損にする', () => {
    const s = new FusionScheduler(P.fusion);
    s.pushSub({ t: 900, pose });
    s.pushSub({ t: 980, pose });
    s.pushMain({ t: 1000, pose });
    expect(s.poll(1100)).toHaveLength(0);
    const r = s.poll(1120);
    expect(r).toHaveLength(1);
    expect(r[0].sub.mode).toBe('extrap'); // 20ms先 ≤ 50ms
    s.pushMain({ t: 1100, pose });
    const r2 = s.poll(1300);
    expect(r2[0].sub.mode).toBe('none'); // 120ms先 > 50ms
  });
});
