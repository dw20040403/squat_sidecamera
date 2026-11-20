// MediaPipe Pose Landmarker の33点に関する定数と型

/** 1点：[u, v, visibility]（u, vは画素座標・歪み補正前） */
export type Landmark2D = [number, number, number];
/** 33点 */
export type Pose2D = Landmark2D[];

export const NUM_LANDMARKS = 33;

export const LM = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

/** 3D統合の対象：鼻（0）と11〜32番（spec 5.5） */
export const JOINT_INDICES: number[] = [0, ...Array.from({ length: 22 }, (_, i) => 11 + i)];

/** 左右の取り違えの補正に使う左右ペア（肩・肘・手首・腰・膝・足首・かかと・足先） */
export const LR_PAIRS: [number, number][] = [
  [11, 12],
  [13, 14],
  [15, 16],
  [23, 24],
  [25, 26],
  [27, 28],
  [29, 30],
  [31, 32],
];

/** 異常検知で必須とする関節（肩・腰・膝・足首・かかと・足先） */
export const REQUIRED_JOINTS: number[] = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

/** 描画用の骨（棒）。side: L=左, R=右, C=中央 */
export const BONES: { a: number; b: number; side: 'L' | 'R' | 'C' }[] = [
  { a: 11, b: 12, side: 'C' },
  { a: 23, b: 24, side: 'C' },
  { a: 11, b: 23, side: 'L' },
  { a: 12, b: 24, side: 'R' },
  { a: 11, b: 13, side: 'L' },
  { a: 13, b: 15, side: 'L' },
  { a: 12, b: 14, side: 'R' },
  { a: 14, b: 16, side: 'R' },
  { a: 23, b: 25, side: 'L' },
  { a: 25, b: 27, side: 'L' },
  { a: 27, b: 29, side: 'L' },
  { a: 29, b: 31, side: 'L' },
  { a: 27, b: 31, side: 'L' },
  { a: 24, b: 26, side: 'R' },
  { a: 26, b: 28, side: 'R' },
  { a: 28, b: 30, side: 'R' },
  { a: 30, b: 32, side: 'R' },
  { a: 28, b: 32, side: 'R' },
];

/** 関節の左右（描画の色分け） */
export function jointSide(i: number): 'L' | 'R' | 'C' {
  if (i === 0) return 'C';
  if (i >= 1 && i <= 10) return i % 2 === 1 ? 'L' : 'R';
  return i % 2 === 1 ? 'L' : 'R';
}

/** 平坦な配列 [u0,v0,vis0,...]（6.1節）→ Pose2D */
export function fromFlat(lm: ArrayLike<number> | null | undefined): Pose2D | null {
  if (!lm || lm.length < NUM_LANDMARKS * 3) return null;
  const out: Pose2D = [];
  for (let i = 0; i < NUM_LANDMARKS; i++) out.push([lm[i * 3], lm[i * 3 + 1], lm[i * 3 + 2]]);
  return out;
}

/** Pose2D → 平坦な配列（送信用。小数点以下を丸めて通信量を減らす） */
export function toFlat(p: Pose2D | null): number[] | null {
  if (!p) return null;
  const out: number[] = [];
  for (const [u, v, vis] of p) out.push(round(u, 1), round(v, 1), round(vis, 3));
  return out;
}

export function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** 左右ペアを入れ替えたコピー */
export function swapLeftRight(p: Pose2D): Pose2D {
  const out = p.map((l) => [...l] as Landmark2D);
  for (const [a, b] of LR_PAIRS) {
    out[a] = [...p[b]] as Landmark2D;
    out[b] = [...p[a]] as Landmark2D;
  }
  return out;
}

/** 必須の関節がすべて可視度minVis以上か */
export function requiredVisible(p: Pose2D | null, minVis: number): boolean {
  if (!p) return false;
  return REQUIRED_JOINTS.every((i) => p[i][2] >= minVis);
}
