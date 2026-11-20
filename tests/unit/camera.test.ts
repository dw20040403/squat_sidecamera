import { describe, expect, it } from 'vitest';
import { cameraCenter, normalizedToPixel, projectPoint, undistortPixel } from '../../web/src/fusion/camera';
import { triangulateDLT } from '../../web/src/fusion/triangulate';
import { lookAtCamera, SYNTH_INTRINSICS } from '../synthetic/generator';
import type { Vec3 } from '../../web/src/fusion/math';

describe('カメラモデル', () => {
  const intr = SYNTH_INTRINSICS('t', true);

  it('歪みつき投影と歪み補正が往復で一致する', () => {
    for (const [x, y] of [
      [0, 0],
      [0.2, -0.3],
      [-0.33, 0.55],
      [0.3, 0.6],
    ]) {
      const [u, v] = normalizedToPixel(x, y, intr);
      const [x2, y2] = undistortPixel(u, v, intr);
      expect(x2).toBeCloseTo(x, 7);
      expect(y2).toBeCloseTo(y, 7);
    }
  });

  it('カメラの位置 C = −Rᵀt', () => {
    const cam = lookAtCamera({ azimuthDeg: -45, distanceM: 2.5, heightM: 1.0 }, intr);
    const C = cameraCenter(cam.extr);
    expect(C[0]).toBeCloseTo(-2.5 * Math.SQRT1_2, 9);
    expect(C[1]).toBeCloseTo(2.5 * Math.SQRT1_2, 9);
    expect(C[2]).toBeCloseTo(1.0, 9);
    // 注視点は画像の中心付近に写る
    const p = projectPoint([0, 0, 0.8], cam)!;
    expect(p[0]).toBeCloseTo(intr.K.cx, 6);
    expect(p[1]).toBeCloseTo(intr.K.cy, 6);
    // 上にある点は画像の上（vが小さい）に写る
    expect(projectPoint([0, 0, 1.5], cam)![1]).toBeLessThan(intr.K.cy);
  });

  it('投影 → 歪み補正 → 三角測量（ノイズなし）で誤差1mm未満', () => {
    const camA = lookAtCamera({ azimuthDeg: -45, distanceM: 2.5, heightM: 1.0 }, intr);
    const camB = lookAtCamera({ azimuthDeg: 45, distanceM: 2.5, heightM: 1.0 }, SYNTH_INTRINSICS('b', true));
    const pts: Vec3[] = [
      [0, 0, 0],
      [0.3, -0.2, 1.5],
      [-0.25, 0.4, 0.1],
      [0.1, 0.1, 1.7],
    ];
    for (const X of pts) {
      const views = [camA, camB].map((c) => {
        const [u, v] = projectPoint(X, c)!;
        const [x, y] = undistortPixel(u, v, c.intr);
        return { x, y, w: 1, R: c.extr.R, t: c.extr.t };
      });
      const Y = triangulateDLT(views)!;
      expect(Math.hypot(Y[0] - X[0], Y[1] - X[1], Y[2] - X[2])).toBeLessThan(0.001);
    }
  });
});
