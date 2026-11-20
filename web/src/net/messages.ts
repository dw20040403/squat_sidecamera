// DataChannelのメッセージ（spec 6.1・6.2）
import type { Intrinsics } from '../fusion/camera';
import type { SyncReq, SyncRes } from './clockSync';

/** poseチャネル */
export interface PoseMsg {
  type: 'pose';
  seq: number;
  /** 主時計に換算したフレーム時刻（ms, epoch） */
  t: number;
  w: number;
  h: number;
  /** 33点×3（画素座標・歪み補正前）。未検出ならnull */
  lm: number[] | null;
}

export interface HelloMsg {
  type: 'hello';
  deviceName: string;
  intrinsics: Intrinsics | null;
  videoSize: [number, number];
  cameraLabel?: string;
}

export interface ExtrinsicsMsg {
  type: 'extrinsics';
  R: number[][];
  t: number[];
  reprojErrPx: number;
  markers?: number;
  detector?: string;
}

export interface CommandMsg {
  type: 'calib-start' | 'test-rec-start' | 'test-rec-stop';
}

export interface StatusMsg {
  type: 'status';
  fps: number | null;
  personDetected: boolean;
  /** 時刻同期の状態（主端末で表示・監視する。拡張項目） */
  synced?: boolean;
  offsetMs?: number;
  rttMs?: number | null;
  probeRttMs?: number | null;
  inferMs?: number | null;
  recording?: boolean;
}

/** 副端末の録画の付随データ（テスト録画の停止時に主端末へ知らせる。拡張項目） */
export interface TestRecDoneMsg {
  type: 'test-rec-done';
  ok: boolean;
  error?: string;
}

/** 校正の失敗などを伝える（拡張項目） */
export interface NoticeMsg {
  type: 'notice';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type CtrlMsg =
  SyncReq | SyncRes | HelloMsg | ExtrinsicsMsg | CommandMsg | StatusMsg | TestRecDoneMsg | NoticeMsg;
