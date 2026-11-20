import { describe, expect, it } from 'vitest';
import { PoseBuffer, samplePoseAt, type TimedPose } from '../../web/src/fusion/interp';
import { HoldLast, OneEuroFilter } from '../../web/src/fusion/filters';
import type { Pose2D } from '../../web/src/fusion/landmarks';

const P = (u: number, vis = 0.9): Pose2D =>
  Array.from({ length: 33 }, () => [u, 2 * u, vis] as [number, number, number]);
const opt = { maxPairGapMs: 150, maxExtrapMs: 50 };

describe('補間', () => {
  const frames: TimedPose[] = [
    { t: 0, pose: P(0, 0.9) },
    { t: 100, pose: P(10, 0.6) },
    { t: 400, pose: P(40) },
  ];
  it('前後のフレームから線形補間し、可視度は小さいほう', () => {
    const r = samplePoseAt(frames, 25, opt);
    expect(r.mode).toBe('interp');
    expect(r.pose![0][0]).toBeCloseTo(2.5);
    expect(r.pose![0][1]).toBeCloseTo(5);
    expect(r.pose![0][2]).toBeCloseTo(0.6);
  });
  it('時刻差が150msを超えたらnull', () => {
    expect(samplePoseAt(frames, 260, opt).pose).toBeNull();
  });
  it('後ろがなければ50msまで外挿', () => {
    const r = samplePoseAt(frames.slice(0, 2), 140, opt);
    expect(r.mode).toBe('extrap');
    expect(r.pose![0][0]).toBeCloseTo(14);
    expect(samplePoseAt(frames.slice(0, 2), 151, opt).pose).toBeNull();
  });
  it('バッファは順序が入れ替わっても時刻順に保つ', () => {
    const b = new PoseBuffer(1000);
    b.push({ t: 100, pose: P(1) });
    b.push({ t: 300, pose: P(3) });
    b.push({ t: 200, pose: P(2) });
    b.push({ t: 200, pose: P(9) });
    expect(b.all().map((f) => f.t)).toEqual([100, 200, 300]);
    b.push({ t: 1250, pose: P(4) });
    expect(b.all().map((f) => f.t)).toEqual([300, 1250]);
  });
});

describe('フィルタ', () => {
  it('One Euro：静止した値のノイズを減らす', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 5, dCutoff: 1 });
    let r = 1;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      const x = 1 + rnd();
      raw.push(x);
      out.push(f.filter(x, i * 100));
    }
    const sd = (a: number[]) => {
      const m = a.reduce((s, v) => s + v, 0) / a.length;
      return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
    };
    expect(sd(out.slice(20))).toBeLessThan(sd(raw.slice(20)) * 0.8);
  });
  it('欠損の保持', () => {
    const h = new HoldLast<number>(300);
    expect(h.update(5, 0).value).toBe(5);
    expect(h.update(null, 300)).toEqual({ value: 5, held: true });
    expect(h.update(null, 301).value).toBeNull();
  });
});
