import { describe, expect, it } from 'vitest';
import board from '../../config/board.json';
import layoutCfg from '../../config/layout.json';
import { projectPoint, cameraCenter } from '../../web/src/fusion/camera';
import { solvePlanarPnP, type Correspondence } from '../../web/src/calib/pnp';
import {
  compareLayout,
  crossingAngleDeg,
  layoutWarnings,
  measuredLayout,
  triangulationErrorEstimate,
  wrapDeg,
} from '../../web/src/calib/layout';
import { gauss, lookAtCamera, rng, SYNTH_INTRINSICS } from '../synthetic/generator';
import type { Vec3 } from '../../web/src/fusion/math';

const corners = (): Vec3[] => board.markers.flatMap((m) => m.corners as Vec3[]);

describe('平面ボードの姿勢推定（自前のsolvePnP）', () => {
  for (const az of [-45, 45, 135]) {
    it(`方位角${az}°のカメラ`, () => {
      const cam = lookAtCamera(
        { azimuthDeg: az, distanceM: 2.5, heightM: 1.0 },
        SYNTH_INTRINSICS('x', true),
        [0, 0, 0],
      );
      const r = rng(az + 100);
      const corr: Correspondence[] = corners().map((X) => {
        const p = projectPoint(X, cam)!;
        return { X, u: p[0] + gauss(r) * 0.3, v: p[1] + gauss(r) * 0.3 };
      });
      const res = solvePlanarPnP(corr, cam.intr)!;
      expect(res.reprojErrPx).toBeLessThan(0.6);
      const C = cameraCenter(res.extr);
      const Ct = cameraCenter(cam.extr);
      expect(Math.hypot(C[0] - Ct[0], C[1] - Ct[1], C[2] - Ct[2])).toBeLessThan(0.05);
      // ボード上の点を三角測量に使う前提の精度：1cm程度
      const m = measuredLayout(res.extr, res.extr);
      expect(m.main.azimuthDeg).toBeCloseTo(az, 0);
    });
  }
});

describe('カメラ配置', () => {
  it('角度の正規化と交差角', () => {
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-180)).toBe(180);
    expect(
      crossingAngleDeg(
        { azimuthDeg: -45, distanceM: 1, heightM: 1 },
        { azimuthDeg: 45, distanceM: 1, heightM: 1 },
      ),
    ).toBe(90);
    expect(
      crossingAngleDeg(
        { azimuthDeg: 170, distanceM: 1, heightM: 1 },
        { azimuthDeg: -170, distanceM: 1, heightM: 1 },
      ),
    ).toBe(20);
  });
  it('注意：交差角が範囲外、同じ側', () => {
    const [front, side] = layoutCfg.presets;
    expect(layoutWarnings(front.main, front.sub, layoutCfg as never)).toEqual([]);
    const w = layoutWarnings(side.main, side.sub, layoutCfg as never);
    expect(w.some((x) => x.includes('同じ側'))).toBe(true);
    const w2 = layoutWarnings(
      { azimuthDeg: -20, distanceM: 2.5, heightM: 1 },
      { azimuthDeg: 20, distanceM: 2.5, heightM: 1 },
      layoutCfg as never,
    );
    expect(w2.some((x) => x.includes('交差角'))).toBe(true);
  });
  it('実測の配置と設定の比較', () => {
    const front = layoutCfg.presets[0];
    const a = lookAtCamera({ azimuthDeg: -43, distanceM: 2.45, heightM: 1.02 }, SYNTH_INTRINSICS('a'));
    const b = lookAtCamera({ azimuthDeg: 60, distanceM: 2.5, heightM: 1.0 }, SYNTH_INTRINSICS('b'));
    const m = measuredLayout(a.extr, b.extr);
    expect(m.main.azimuthDeg).toBeCloseTo(-43, 6);
    expect(m.main.distanceM).toBeCloseTo(2.45, 6);
    expect(m.crossingAngleDeg).toBeCloseTo(103, 6);
    const diffs = compareLayout(front, m, layoutCfg.tolerance);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ role: 'sub', item: 'azimuthDeg' });
  });
  it('誤差の目安', () => {
    const e = triangulationErrorEstimate(5, 1050, 2.5, 90);
    expect(e.depthM).toBeCloseTo(e.lateralM, 9);
    expect(e.depthM).toBeCloseTo((5 * 2.5) / 1050 / (Math.SQRT2 * Math.SQRT1_2), 9);
  });
});
