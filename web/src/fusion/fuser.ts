// 3D統合：Fuserインターフェースと標準の実装DltFuser（spec 5.5 手順2〜7）

import { undistortPixel, type Camera } from './camera';
import { HoldLast, OneEuroFilter3 } from './filters';
import { JOINT_INDICES, NUM_LANDMARKS, type Pose2D } from './landmarks';
import type { Vec3 } from './math';
import { decideSwap, type UndistortedPose } from './swap';
import { reprojectionErrorPx, triangulateDLT } from './triangulate';
import type { FusionParams } from '../params';

export interface FuserInput {
  /** 主時計の時刻（ms） */
  t: number;
  main: Pose2D | null;
  /** 主端末の時刻に合わせて補間済みの副端末の姿勢 */
  sub: Pose2D | null;
}

export interface FusionQuality {
  /** 有効な関節の再投影誤差の平均（画素）。有効な関節がなければnull */
  reprojErrPx: number | null;
  validJoints: number;
  swapApplied: boolean;
}

export interface FusedFrame {
  t: number;
  /** MediaPipeの番号で引ける33点（対象外の関節と欠損はnull）。平滑化後 */
  joints: (Vec3 | null)[];
  /** JOINT_INDICESの順 */
  joints3d: (Vec3 | null)[];
  /** その関節が今回のフレームで直接三角測量されたか（保持した値ならfalse） */
  fresh: boolean[];
  /** 関節ごとの再投影誤差（画素）。計算しなかった関節はnull */
  jointErrPx: (number | null)[];
  quality: FusionQuality;
  /** 主端末の左右が入れ替わっていたか（現在は判定しない。将来用） */
  mainSwapApplied?: boolean;
}

/** 統合処理の抽象。将来EKFや骨長拘束つきの方式に差し替えられるようにする */
export interface Fuser {
  readonly name: string;
  process(input: FuserInput): FusedFrame;
  reset(): void;
}

export interface FuserCameras {
  main: Camera;
  sub: Camera;
}

function undistortPose(p: Pose2D, cam: Camera): UndistortedPose {
  return {
    pts: p.map(([u, v, vis]) => {
      const [x, y] = undistortPixel(u, v, cam.intr);
      return [x, y, vis] as [number, number, number];
    }),
    raw: p,
  };
}

export function emptyFrame(t: number): FusedFrame {
  return {
    t,
    joints: new Array<Vec3 | null>(NUM_LANDMARKS).fill(null),
    joints3d: JOINT_INDICES.map(() => null),
    fresh: new Array<boolean>(NUM_LANDMARKS).fill(false),
    jointErrPx: new Array<number | null>(NUM_LANDMARKS).fill(null),
    quality: { reprojErrPx: null, validJoints: 0, swapApplied: false },
  };
}

export class DltFuser implements Fuser {
  readonly name = 'dlt';
  private holds = new Map<number, HoldLast<Vec3>>();
  private filters = new Map<number, OneEuroFilter3>();

  constructor(
    private cams: FuserCameras,
    private p: FusionParams,
  ) {
    this.reset();
  }

  reset(): void {
    this.holds.clear();
    this.filters.clear();
    for (const j of JOINT_INDICES) {
      this.holds.set(j, new HoldLast<Vec3>(this.p.maxHoldMs));
      this.filters.set(j, new OneEuroFilter3(this.p.oneEuro));
    }
  }

  process(input: FuserInput): FusedFrame {
    const out = emptyFrame(input.t);
    const raw: (Vec3 | null)[] = new Array<Vec3 | null>(NUM_LANDMARKS).fill(null);

    if (input.main && input.sub) {
      // 手順2：歪み補正
      const um = undistortPose(input.main, this.cams.main);
      let us = undistortPose(input.sub, this.cams.sub);
      // 手順3：左右の取り違えの補正
      if (this.p.swapCorrection) {
        const d = decideSwap(
          um,
          us,
          this.cams.main,
          this.cams.sub,
          this.p.minVisibility,
          this.p.swapMarginPx ?? 3,
        );
        us = d.sub;
        out.quality.swapApplied = d.swapped;
      }
      // 手順4・5：三角測量と外れ値の判定
      const errs: number[] = [];
      for (const j of JOINT_INDICES) {
        const a = um.pts[j];
        const b = us.pts[j];
        if (a[2] < this.p.minVisibility || b[2] < this.p.minVisibility) continue;
        const X = triangulateDLT([
          { x: a[0], y: a[1], w: a[2], R: this.cams.main.extr.R, t: this.cams.main.extr.t },
          { x: b[0], y: b[1], w: b[2], R: this.cams.sub.extr.R, t: this.cams.sub.extr.t },
        ]);
        if (!X) continue;
        const e1 = reprojectionErrorPx(X, this.cams.main, um.raw[j][0], um.raw[j][1]);
        const e2 = reprojectionErrorPx(X, this.cams.sub, us.raw[j][0], us.raw[j][1]);
        const e = (e1 + e2) / 2;
        out.jointErrPx[j] = Number.isFinite(e) ? e : null;
        if (!(e <= this.p.maxReprojPx)) continue;
        raw[j] = X;
        errs.push(e);
      }
      out.quality.validJoints = errs.length;
      out.quality.reprojErrPx = errs.length ? errs.reduce((s, v) => s + v, 0) / errs.length : null;
    }

    // 手順6・7：欠損の補完と平滑化
    JOINT_INDICES.forEach((j, k) => {
      const h = this.holds.get(j)!.update(raw[j], input.t);
      const f = this.filters.get(j)!;
      if (h.value === null) {
        f.reset();
        out.joints[j] = null;
      } else {
        out.joints[j] = f.filter(h.value, input.t);
        out.fresh[j] = !h.held;
      }
      out.joints3d[k] = out.joints[j];
    });
    return out;
  }
}

/** 3D関節（JOINT_INDICESの順）→ MediaPipeの番号で引ける33点 */
export function jointsByIndex(joints3d: (Vec3 | null)[], jointIndices = JOINT_INDICES): (Vec3 | null)[] {
  const out = new Array<Vec3 | null>(NUM_LANDMARKS).fill(null);
  jointIndices.forEach((j, k) => (out[j] = joints3d[k] ?? null));
  return out;
}
