// requestVideoFrameCallbackでフレームを受け取り、frameIntervalMs以上あけて処理する（spec 5.1）
import { nowMs } from '../util/clock';

export interface FrameInfo {
  /** フレームの時刻（自分の時計、epoch ms） */
  t: number;
  /** captureTimeを使ったか */
  fromCaptureTime: boolean;
  mediaTime: number;
}

type VfcMeta = {
  captureTime?: number;
  mediaTime?: number;
  presentedFrames?: number;
  expectedDisplayTime?: number;
};

export class FrameLoop {
  private handle = 0;
  private running = false;
  private lastProcessed = -Infinity;
  private busy = false;
  /** captureTimeが取れたか（実機で確認するための情報） */
  captureTimeAvailable: boolean | null = null;

  constructor(
    private video: HTMLVideoElement,
    private intervalMs: number,
    private onFrame: (f: FrameInfo) => Promise<void> | void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.handle);
    else cancelAnimationFrame(this.handle);
  }

  setInterval(ms: number): void {
    this.intervalMs = ms;
  }

  private schedule(): void {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: VfcMeta) => void) => number;
    };
    if (v.requestVideoFrameCallback) {
      this.handle = v.requestVideoFrameCallback((now, meta) => this.tick(now, meta));
    } else {
      this.handle = requestAnimationFrame((now) => this.tick(now, { mediaTime: this.video.currentTime }));
    }
  }

  private tick(_now: number, meta: VfcMeta): void {
    const t =
      typeof meta.captureTime === 'number' && meta.captureTime > 0
        ? performance.timeOrigin + meta.captureTime
        : nowMs();
    if (this.captureTimeAvailable === null)
      this.captureTimeAvailable = typeof meta.captureTime === 'number' && meta.captureTime > 0;
    if (!this.busy && t - this.lastProcessed >= this.intervalMs) {
      this.lastProcessed = t;
      this.busy = true;
      Promise.resolve(
        this.onFrame({ t, fromCaptureTime: !!this.captureTimeAvailable, mediaTime: meta.mediaTime ?? 0 }),
      )
        .catch((e) => console.error(e))
        .finally(() => {
          this.busy = false;
        });
    }
    this.schedule();
  }
}
