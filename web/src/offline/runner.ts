// オフライン処理（spec 5.10.2）：2本の動画を主時計で揃え、100ms刻みでシークしながら
// リアルタイム処理と同じモジュール（推論 → 統合 → 指標）で処理する
import type { Camera } from '../fusion/camera';
import type { TimedPose } from '../fusion/interp';
import { JOINT_INDICES } from '../fusion/landmarks';
import { processSequence, recomputeFrames } from '../fusion/pipeline';
import { measuredLayout } from '../calib/layout';
import type { Params } from '../params';
import { PoseEstimator, type Delegate } from '../pose/landmarker';
import { sessionIdFromTime, toRecordFrame, type Session, type SessionFrame } from '../record/session';
import type { CalibrationFile, RecordingMeta } from '../ui/calibState';

export interface Inferred2D {
  main: TimedPose[];
  sub: TimedPose[];
  offsetMs: number;
  stepMs: number;
  delegate: string;
}

function once(el: HTMLElement, ev: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      el.removeEventListener(ev, on);
      reject(new Error(`${ev} がタイムアウトしました`));
    }, timeoutMs);
    const on = () => {
      clearTimeout(t);
      resolve();
    };
    el.addEventListener(ev, on, { once: true });
  });
}

export async function loadVideo(src: Blob): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = URL.createObjectURL(src);
  await once(v, 'loadedmetadata', 30_000);
  // MediaRecorderのWebMは長さが不明（Infinity）のことがあるので、末尾までシークして求める
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e9;
    await once(v, 'seeked', 30_000).catch(() => {});
    v.currentTime = 0;
    await once(v, 'seeked', 30_000).catch(() => {});
  }
  if (v.readyState < 2) await once(v, 'loadeddata', 30_000).catch(() => {});
  return v;
}

async function seek(v: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return;
  const p = once(v, 'seeked');
  v.currentTime = t;
  await p;
}

export interface InferOptions {
  mainVideo: Blob;
  subVideo: Blob;
  mainMeta: RecordingMeta;
  subMeta: RecordingMeta;
  /** 副端末の時刻に加える補正（ms、±500） */
  offsetMs: number;
  stepMs: number;
  delegate: Delegate | 'auto';
  model: Params['poseModel'];
  onProgress?: (done: number, total: number) => void;
  signal?: { cancelled: boolean };
}

/** 2本の動画から2D姿勢の列を作る（主時計） */
export async function inferVideos(o: InferOptions): Promise<Inferred2D> {
  const [vm, vs] = await Promise.all([loadVideo(o.mainVideo), loadVideo(o.subVideo)]);
  const estM = await PoseEstimator.create({ model: o.model, delegate: o.delegate });
  const estS = await PoseEstimator.create({ model: o.model, delegate: o.delegate });
  const main: TimedPose[] = [];
  const sub: TimedPose[] = [];
  try {
    const durM = vm.duration;
    const durS = vs.duration;
    const total = Math.floor((durM * 1000) / o.stepMs) + 1;
    for (let k = 0; k < total; k++) {
      if (o.signal?.cancelled) throw new Error('中止しました');
      const tau = (k * o.stepMs) / 1000;
      await seek(vm, Math.min(tau, durM - 0.001));
      const T = o.mainMeta.recordStartedAt + tau * 1000;
      main.push({
        t: T,
        pose: estM.detect(vm, k * o.stepMs + 1, vm.videoWidth, vm.videoHeight),
        w: vm.videoWidth,
        h: vm.videoHeight,
      });
      const sigma = (T - o.subMeta.recordStartedAt - o.offsetMs) / 1000;
      if (sigma >= 0 && sigma <= durS) {
        await seek(vs, Math.min(sigma, durS - 0.001));
        sub.push({
          t: T,
          pose: estS.detect(vs, k * o.stepMs + 1, vs.videoWidth, vs.videoHeight),
          w: vs.videoWidth,
          h: vs.videoHeight,
        });
      }
      o.onProgress?.(k + 1, total);
    }
  } finally {
    estM.close();
    estS.close();
    URL.revokeObjectURL(vm.src);
    URL.revokeObjectURL(vs.src);
  }
  return { main, sub, offsetMs: o.offsetMs, stepMs: o.stepMs, delegate: estM.delegate };
}

