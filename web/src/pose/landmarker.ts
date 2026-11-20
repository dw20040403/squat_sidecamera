// MediaPipe Pose Landmarker のラッパー（spec 5.1）。モデルとwasmは自前のサーバーから配信する
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Pose2D } from '../fusion/landmarks';

export type Delegate = 'GPU' | 'CPU';

export interface LandmarkerOptions {
  model: 'lite' | 'full' | 'heavy';
  delegate: Delegate | 'auto';
  basePath?: string;
}

export class PoseEstimator {
  private constructor(
    private lm: PoseLandmarker,
    readonly delegate: Delegate,
    readonly model: string,
  ) {}

  private lastTs = -1;

  static async create(o: LandmarkerOptions): Promise<PoseEstimator> {
    const base = o.basePath ?? '/mediapipe';
    const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
    const modelAssetPath = `${base}/models/pose_landmarker_${o.model}.task`;
    const tryCreate = (delegate: Delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    if (o.delegate !== 'CPU') {
      try {
        return new PoseEstimator(await tryCreate('GPU'), 'GPU', o.model);
      } catch (e) {
        if (o.delegate === 'GPU') throw e;
        console.warn('GPUデリゲートが使えないため、CPUに切り替えます', e);
      }
    }
    return new PoseEstimator(await tryCreate('CPU'), 'CPU', o.model);
  }

  /**
   * 推論する。timestampMsは単調増加でなければならない（VIDEOモードの制約）。
   * 戻り値は33点の画素座標（歪み補正前）と可視度。未検出ならnull。
   */
  detect(
    source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
    timestampMs: number,
    w: number,
    h: number,
  ): Pose2D | null {
    let ts = Math.floor(timestampMs);
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    const r = this.lm.detectForVideo(source as HTMLVideoElement, ts);
    const lms = r.landmarks?.[0];
    if (!lms || lms.length < 33) return null;
    return lms.map((p) => [p.x * w, p.y * h, p.visibility ?? 0] as [number, number, number]);
  }

  close(): void {
    this.lm.close();
  }
}
