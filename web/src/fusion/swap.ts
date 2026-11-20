// 副端末の左右の取り違えの判定（spec 5.5 手順3）

import { focalPx, type Camera } from './camera';
import { LM, LR_PAIRS, swapLeftRight, type Pose2D } from './landmarks';
import { triangulateDLT, reprojectionErrorPx } from './triangulate';
import { median, type Vec3 } from './math';

export interface UndistortedPose {
  /** 正規化座標と可視度 */
  pts: [number, number, number][];
  /** 元の画素座標（再投影誤差の計算用） */
  raw: Pose2D;
}

export interface PairTriangulation {
  /** 左右ペアの関節の再投影誤差の中央値（画素。1点の外れ値で判定が変わらないよう中央値にする） */
  err: number;
  n: number;
  /** 三角測量した左右ペアの関節（MediaPipeの番号） */
  points: Map<number, Vec3>;
}

/** 左右ペアの関節を三角測量し、再投影誤差の中央値を求める */
export function pairReprojError(
  main: UndistortedPose,
  sub: UndistortedPose,
  camMain: Camera,
  camSub: Camera,
  minVis: number,
): PairTriangulation {
  const errs: number[] = [];
  const points = new Map<number, Vec3>();
  for (const pair of LR_PAIRS) {
    for (const j of pair) {
      const a = main.pts[j];
      const b = sub.pts[j];
      if (a[2] < minVis || b[2] < minVis) continue;
      const X = triangulateDLT([
        { x: a[0], y: a[1], w: a[2], R: camMain.extr.R, t: camMain.extr.t },
        { x: b[0], y: b[1], w: b[2], R: camSub.extr.R, t: camSub.extr.t },
      ]);
      if (!X) continue;
      points.set(j, X);
      const e1 = reprojectionErrorPx(X, camMain, main.raw[j][0], main.raw[j][1]);
      const e2 = reprojectionErrorPx(X, camSub, sub.raw[j][0], sub.raw[j][1]);
      // カメラの後ろに出る＝明らかに誤った対応
      errs.push(!Number.isFinite(e1) || !Number.isFinite(e2) ? 10 * focalPx(camMain.intr) : (e1 + e2) / 2);
    }
  }
  return { err: errs.length ? median(errs) : Infinity, n: errs.length, points };
}

/**
 * 解剖学的なもっともらしさ（小さいほどもっともらしい）。
 * 足部（かかと→足先）の水平成分と、腰の左右軸（左腰→右腰）の水平成分のなす角の|cos|の平均。
 * 実際の体では足部は左右軸にほぼ直交する（つま先を開いても|cos|は0.5程度まで）。
 * 誤った対応では、左右の点が正中面に集まり、足部が左右軸とほぼ平行になる（|cos|≈1）。
 * 計算できなければnull。
 */
export function implausibility(points: Map<number, Vec3>): number | null {
  const hl = points.get(LM.leftHip);
  const hr = points.get(LM.rightHip);
  if (!hl || !hr) return null;
  const ax = [hr[0] - hl[0], hr[1] - hl[1]];
  const na = Math.hypot(ax[0], ax[1]);
  if (na < 1e-6) return null;
  const terms: number[] = [];
  for (const [heelI, toeI] of [
    [LM.leftHeel, LM.leftFootIndex],
    [LM.rightHeel, LM.rightFootIndex],
  ]) {
    const h = points.get(heelI);
    const t = points.get(toeI);
    if (!h || !t) continue;
    const f = [t[0] - h[0], t[1] - h[1]];
    const nf = Math.hypot(f[0], f[1]);
    if (nf < 1e-6) continue;
    terms.push(Math.abs((f[0] * ax[0] + f[1] * ax[1]) / (nf * na)));
  }
  return terms.length ? terms.reduce((a, b) => a + b, 0) / terms.length : null;
}

/** 正規化座標の姿勢の左右を入れ替える */
export function swapUndistorted(p: UndistortedPose): UndistortedPose {
  const pts = p.pts.map((x) => [...x] as [number, number, number]);
  for (const [a, b] of LR_PAIRS) {
    pts[a] = [...p.pts[b]] as [number, number, number];
    pts[b] = [...p.pts[a]] as [number, number, number];
  }
  return { pts, raw: swapLeftRight(p.raw) };
}

export interface SwapDecision {
  sub: UndistortedPose;
  swapped: boolean;
  errNoSwap: number;
  errSwap: number;
  /** 再投影誤差だけでは決められなかった */
  ambiguous: boolean;
}

/**
 * 副端末の左右を入れ替えた場合と入れ替えない場合で再投影誤差を比べ、小さいほうを返す。
 *
 * 2台が体の正中面に対して対称に近い配置（既定の正面の左右±45°）では、誤った対応も
 * 「その場で向きを変えた体」として幾何的に成り立ち、再投影誤差がほぼ0になる。
 * そこで、誤差の差がmarginPx未満のときは解剖学的なもっともらしさ（implausibility）で決め、
 * それでも決められなければ前のフレームの判定（prevSwapped）を引き継ぐ。
 */
export function decideSwap(
  main: UndistortedPose,
  sub: UndistortedPose,
  camMain: Camera,
  camSub: Camera,
  minVis: number,
  marginPx = 3,
  prevSwapped = false,
): SwapDecision {
  const swappedSub = swapUndistorted(sub);
  const e0 = pairReprojError(main, sub, camMain, camSub, minVis);
  const e1 = pairReprojError(main, swappedSub, camMain, camSub, minVis);
  const res = (swapped: boolean, ambiguous: boolean): SwapDecision => ({
    sub: swapped ? swappedSub : sub,
    swapped,
    errNoSwap: e0.err,
    errSwap: e1.err,
    ambiguous,
  });
  if (e1.n === 0) return res(false, false);
  if (e0.n === 0) return res(true, false);
  if (Math.abs(e0.err - e1.err) >= marginPx) return res(e1.err < e0.err, false);
  const p0 = implausibility(e0.points);
  const p1 = implausibility(e1.points);
  if (p0 !== null && p1 !== null && Math.abs(p0 - p1) > 0.1) return res(p1 < p0, true);
  return res(prevSwapped, true);
}
