// セッションデータ（spec 6.3）の型と、作成・変換の純粋な関数

import type { Extrinsics, Intrinsics } from '../fusion/camera';
import type { Pose2D } from '../fusion/landmarks';
import { round } from '../fusion/landmarks';
import type { Vec3 } from '../fusion/math';
import { METRIC_KEYS, type Angles } from '../metrics/angles';
import type { LayoutCamera, Params } from '../params';

export type AbortReason =
  'peer-timeout' | 'low-visibility' | 'high-reproj' | 'low-fps' | 'high-rtt' | 'error';

export interface AbortInfo {
  reason: AbortReason;
  at: number;
  detail?: string;
}

export interface DeviceInfo {
  deviceName: string;
  intrinsics: Intrinsics | null;
  extrinsics: Extrinsics | null;
  videoSize: [number, number];
}

export interface MeasuredLayout {
  main: LayoutCamera;
  sub: LayoutCamera;
  crossingAngleDeg: number;
}

export interface SessionLayout {
  presetId: string | null;
  planned: { main: LayoutCamera; sub: LayoutCamera } | null;
  measured: MeasuredLayout | null;
}

export interface SessionFrame {
  t: number;
  main2d: Pose2D | null;
  sub2d: Pose2D | null;
  joints3d: (Vec3 | null)[];
  angles: Angles;
  quality: { reprojErrPx: number | null; validJoints: number; swapApplied: boolean };
}

export interface SessionVideoInfo {
  /** 録画開始時刻（主時計、ms） */
  startedAt: number;
  mimeType: string;
}

export interface Session {
  version: 1;
  id: string;
  source: 'realtime' | 'offline';
  startedAt: number;
  endedAt: number | null;
  aborted: AbortInfo | null;
  subject: { id: string; heightM: number | null; note: string };
  trial: { label: string };
  devices: { main: DeviceInfo; sub: DeviceInfo };
  layout: SessionLayout | null;
  params: Params | Record<string, unknown>;
  jointIndices: number[];
  frames: SessionFrame[];
  /** 主カメラの映像を録画した場合（拡張項目） */
  video?: SessionVideoInfo | null;
  /** オフライン処理の元データ（拡張項目） */
  offline?: { offsetMs: number; stepMs: number; sourceFiles: string[] } | null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** セッションID：現地時刻の YYYYMMDD-HHMMSS */
export function sessionIdFromTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const r2d = (p: Pose2D | null): Pose2D | null =>
  p ? p.map(([u, v, vis]) => [round(u, 1), round(v, 1), round(vis, 3)] as [number, number, number]) : null;

/** 記録用に丸める（座標は0.1mm、角度は0.1°、2Dは0.1px） */
export function toRecordFrame(f: SessionFrame): SessionFrame {
  return {
    t: round(f.t, 1),
    main2d: r2d(f.main2d),
    sub2d: r2d(f.sub2d),
    joints3d: f.joints3d.map((j) => (j ? (j.map((v) => round(v, 4)) as Vec3) : null)),
    angles: f.angles,
    quality: {
      reprojErrPx: f.quality.reprojErrPx === null ? null : round(f.quality.reprojErrPx, 2),
      validJoints: f.quality.validJoints,
      swapApplied: f.quality.swapApplied,
    },
  };
}

/** CSV（時刻と7つの指標）。nullは空欄。時刻は開始からの秒と主時計の両方 */
export function sessionToCsv(s: Session): string {
  const header = ['t_ms', 'elapsed_s', ...METRIC_KEYS, 'reprojErrPx', 'validJoints', 'swapApplied'];
  const lines = [header.join(',')];
  for (const f of s.frames) {
    const cells = [
      f.t.toFixed(1),
      ((f.t - s.startedAt) / 1000).toFixed(3),
      ...METRIC_KEYS.map((k) => (f.angles[k] === null ? '' : f.angles[k]!.toFixed(1))),
      f.quality.reprojErrPx === null ? '' : f.quality.reprojErrPx.toFixed(2),
      String(f.quality.validJoints),
      f.quality.swapApplied ? '1' : '0',
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}

export interface SessionStats {
  frames: number;
  durationS: number;
  /** 指標ごとの欠損率・最小・最大・平均 */
  metrics: Record<
    string,
    { missingRate: number; min: number | null; max: number | null; mean: number | null }
  >;
  /** 3D関節の欠損率（全関節・全フレーム） */
  jointMissingRate: number;
  meanReprojErrPx: number | null;
  swapRate: number;
}

export function sessionStats(s: Pick<Session, 'frames' | 'startedAt' | 'endedAt'>): SessionStats {
  const n = s.frames.length;
  const metrics: SessionStats['metrics'] = {};
  for (const k of METRIC_KEYS) {
    const vals = s.frames.map((f) => f.angles[k]).filter((v): v is number => v !== null);
    metrics[k] = {
      missingRate: n ? 1 - vals.length / n : 1,
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
      mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    };
  }
  let jTotal = 0;
  let jMissing = 0;
  const errs: number[] = [];
  let swaps = 0;
  for (const f of s.frames) {
    for (const j of f.joints3d) {
      jTotal++;
      if (!j) jMissing++;
    }
    if (f.quality.reprojErrPx !== null) errs.push(f.quality.reprojErrPx);
    if (f.quality.swapApplied) swaps++;
  }
  const t0 = n ? s.frames[0].t : 0;
  const t1 = n ? s.frames[n - 1].t : 0;
  return {
    frames: n,
    durationS: (t1 - t0) / 1000,
    metrics,
    jointMissingRate: jTotal ? jMissing / jTotal : 1,
    meanReprojErrPx: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
    swapRate: n ? swaps / n : 0,
  };
}

/** 読み込んだJSONがセッション形式かの簡単な確認 */
export function isSession(x: unknown): x is Session {
  const s = x as Session;
  return !!s && typeof s === 'object' && s.version === 1 && Array.isArray(s.frames) && !!s.devices;
}
