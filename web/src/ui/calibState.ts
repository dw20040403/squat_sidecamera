// 外部校正の結果とカメラ配置の設定（主端末のlocalStorageに保存する）
import type { Extrinsics, Intrinsics } from '../fusion/camera';
import type { LayoutCamera, LayoutConfig } from '../params';
import type { MeasuredLayout } from '../record/session';
import { KEYS, loadJson, saveJson } from '../util/storage';

export interface StoredCamCalib {
  deviceName: string;
  extr: Extrinsics;
  reprojErrPx: number;
  videoSize: [number, number];
  markers: number[];
  method: string;
}

export interface StoredCalibration {
  savedAt: number;
  main: StoredCamCalib;
  sub: StoredCamCalib;
  measured: MeasuredLayout;
}

export interface LayoutSelection {
  presetId: string | null;
  main: LayoutCamera;
  sub: LayoutCamera;
}

export const loadCalibration = (): StoredCalibration | null =>
  loadJson<StoredCalibration | null>(KEYS.extrinsics, null);
export const saveCalibration = (c: StoredCalibration | null): void => saveJson(KEYS.extrinsics, c);

export function loadLayoutSelection(cfg: LayoutConfig): LayoutSelection {
  const saved = loadJson<LayoutSelection | null>(KEYS.layout, null);
  if (saved) return saved;
  const p = cfg.presets.find((x) => x.id === cfg.default) ?? cfg.presets[0];
  return { presetId: p.id, main: { ...p.main }, sub: { ...p.sub } };
}
export const saveLayoutSelection = (l: LayoutSelection): void => saveJson(KEYS.layout, l);

/** オフラインモードで使う calibration.json（spec 5.10.1） */
export interface CalibrationFile {
  version: 1;
  createdAt: number;
  main: {
    deviceName: string;
    intrinsics: Intrinsics | null;
    extrinsics: Extrinsics;
    videoSize: [number, number];
  };
  sub: {
    deviceName: string;
    intrinsics: Intrinsics | null;
    extrinsics: Extrinsics;
    videoSize: [number, number];
  };
  layout: { planned: LayoutSelection | null; measured: MeasuredLayout | null };
}

/** テスト録画の付随データ（<role>-meta.json） */
export interface RecordingMeta {
  role: 'main' | 'sub';
  deviceName: string;
  intrinsics: Intrinsics | null;
  /** 録画開始時刻（主時計、ms） */
  recordStartedAt: number;
  videoSize: [number, number];
  mimeType: string;
  cameraLabel?: string;
  clockOffsetMs?: number;
}
