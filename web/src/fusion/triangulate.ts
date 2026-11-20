// 重み付きDLT法による三角測量（N視点、正規化座標を入力、P = [R|t]）

import { projectPoint, type Camera } from './camera';
import { projectionMatrix, symmetricEigen, type Mat3, type Vec3 } from './math';

export interface DltView {
  /** 歪み補正済みの正規化座標 */
  x: number;
  y: number;
  /** 重み（可視度） */
  w: number;
  R: Mat3;
  t: number[];
}

/**
 * 重み付きDLT。各視点から2式（x·P3 − P1、y·P3 − P2）を作り、重みを掛けて
 * AᵀAの最小固有値に対応する固有ベクトルを解とする。
 */
export function triangulateDLT(views: DltView[]): Vec3 | null {
  if (views.length < 2) return null;
  const AtA: number[][] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const addRow = (r: number[]) => {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) AtA[i][j] += r[i] * r[j];
  };
  for (const v of views) {
    if (!(v.w > 0)) continue;
    const P = projectionMatrix(v.R, v.t);
    const r1 = [0, 1, 2, 3].map((k) => v.w * (v.x * P[2][k] - P[0][k]));
    const r2 = [0, 1, 2, 3].map((k) => v.w * (v.y * P[2][k] - P[1][k]));
    addRow(r1);
    addRow(r2);
  }
  const { vectors } = symmetricEigen(AtA);
  const h = vectors[0];
  if (Math.abs(h[3]) < 1e-12) return null;
  const X: Vec3 = [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
  if (!X.every(Number.isFinite)) return null;
  return X;
}

/** 再投影誤差（画素）：投影した点と観測した画素座標（歪みあり）の距離 */
export function reprojectionErrorPx(X: Vec3, cam: Camera, u: number, v: number): number {
  const p = projectPoint(X, cam);
  if (!p) return Infinity;
  return Math.hypot(p[0] - u, p[1] - v);
}
