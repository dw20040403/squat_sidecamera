// 平面ボード（Z=0）の姿勢推定（solvePnPの自前実装）。OpenCV.jsが使えない場合に使う。純粋な関数
// 1) 歪み補正した正規化座標とボードのXYからホモグラフィーをDLTで求める
// 2) H = λ[r1 r2 t] を分解して初期値を作る
// 3) 画素の再投影誤差をレーベンバーグ・マーカート法で最小化する

import { projectPoint, undistortPixel, type Extrinsics, type Intrinsics } from '../fusion/camera';
import {
  cross,
  matrixToRodrigues,
  norm,
  orthonormalize,
  rodriguesToMatrix,
  solveLinear,
  symmetricEigen,
  type Mat3,
  type Vec3,
} from '../fusion/math';

export interface Correspondence {
  /** 世界座標（m） */
  X: Vec3;
  /** 画素座標（歪みあり） */
  u: number;
  v: number;
}

export interface PnpResult {
  extr: Extrinsics;
  /** 再投影誤差の平均（画素） */
  reprojErrPx: number;
  n: number;
}

/** 正規化座標(x,y)とボード座標(X,Y)からホモグラフィー（3×3）を求める */
export function homographyDLT(pts: { X: number; Y: number; x: number; y: number }[]): number[][] | null {
  if (pts.length < 4) return null;
  // 数値安定のため、ボード座標を正規化する
  const mx = pts.reduce((s, p) => s + p.X, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.Y, 0) / pts.length;
  const sc = Math.sqrt(2) / (pts.reduce((s, p) => s + Math.hypot(p.X - mx, p.Y - my), 0) / pts.length || 1);
  const AtA: number[][] = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const add = (r: number[]) => {
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) AtA[i][j] += r[i] * r[j];
  };
  for (const p of pts) {
    const X = (p.X - mx) * sc;
    const Y = (p.Y - my) * sc;
    add([-X, -Y, -1, 0, 0, 0, p.x * X, p.x * Y, p.x]);
    add([0, 0, 0, -X, -Y, -1, p.y * X, p.y * Y, p.y]);
  }
  const h = symmetricEigen(AtA).vectors[0];
  const Hn = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], h[8]],
  ];
  // 正規化を戻す：H = Hn · T、T = [[sc,0,-sc·mx],[0,sc,-sc·my],[0,0,1]]
  const T = [
    [sc, 0, -sc * mx],
    [0, sc, -sc * my],
    [0, 0, 1],
  ];
  return Hn.map((row) => [0, 1, 2].map((j) => row[0] * T[0][j] + row[1] * T[1][j] + row[2] * T[2][j]));
}

/** ホモグラフィーから初期の姿勢を求める */
export function poseFromHomography(H: number[][]): Extrinsics | null {
  const h1: Vec3 = [H[0][0], H[1][0], H[2][0]];
  const h2: Vec3 = [H[0][1], H[1][1], H[2][1]];
  const h3: Vec3 = [H[0][2], H[1][2], H[2][2]];
  let lambda = 2 / (norm(h1) + norm(h2));
  if (!Number.isFinite(lambda)) return null;
  // ボードがカメラの前にあるように符号を決める
  if (h3[2] * lambda < 0) lambda = -lambda;
  const r1: Vec3 = [h1[0] * lambda, h1[1] * lambda, h1[2] * lambda];
  const r2: Vec3 = [h2[0] * lambda, h2[1] * lambda, h2[2] * lambda];
  const r3 = cross(r1, r2);
  const Rcols: Mat3 = [
    [r1[0], r2[0], r3[0]],
    [r1[1], r2[1], r3[1]],
    [r1[2], r2[2], r3[2]],
  ];
  const R = orthonormalize(Rcols);
  return { R, t: [h3[0] * lambda, h3[1] * lambda, h3[2] * lambda] };
}

function residuals(params: number[], corr: Correspondence[], intr: Intrinsics): number[] {
  const R = rodriguesToMatrix([params[0], params[1], params[2]]);
  const extr = { R, t: [params[3], params[4], params[5]] };
  const r: number[] = [];
  for (const c of corr) {
    const p = projectPoint(c.X, { intr, extr });
    if (!p) {
      r.push(1e4, 1e4);
      continue;
    }
    r.push(p[0] - c.u, p[1] - c.v);
  }
  return r;
}

/** 画素の再投影誤差を最小化する（レーベンバーグ・マーカート法、数値微分） */
export function refinePose(
  init: Extrinsics,
  corr: Correspondence[],
  intr: Intrinsics,
  iterations = 50,
): Extrinsics {
  const rv = matrixToRodrigues(init.R);
  let x = [rv[0], rv[1], rv[2], init.t[0], init.t[1], init.t[2]];
  let r = residuals(x, corr, intr);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let mu = 1e-3;
  for (let it = 0; it < iterations; it++) {
    // ヤコビアン
    const J: number[][] = r.map(() => new Array<number>(6).fill(0));
    for (let k = 0; k < 6; k++) {
      const eps = k < 3 ? 1e-6 : 1e-6 * Math.max(1, Math.abs(x[k]));
      const xp = [...x];
      xp[k] += eps;
      const rp = residuals(xp, corr, intr);
      for (let i = 0; i < r.length; i++) J[i][k] = (rp[i] - r[i]) / eps;
    }
    const JtJ: number[][] = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const Jtr = new Array<number>(6).fill(0);
    for (let i = 0; i < r.length; i++) {
      for (let a = 0; a < 6; a++) {
        Jtr[a] += J[i][a] * r[i];
        for (let b = 0; b < 6; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + mu) + 1e-12 : v)));
      const dx = solveLinear(
        A,
        Jtr.map((v) => -v),
      );
      if (!dx) {
        mu *= 10;
        continue;
      }
      const xn = x.map((v, k) => v + dx[k]);
      const rn = residuals(xn, corr, intr);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        x = xn;
        r = rn;
        const rel = (cost - cn) / Math.max(cost, 1e-12);
        cost = cn;
        mu = Math.max(mu / 10, 1e-9);
        improved = true;
        if (rel < 1e-10) it = iterations;
        break;
      }
      mu *= 10;
    }
    if (!improved) break;
  }
  return { R: rodriguesToMatrix([x[0], x[1], x[2]]), t: [x[3], x[4], x[5]] };
}

export function meanReprojErrorPx(extr: Extrinsics, corr: Correspondence[], intr: Intrinsics): number {
  let s = 0;
  for (const c of corr) {
    const p = projectPoint(c.X, { intr, extr });
    s += p ? Math.hypot(p[0] - c.u, p[1] - c.v) : 1e4;
  }
  return corr.length ? s / corr.length : NaN;
}

/** 平面ボード（すべてZ=0）の対応点からカメラの姿勢を求める */
export function solvePlanarPnP(corr: Correspondence[], intr: Intrinsics): PnpResult | null {
  if (corr.length < 4) return null;
  if (corr.some((c) => Math.abs(c.X[2]) > 1e-6))
    throw new Error('solvePlanarPnP: ボードの点はZ=0である必要があります');
  const pts = corr.map((c) => {
    const [x, y] = undistortPixel(c.u, c.v, intr);
    return { X: c.X[0], Y: c.X[1], x, y };
  });
  const H = homographyDLT(pts);
  if (!H) return null;
  const init = poseFromHomography(H);
  if (!init) return null;
  const extr = refinePose(init, corr, intr);
  const reprojErrPx = meanReprojErrorPx(extr, corr, intr);
  return { extr: { ...extr, reprojErrPx }, reprojErrPx, n: corr.length };
}
