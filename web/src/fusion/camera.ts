// カメラモデル：内部パラメータ・外部パラメータ・歪み補正・投影

import { matVec3, transpose, type Mat3, type Vec3 } from './math';

export interface Intrinsics {
  deviceName: string;
  /** [幅, 高さ] */
  imageSize: [number, number];
  K: { fx: number; fy: number; cx: number; cy: number };
  dist: { k1: number; k2: number; p1: number; p2: number; k3: number };
  rms?: number;
  date?: string;
  /** 校正前の仮の値 */
  approximate?: boolean;
}

/** 世界→カメラ：x_cam = R·X + t */
export interface Extrinsics {
  R: Mat3;
  t: number[];
  reprojErrPx?: number;
}

export interface Camera {
  intr: Intrinsics;
  extr: Extrinsics;
}

/** 正規化座標に歪みを加える（OpenCVのモデル：k1,k2,k3の放射方向とp1,p2の接線方向） */
export function distortNormalized(x: number, y: number, d: Intrinsics['dist']): [number, number] {
  const r2 = x * x + y * y;
  const radial = 1 + ((d.k3 * r2 + d.k2) * r2 + d.k1) * r2;
  const xd = x * radial + 2 * d.p1 * x * y + d.p2 * (r2 + 2 * x * x);
  const yd = y * radial + d.p1 * (r2 + 2 * y * y) + 2 * d.p2 * x * y;
  return [xd, yd];
}

/** 画素座標（歪みあり）→ 歪みのない正規化座標（反復法。OpenCVのundistortPointsと同じ方式） */
export function undistortPixel(u: number, v: number, intr: Intrinsics, iterations = 20): [number, number] {
  const { fx, fy, cx, cy } = intr.K;
  const d = intr.dist;
  const xd = (u - cx) / fx;
  const yd = (v - cy) / fy;
  if (d.k1 === 0 && d.k2 === 0 && d.k3 === 0 && d.p1 === 0 && d.p2 === 0) return [xd, yd];
  let x = xd;
  let y = yd;
  for (let i = 0; i < iterations; i++) {
    const r2 = x * x + y * y;
    const icdist = 1 / (1 + ((d.k3 * r2 + d.k2) * r2 + d.k1) * r2);
    const dx = 2 * d.p1 * x * y + d.p2 * (r2 + 2 * x * x);
    const dy = d.p1 * (r2 + 2 * y * y) + 2 * d.p2 * x * y;
    const nx = (xd - dx) * icdist;
    const ny = (yd - dy) * icdist;
    if (Math.abs(nx - x) < 1e-12 && Math.abs(ny - y) < 1e-12) {
      x = nx;
      y = ny;
      break;
    }
    x = nx;
    y = ny;
  }
  return [x, y];
}

/** 歪みのない正規化座標 → 画素座標（歪みあり） */
export function normalizedToPixel(x: number, y: number, intr: Intrinsics): [number, number] {
  const [xd, yd] = distortNormalized(x, y, intr.dist);
  return [intr.K.fx * xd + intr.K.cx, intr.K.fy * yd + intr.K.cy];
}

export function worldToCamera(X: Vec3, extr: Extrinsics): Vec3 {
  const p = matVec3(extr.R, X);
  return [p[0] + extr.t[0], p[1] + extr.t[1], p[2] + extr.t[2]];
}

/** 世界座標 → 画素座標。カメラの後ろならnull */
export function projectPoint(X: Vec3, cam: Camera): [number, number] | null {
  const p = worldToCamera(X, cam.extr);
  if (p[2] <= 1e-9) return null;
  return normalizedToPixel(p[0] / p[2], p[1] / p[2], cam.intr);
}

/** カメラの位置 C = −Rᵀt */
export function cameraCenter(extr: Extrinsics): Vec3 {
  const Rt = transpose(extr.R) as Mat3;
  const c = matVec3(Rt, [extr.t[0], extr.t[1], extr.t[2]]);
  return [-c[0], -c[1], -c[2]];
}

/** カメラの光軸（世界座標での向き）＝ Rの3行目 */
export function cameraForward(extr: Extrinsics): Vec3 {
  return [extr.R[2][0], extr.R[2][1], extr.R[2][2]];
}

/** 内部パラメータの解像度が映像の解像度と一致するか */
export function sizeMatches(intr: Intrinsics, w: number, h: number): boolean {
  return intr.imageSize[0] === w && intr.imageSize[1] === h;
}

/** 画素あたりの焦点距離（fx, fyの平均）。正規化座標の誤差を画素に換算するのに使う */
export function focalPx(intr: Intrinsics): number {
  return (intr.K.fx + intr.K.fy) / 2;
}
