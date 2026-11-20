// 指標の計算（spec 5.6）。純粋な関数

import { LM } from '../fusion/landmarks';
import { angleBetweenDeg, cross, deg, dot, mid, normalize, sub, type Vec3 } from '../fusion/math';
import type { MetricsParams } from '../params';

export const METRIC_KEYS = [
  'kneeFlexL',
  'kneeFlexR',
  'trunkLean',
  'toeOutL',
  'toeOutR',
  'kneeInL',
  'kneeInR',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type Angles = Record<MetricKey, number | null>;

export const METRIC_LABELS: Record<MetricKey, string> = {
  kneeFlexL: '膝の曲げ 左',
  kneeFlexR: '膝の曲げ 右',
  trunkLean: '体幹の前傾',
  toeOutL: 'つま先の開き 左',
  toeOutR: 'つま先の開き 右',
  kneeInL: '膝の入り込み 左',
  kneeInR: '膝の入り込み 右',
};

export const DEFAULT_METRICS_PARAMS: MetricsParams = { kneeInMinFlexDeg: 30, kneeInMinHorizM: 0.05 };

export interface BodyFrame {
  /** 被験者の右向き（水平） */
  xb: Vec3;
  /** 被験者の前向き（水平）= z × x_b */
  yb: Vec3;
  z: Vec3;
}

const Z: Vec3 = [0, 0, 1];
const horiz = (v: Vec3): Vec3 => [v[0], v[1], 0];

export function emptyAngles(): Angles {
  return {
    kneeFlexL: null,
    kneeFlexR: null,
    trunkLean: null,
    toeOutL: null,
    toeOutR: null,
    kneeInL: null,
    kneeInR: null,
  };
}

/** 体の座標系（5.6.1）。腰が欠損ならnull */
export function bodyFrame(J: (Vec3 | null)[]): BodyFrame | null {
  const l = J[LM.leftHip];
  const r = J[LM.rightHip];
  if (!l || !r) return null;
  const xb = normalize(horiz(sub(r, l)));
  if (!xb) return null;
  const yb = cross(Z, xb);
  return { xb, yb, z: Z };
}

/** 大腿（腰→膝）と下腿（膝→足首）のなす角 */
export function kneeFlex(hip: Vec3 | null, knee: Vec3 | null, ankle: Vec3 | null): number | null {
  if (!hip || !knee || !ankle) return null;
  return angleBetweenDeg(sub(knee, hip), sub(ankle, knee));
}

/** (x_b, y_b)成分 */
const toBody = (v: Vec3, bf: BodyFrame): [number, number] => [dot(v, bf.xb), dot(v, bf.yb)];

/** 7つの指標を計算する。Jは MediaPipe の番号で引ける33点（世界座標、m） */
export function computeAngles(J: (Vec3 | null)[], p: MetricsParams = DEFAULT_METRICS_PARAMS): Angles {
  const a = emptyAngles();
  a.kneeFlexL = kneeFlex(J[LM.leftHip], J[LM.leftKnee], J[LM.leftAnkle]);
  a.kneeFlexR = kneeFlex(J[LM.rightHip], J[LM.rightKnee], J[LM.rightAnkle]);

  const bf = bodyFrame(J);
  if (!bf) return a;

  // 体幹の前傾
  const ls = J[LM.leftShoulder];
  const rs = J[LM.rightShoulder];
  if (ls && rs) {
    const trunk = sub(mid(ls, rs), mid(J[LM.leftHip]!, J[LM.rightHip]!));
    const ang = angleBetweenDeg(trunk, Z);
    if (ang !== null) a.trunkLean = dot(trunk, bf.yb) >= 0 ? ang : -ang;
  }

  // つま先の開き・膝の内側への入り込み
  const side = (heelI: number, toeI: number, ankleI: number, kneeI: number, flex: number | null) => {
    const heel = J[heelI];
    const toe = J[toeI];
    if (!heel || !toe) return { toe: null, kneeIn: null };
    const [fx, fy] = toBody(sub(toe, heel), bf);
    if (Math.hypot(fx, fy) < 1e-6) return { toe: null, kneeIn: null };
    const theta = deg(Math.atan2(fx, fy));
    let phi: number | null = null;
    const ankle = J[ankleI];
    const knee = J[kneeI];
    if (ankle && knee && flex !== null && flex >= p.kneeInMinFlexDeg) {
      const [sx, sy] = toBody(sub(knee, ankle), bf);
      if (Math.hypot(sx, sy) >= p.kneeInMinHorizM) {
        phi = deg(Math.atan2(fx * sy - fy * sx, fx * sx + fy * sy));
      }
    }
    return { toe: theta, kneeIn: phi };
  };
  const R = side(LM.rightHeel, LM.rightFootIndex, LM.rightAnkle, LM.rightKnee, a.kneeFlexR);
  const L = side(LM.leftHeel, LM.leftFootIndex, LM.leftAnkle, LM.leftKnee, a.kneeFlexL);
  a.toeOutR = R.toe;
  a.toeOutL = L.toe === null ? null : -L.toe;
  a.kneeInR = R.kneeIn;
  a.kneeInL = L.kneeIn === null ? null : -L.kneeIn;
  return a;
}

/** 記録用に小数点以下1桁へ丸める */
export function roundAngles(a: Angles, digits = 1): Angles {
  const f = 10 ** digits;
  const out = emptyAngles();
  for (const k of METRIC_KEYS) {
    const v = a[k];
    out[k] = v === null || !Number.isFinite(v) ? null : Math.round(v * f) / f;
  }
  return out;
}

/** 表示用（小数点以下0桁、nullは「—」） */
export function formatAngle(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const r = Math.round(v);
  return `${r === 0 ? 0 : r}°`;
}

/**
 * 体の座標系のy_bを基準にしたカメラの方位角（度）。被験者の右回りを正（spec 5.4.4 測定中の確認）
 */
export function cameraAzimuthInBody(J: (Vec3 | null)[], cameraPos: Vec3): number | null {
  const bf = bodyFrame(J);
  if (!bf) return null;
  const c = sub(cameraPos, mid(J[LM.leftHip]!, J[LM.rightHip]!));
  const [x, y] = toBody(c, bf);
  if (Math.hypot(x, y) < 1e-6) return null;
  return deg(Math.atan2(x, y));
}
