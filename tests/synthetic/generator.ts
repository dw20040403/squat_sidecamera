// 合成データの生成器：棒人間の3D骨格モデル、仮想カメラ、ノイズ・取り違え・欠損の付加

import { projectPoint, type Camera, type Intrinsics } from '../../web/src/fusion/camera';
import { LR_PAIRS, NUM_LANDMARKS, type Pose2D } from '../../web/src/fusion/landmarks';
import { add, cross, normalize, rad, sub, type Mat3, type Vec3 } from '../../web/src/fusion/math';
import type { LayoutCamera } from '../../web/src/params';
import type { TimedPose } from '../../web/src/fusion/interp';

/** 再現性のある乱数（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 標準正規分布 */
export function gauss(r: () => number): number {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SquatPose {
  /** 膝の曲げ角度（度） */
  kneeFlexDeg: number;
  /** 体幹の前傾（度） */
  trunkLeanDeg: number;
  /** つま先の開き（度、左右とも外向き正） */
  toeOutDeg: number;
  /** 膝の内側への変位（m、内向き正） */
  kneeInM: number;
  /** 体の向き（度）。0で+Y（ボードの前）を向く。正で右回り */
  yawDeg?: number;
  /** 体の位置（床面） */
  origin?: Vec3;
}

const DIM = {
  ankleZ: 0.08,
  shank: 0.42,
  thigh: 0.44,
  trunk: 0.5,
  stanceHalf: 0.15,
  hipHalf: 0.1,
  shoulderHalf: 0.19,
};

/** 体の座標系（x右、y前、z上）で33点を作り、yawと位置を適用する */
export function squatSkeleton(p: SquatPose): Vec3[] {
  const J: Vec3[] = new Array(NUM_LANDMARKS).fill(null).map(() => [0, 0, 0] as Vec3);
  const k = rad(p.kneeFlexDeg);
  const alpha = k * 0.45; // 下腿の前傾
  const beta = k - alpha; // 大腿の後傾（なす角＝alpha+beta＝κ）
  const lambda = rad(p.trunkLeanDeg);

  const leg = (sgn: 1 | -1) => {
    // sgn: +1 右、-1 左
    const toe = rad(p.toeOutDeg) * sgn; // 外向き：右足は+x側へ
    const fwd: Vec3 = [Math.sin(toe), Math.cos(toe), 0];
    const ankle: Vec3 = [sgn * DIM.stanceHalf, 0, DIM.ankleZ];
    const heel = add(ankle, add([fwd[0] * -0.06, fwd[1] * -0.06, 0], [0, 0, -0.05]));
    const toeP = add(ankle, add([fwd[0] * 0.17, fwd[1] * 0.17, 0], [0, 0, -0.06]));
    let knee = add(ankle, [
      fwd[0] * DIM.shank * Math.sin(alpha),
      fwd[1] * DIM.shank * Math.sin(alpha),
      DIM.shank * Math.cos(alpha),
    ]);
    knee = add(knee, [-sgn * p.kneeInM, 0, 0]);
    // 大腿：膝から上・後ろへ
    const hip: Vec3 = add(knee, [0, -DIM.thigh * Math.sin(beta), DIM.thigh * Math.cos(beta)]);
    hip[0] = sgn * DIM.hipHalf;
    return { ankle, heel, toeP, knee, hip };
  };
  const R = leg(1);
  const L = leg(-1);
  J[24] = R.hip;
  J[23] = L.hip;
  // 左右の腰の高さと前後をそろえる
  const hipY = (R.hip[1] + L.hip[1]) / 2;
  const hipZ = (R.hip[2] + L.hip[2]) / 2;
  J[24] = [DIM.hipHalf, hipY, hipZ];
  J[23] = [-DIM.hipHalf, hipY, hipZ];
  J[26] = R.knee;
  J[25] = L.knee;
  J[28] = R.ankle;
  J[27] = L.ankle;
  J[30] = R.heel;
  J[29] = L.heel;
  J[32] = R.toeP;
  J[31] = L.toeP;

  const hipMid: Vec3 = [0, hipY, hipZ];
  const up: Vec3 = [0, Math.sin(lambda), Math.cos(lambda)];
  const shMid = add(hipMid, [0, up[1] * DIM.trunk, up[2] * DIM.trunk]);
  J[12] = add(shMid, [DIM.shoulderHalf, 0, 0]);
  J[11] = add(shMid, [-DIM.shoulderHalf, 0, 0]);
  // 腕は前に伸ばす
  for (const [s, i] of [
    [1, 12],
    [-1, 11],
  ] as const) {
    const sh = J[i];
    J[i + 2] = add(sh, [0, 0.27, -0.03]); // 肘
    J[i + 4] = add(sh, [0, 0.52, -0.04]); // 手首
    J[i + 6] = add(J[i + 4], [s * 0.02, 0.07, 0]); // 17〜22（手）
    J[i + 8] = add(J[i + 4], [0, 0.08, 0.01]);
    J[i + 10] = add(J[i + 4], [-s * 0.02, 0.05, 0.02]);
  }
  // 顔
  const head = add(shMid, [0, up[1] * 0.2 + 0.08, up[2] * 0.2]);
  J[0] = head;
  for (let i = 1; i <= 10; i++) {
    const s = i % 2 === 1 ? -1 : 1; // 奇数が左
    J[i] = add(head, [s * 0.03 * (1 + (i % 3)), -0.02, 0.03 - 0.01 * i]);
  }

  // yawと位置
  const yaw = rad(p.yawDeg ?? 0);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const o = p.origin ?? [0, 0, 0];
  // 右回り（上から見て時計回り）を正：前向き(0,1)が(sin,cos)になる
  return J.map(([x, y, z]) => [o[0] + c * x + s * y, o[1] - s * x + c * y, o[2] + z] as Vec3);
}

/** スクワットの動き（膝の曲げ角度が周期的に0→maxFlex→0） */
export function squatMotion(tS: number, periodS = 3, maxFlexDeg = 100): SquatPose {
  const ph = (1 - Math.cos((2 * Math.PI * tS) / periodS)) / 2;
  const flex = 5 + (maxFlexDeg - 5) * ph;
  return { kneeFlexDeg: flex, trunkLeanDeg: 5 + 0.35 * flex, toeOutDeg: 15, kneeInM: 0.03 * ph };
}

export const SYNTH_INTRINSICS = (name: string, withDistortion = true): Intrinsics => ({
  deviceName: name,
  imageSize: [720, 1280],
  K: { fx: 1050, fy: 1050, cx: 362, cy: 641 },
  dist: withDistortion
    ? { k1: 0.08, k2: -0.15, p1: 0.0005, p2: -0.0003, k3: 0.05 }
    : { k1: 0, k2: 0, p1: 0, p2: 0, k3: 0 },
  rms: 0.3,
  date: '2026-11-18',
});

/** 方位角・距離・高さから、target（既定は腰の高さ）を向くカメラを作る */
export function lookAtCamera(lc: LayoutCamera, intr: Intrinsics, target: Vec3 = [0, 0, 0.8]): Camera {
  const a = rad(lc.azimuthDeg);
  const C: Vec3 = [lc.distanceM * Math.sin(a), lc.distanceM * Math.cos(a), lc.heightM];
  const zc = normalize(sub(target, C))!;
  const xc = normalize(cross(zc, [0, 0, 1]))!;
  const yc = cross(zc, xc);
  const R: Mat3 = [xc, yc, zc].map((r) => [...r]);
  const t = [0, 1, 2].map((i) => -(R[i][0] * C[0] + R[i][1] * C[1] + R[i][2] * C[2]));
  return { intr, extr: { R, t } };
}

export interface NoiseOptions {
  sigmaPx: number;
  visibility?: number;
  /** 副端末の左右を入れ替える確率 */
  swapProb?: number;
  /** フレームごとに未検出（null）にする確率 */
  dropProb?: number;
  /** 関節ごとに可視度を下げる確率 */
  lowVisProb?: number;
}

export function projectPose(J: Vec3[], cam: Camera, r: () => number, n: NoiseOptions): Pose2D | null {
  return projectPoseEx(J, cam, r, n).pose;
}

export function projectPoseEx(
  J: Vec3[],
  cam: Camera,
  r: () => number,
  n: NoiseOptions,
): { pose: Pose2D | null; swapped: boolean } {
  if (n.dropProb && r() < n.dropProb) return { pose: null, swapped: false };
  const out: Pose2D = J.map((X) => {
    const p = projectPoint(X, cam);
    if (!p) return [0, 0, 0];
    const vis = n.lowVisProb && r() < n.lowVisProb ? 0.2 : (n.visibility ?? 0.95);
    return [p[0] + gauss(r) * n.sigmaPx, p[1] + gauss(r) * n.sigmaPx, vis];
  });
  let swapped = false;
  if (n.swapProb && r() < n.swapProb) {
    for (const [a, b] of LR_PAIRS) [out[a], out[b]] = [out[b], out[a]];
    swapped = true;
  }
  return { pose: out, swapped };
}

export interface SyntheticSequence {
  truth: { t: number; joints: Vec3[] }[];
  main: TimedPose[];
  sub: TimedPose[];
  /** 副端末のフレームごとに、左右を入れ替えたか */
  subSwapped: boolean[];
  cams: { main: Camera; sub: Camera };
}

export interface SequenceOptions {
  durationS: number;
  layout: { main: LayoutCamera; sub: LayoutCamera };
  noise: NoiseOptions;
  subNoise?: NoiseOptions;
  seed?: number;
  /** フレーム間隔（ms） */
  mainIntervalMs?: number;
  subIntervalMs?: number;
  /** 副端末のフレーム時刻のずれ（ms）。補間で吸収する */
  subPhaseMs?: number;
  motion?: (tS: number) => SquatPose;
  distortion?: boolean;
  t0?: number;
}

/** スクワットの動きの合成データ。主・副の2D列と真値を作る */
export function makeSequence(o: SequenceOptions): SyntheticSequence {
  const r = rng(o.seed ?? 1);
  const cams = {
    main: lookAtCamera(o.layout.main, SYNTH_INTRINSICS('synth-main', o.distortion ?? true)),
    sub: lookAtCamera(o.layout.sub, SYNTH_INTRINSICS('synth-sub', o.distortion ?? true)),
  };
  const motion = o.motion ?? ((t: number) => squatMotion(t));
  const t0 = o.t0 ?? 1_763_366_400_000;
  const mi = o.mainIntervalMs ?? 100;
  const si = o.subIntervalMs ?? 100;
  const phase = o.subPhaseMs ?? 37;
  const truth: SyntheticSequence['truth'] = [];
  const main: TimedPose[] = [];
  const sub: TimedPose[] = [];
  const subSwapped: boolean[] = [];
  for (let tm = 0; tm <= o.durationS * 1000; tm += mi) {
    const J = squatSkeleton(motion(tm / 1000));
    truth.push({ t: t0 + tm, joints: J });
    main.push({ t: t0 + tm, pose: projectPose(J, cams.main, r, o.noise), w: 720, h: 1280 });
  }
  for (let ts = phase - si; ts <= o.durationS * 1000 + si; ts += si) {
    const J = squatSkeleton(motion(ts / 1000));
    const p = projectPoseEx(J, cams.sub, r, o.subNoise ?? o.noise);
    sub.push({ t: t0 + ts, pose: p.pose, w: 720, h: 1280 });
    subSwapped.push(p.swapped);
  }
  return { truth, main, sub, subSwapped, cams };
}
