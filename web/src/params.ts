// config/params.json の型（DOMに依存しない）

import type { OneEuroParams } from './fusion/filters';

export interface FusionParams {
  fusionDelayMs: number;
  maxPairGapMs: number;
  maxExtrapMs: number;
  minVisibility: number;
  maxReprojPx: number;
  maxHoldMs: number;
  swapCorrection: boolean;
  /** 左右入れ替えの判定で、再投影誤差の差がこれ未満なら左右の間隔で決める（px） */
  swapMarginPx?: number;
  oneEuro: OneEuroParams;
}

export interface MetricsParams {
  kneeInMinFlexDeg: number;
  kneeInMinHorizM: number;
}

export interface MonitorParams {
  peerTimeoutS: number;
  lowVisibilityS: number;
  maxReprojErrPx: number;
  highReprojS: number;
  minFps: number;
  lowFpsS: number;
  maxRttMs: number;
  highRttS: number;
}

export interface ClockSyncParams {
  initialSamples: number;
  initialBest: number;
  periodicIntervalS: number;
  periodicSamples: number;
  emaAlpha: number;
  rttProbeIntervalS: number;
  requestTimeoutMs: number;
}

export interface Params {
  frameIntervalMs: number;
  poseModel: 'full' | 'lite' | 'heavy';
  video: { width: number; height: number };
  fusion: FusionParams;
  metrics: MetricsParams;
  monitor: MonitorParams;
  clockSync: ClockSyncParams;
  expected2dErrPx: number;
  recording: { recordVideo: boolean; frameFlushCount: number };
  alarm: { frequencyHz: number; volume: number; durationMs: number };
}

export interface LayoutCamera {
  azimuthDeg: number;
  distanceM: number;
  heightM: number;
}

export interface LayoutPreset {
  id: string;
  label: string;
  main: LayoutCamera;
  sub: LayoutCamera;
}

export interface LayoutConfig {
  presets: LayoutPreset[];
  default: string;
  tolerance: { azimuthDeg: number; distanceM: number; heightM: number };
  crossingAngleRangeDeg: [number, number];
}

export interface BoardMarker {
  id: number;
  /** 4隅の世界座標（m）。OpenCVと同じ順序（左上・右上・右下・左下） */
  corners: [number, number, number][];
}

export interface BoardConfig {
  dictionary: string;
  markerSizeM: number;
  gapM?: number;
  markers: BoardMarker[];
}

/** 深いマージ（設定の一部だけを上書きするため） */
export function mergeDeep<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : (override as T);
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? mergeDeep(b, v) : v;
  }
  return out as T;
}
