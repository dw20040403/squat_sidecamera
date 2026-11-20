// カメラ配置の設定と確認（spec 5.4.4）。純粋な関数

import { cameraCenter, type Extrinsics } from '../fusion/camera';
import { deg } from '../fusion/math';
import type { LayoutCamera, LayoutConfig } from '../params';
import type { MeasuredLayout } from '../record/session';

/** 角度を(−180, 180]に収める */
export function wrapDeg(a: number): number {
  let x = ((((a + 180) % 360) + 360) % 360) - 180;
  if (x === -180) x = 180;
  return x;
}

/** 方位角・距離・高さ → 世界座標（被験者＝原点、正面＝+Y、右回りが正） */
export function layoutToPosition(c: LayoutCamera): [number, number, number] {
  const a = (c.azimuthDeg * Math.PI) / 180;
  return [c.distanceM * Math.sin(a), c.distanceM * Math.cos(a), c.heightM];
}

/** 世界座標のカメラ位置 → ボードの中心から見た方位角・距離・高さ */
export function positionToLayout(C: [number, number, number]): LayoutCamera {
  return { azimuthDeg: deg(Math.atan2(C[0], C[1])), distanceM: Math.hypot(C[0], C[1]), heightM: C[2] };
}

/** 水平面での交差角（2台の方位角の差） */
export function crossingAngleDeg(a: LayoutCamera, b: LayoutCamera): number {
  return Math.abs(wrapDeg(a.azimuthDeg - b.azimuthDeg));
}

/** 外部校正の結果から、実測の配置を求める */
export function measuredLayout(main: Extrinsics, sub: Extrinsics): MeasuredLayout {
  const m = positionToLayout(cameraCenter(main) as [number, number, number]);
  const s = positionToLayout(cameraCenter(sub) as [number, number, number]);
  return { main: m, sub: s, crossingAngleDeg: crossingAngleDeg(m, s) };
}

/** 配置への注意（測定は止めない） */
export function layoutWarnings(
  main: LayoutCamera,
  sub: LayoutCamera,
  cfg: Pick<LayoutConfig, 'crossingAngleRangeDeg'>,
): string[] {
  const w: string[] = [];
  const th = crossingAngleDeg(main, sub);
  const [lo, hi] = cfg.crossingAngleRangeDeg;
  if (th < lo || th > hi) w.push(`交差角が${th.toFixed(0)}°で、推奨の範囲（${lo}〜${hi}°）の外です`);
  const sa = Math.sign(Math.round(wrapDeg(main.azimuthDeg) * 10));
  const sb = Math.sign(Math.round(wrapDeg(sub.azimuthDeg) * 10));
  if (sa !== 0 && sa === sb) w.push('2台が被験者の同じ側にあります（反対側の脚が2台とも隠れやすくなります）');
  return w;
}

/** 設定と実測の差が許容範囲を超えた項目 */
export function compareLayout(
  planned: { main: LayoutCamera; sub: LayoutCamera },
  measured: MeasuredLayout,
  tol: LayoutConfig['tolerance'],
): {
  role: 'main' | 'sub';
  item: 'azimuthDeg' | 'distanceM' | 'heightM';
  planned: number;
  measured: number;
  diff: number;
}[] {
  const out: ReturnType<typeof compareLayout> = [];
  for (const role of ['main', 'sub'] as const) {
    const p = planned[role];
    const m = measured[role];
    const dA = wrapDeg(m.azimuthDeg - p.azimuthDeg);
    if (Math.abs(dA) > tol.azimuthDeg)
      out.push({ role, item: 'azimuthDeg', planned: p.azimuthDeg, measured: m.azimuthDeg, diff: dA });
    const dD = m.distanceM - p.distanceM;
    if (Math.abs(dD) > tol.distanceM)
      out.push({ role, item: 'distanceM', planned: p.distanceM, measured: m.distanceM, diff: dD });
    const dH = m.heightM - p.heightM;
    if (Math.abs(dH) > tol.heightM)
      out.push({ role, item: 'heightM', planned: p.heightM, measured: m.heightM, diff: dH });
  }
  return out;
}

/**
 * 三角測量の誤差の目安（m）。σは1台あたりの位置誤差（画素誤差×距離/焦点距離）、θは交差角。
 * 奥行き方向 σ/(√2·sin(θ/2))、直交方向 σ/(√2·cos(θ/2))
 */
export function triangulationErrorEstimate(
  sigmaPx: number,
  focalPx: number,
  distanceM: number,
  thetaDeg: number,
) {
  const s = (sigmaPx * distanceM) / focalPx;
  const h = (thetaDeg * Math.PI) / 360;
  return {
    sigmaM: s,
    depthM: s / (Math.SQRT2 * Math.max(Math.sin(h), 1e-6)),
    lateralM: s / (Math.SQRT2 * Math.max(Math.cos(h), 1e-6)),
  };
}
