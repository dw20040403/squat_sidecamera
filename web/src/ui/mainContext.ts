// 主端末の画面部品が参照する状態
import type { AppConfig } from '../configLoader';
import type { Intrinsics } from '../fusion/camera';
import type { FusedFrame } from '../fusion/fuser';
import type { Pose2D } from '../fusion/landmarks';
import type { ExtrinsicsMsg, StatusMsg } from '../net/messages';
import type { PeerLink } from '../net/peer';
import type { DeviceCore } from './device';
import type { LayoutSelection, StoredCalibration } from './calibState';

export interface SubInfo {
  deviceName: string | null;
  intr: Intrinsics | null;
  videoSize: [number, number] | null;
  status: StatusMsg | null;
  lastPose: Pose2D | null;
  cameraLabel?: string;
}

export interface MainContext {
  cfg: AppConfig;
  core: DeviceCore;
  peer: PeerLink;
  sub: SubInfo;
  calib: StoredCalibration | null;
  saveCalib(c: StoredCalibration | null): void;
  layoutSel: LayoutSelection;
  saveLayout(l: LayoutSelection): void;
  /** 統合したフレームを受け取る。戻り値で購読を解除する */
  onFused(cb: (f: FusedFrame) => void): () => void;
  /** 副端末に外部校正を依頼し、結果を待つ */
  requestSubExtrinsics(timeoutMs: number): Promise<ExtrinsicsMsg>;
}
