// 外部校正：マーカーの検出結果とボードの定義から、カメラの姿勢R, tを求める
import type { Extrinsics, Intrinsics } from '../fusion/camera';
import type { BoardConfig } from '../params';
import type { DetectedMarker, MarkerDetector } from './aruco';
import { meanReprojErrorPx, refinePose, solvePlanarPnP, type Correspondence } from './pnp';

export interface ExtrinsicsResult {
  extr: Extrinsics;
  reprojErrPx: number;
  markers: number[];
  points: number;
  method: string;
}

export function correspondences(markers: DetectedMarker[], board: BoardConfig): Correspondence[] {
  const out: Correspondence[] = [];
  for (const m of markers) {
    const def = board.markers.find((b) => b.id === m.id);
    if (!def) continue;
    for (let k = 0; k < 4; k++) out.push({ X: def.corners[k], u: m.corners[k][0], v: m.corners[k][1] });
  }
  return out;
}

export function estimateExtrinsics(
  markers: DetectedMarker[],
  board: BoardConfig,
  intr: Intrinsics,
  detector?: MarkerDetector,
): ExtrinsicsResult | null {
  const corr = correspondences(markers, board);
  if (corr.length < 4) return null;
  const used = [...new Set(markers.filter((m) => board.markers.some((b) => b.id === m.id)).map((m) => m.id))];
  // OpenCVのsolvePnPが使えればそれを使い、自前の最適化で仕上げる
  if (detector?.solvePnP) {
    const e = detector.solvePnP(corr, intr);
    if (e) {
      const refined = refinePose(e, corr, intr);
      const err = meanReprojErrorPx(refined, corr, intr);
      return {
        extr: { ...refined, reprojErrPx: err },
        reprojErrPx: err,
        markers: used,
        points: corr.length,
        method: 'opencv-solvePnP',
      };
    }
  }
  const r = solvePlanarPnP(corr, intr);
  if (!r) return null;
  return {
    extr: r.extr,
    reprojErrPx: r.reprojErrPx,
    markers: used,
    points: corr.length,
    method: 'planar-pnp',
  };
}

/** 映像の現在のフレームをImageDataにする */
export function grabFrame(video: HTMLVideoElement): ImageData {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}