export function camerasFromCalibration(
  c: CalibrationFile,
  mainMeta?: RecordingMeta,
  subMeta?: RecordingMeta,
): { main: Camera; sub: Camera } {
  const mi = c.main.intrinsics ?? mainMeta?.intrinsics;
  const si = c.sub.intrinsics ?? subMeta?.intrinsics;
  if (!mi || !si) throw new Error('内部パラメータがありません（calibration.json または *-meta.json）');
  return { main: { intr: mi, extr: c.main.extrinsics }, sub: { intr: si, extr: c.sub.extrinsics } };
}

/** 推論結果（2D）から、セッション形式（spec 6.3）の出力を作る */
export function buildOfflineSession(
  inf: Inferred2D,
  cams: { main: Camera; sub: Camera },
  params: Params,
  info: {
    calibration?: CalibrationFile;
    mainMeta?: RecordingMeta;
    subMeta?: RecordingMeta;
    sourceFiles: string[];
  },
): Session {
  const frames = processSequence(inf.main, inf.sub, cams, params).map(toRecordFrame);
  return sessionFrom(frames, cams, params, {
    startedAt: inf.main[0]?.t ?? Date.now(),
    deviceNames: [
      info.mainMeta?.deviceName ?? info.calibration?.main.deviceName ?? 'main',
      info.subMeta?.deviceName ?? info.calibration?.sub.deviceName ?? 'sub',
    ],
    videoSizes: [
      info.mainMeta?.videoSize ?? cams.main.intr.imageSize,
      info.subMeta?.videoSize ?? cams.sub.intr.imageSize,
    ],
    planned: info.calibration?.layout.planned ?? null,
    offline: { offsetMs: inf.offsetMs, stepMs: inf.stepMs, sourceFiles: info.sourceFiles },
    video: info.mainMeta
      ? { startedAt: info.mainMeta.recordStartedAt, mimeType: info.mainMeta.mimeType }
      : null,
  });
}

function sessionFrom(
  frames: SessionFrame[],
  cams: { main: Camera; sub: Camera },
  params: Params,
  o: {
    startedAt: number;
    deviceNames: [string, string];
    videoSizes: [[number, number], [number, number]];
    planned: CalibrationFile['layout']['planned'];
    offline: Session['offline'];
    video: Session['video'];
    base?: Session;
  },
): Session {
  return {
    version: 1,
    id: o.base ? `${o.base.id}-re` : `${sessionIdFromTime(o.startedAt)}-offline`,
    source: 'offline',
    startedAt: o.startedAt,
    endedAt: frames.length ? frames[frames.length - 1].t : o.startedAt,
    aborted: null,
    subject: o.base?.subject ?? { id: '', heightM: null, note: '' },
    trial: o.base?.trial ?? { label: '' },
    devices: {
      main: {
        deviceName: o.deviceNames[0],
        intrinsics: cams.main.intr,
        extrinsics: cams.main.extr,
        videoSize: o.videoSizes[0],
      },
      sub: {
        deviceName: o.deviceNames[1],
        intrinsics: cams.sub.intr,
        extrinsics: cams.sub.extr,
        videoSize: o.videoSizes[1],
      },
    },
    layout: o.base?.layout ?? {
      presetId: o.planned?.presetId ?? null,
      planned: o.planned ? { main: o.planned.main, sub: o.planned.sub } : null,
      measured: measuredLayout(cams.main.extr, cams.sub.extr),
    },
    params,
    jointIndices: JOINT_INDICES,
    frames,
    video: o.video,
    offline: o.offline,
  };
}

/** 記録したセッションのJSONから、統合と指標だけを計算し直す（推論は行わない） */
export function recomputeSession(s: Session, params: Params): Session {
  const mi = s.devices.main.intrinsics;
  const si = s.devices.sub.intrinsics;
  const me = s.devices.main.extrinsics;
  const se = s.devices.sub.extrinsics;
  if (!mi || !si || !me || !se) throw new Error('セッションに内部・外部パラメータがありません');
  const cams = { main: { intr: mi, extr: me }, sub: { intr: si, extr: se } };
  const frames = recomputeFrames(s.frames, cams, params).map(toRecordFrame);
  return sessionFrom(frames, cams, params, {
    startedAt: s.startedAt,
    deviceNames: [s.devices.main.deviceName, s.devices.sub.deviceName],
    videoSizes: [s.devices.main.videoSize, s.devices.sub.videoSize],
    planned: null,
    offline: { offsetMs: 0, stepMs: 0, sourceFiles: [`session-${s.id}.json`] },
    video: s.video ?? null,
    base: s,
  });
}
