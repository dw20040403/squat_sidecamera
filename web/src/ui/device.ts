// 主端末・副端末に共通の部分：カメラ、2D推定、2D表示（表示モード①②③）
import { openCamera, type CameraHandle } from '../capture/camera';
import { FrameLoop, type FrameInfo } from '../capture/frameLoop';
import { WakeLock } from '../capture/wakeLock';
import { loadIntrinsics } from '../configLoader';
import type { AppConfig } from '../configLoader';
import type { Intrinsics } from '../fusion/camera';
import type { Pose2D } from '../fusion/landmarks';
import { MovingAverage, RateMeter } from '../monitor/fps';
import { PoseEstimator, type Delegate } from '../pose/landmarker';
import { drawSkeleton2D, fitContain, syncCanvasSize } from '../render/view2d';
import { nowMs } from '../util/clock';
import { KEYS, loadJson, saveJson } from '../util/storage';
import { h } from './dom';

export type DisplayMode = 'video' | 'skeleton' | 'overlay' | '3d';

export interface PoseFrame {
  /** 自分の時計（ms） */
  t: number;
  pose: Pose2D | null;
  w: number;
  h: number;
  inferMs: number;
}

export class DeviceCore {
  readonly stage: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly overlay: HTMLCanvasElement;
  cam: CameraHandle | null = null;
  est: PoseEstimator | null = null;
  loop: FrameLoop | null = null;
  readonly wakeLock = new WakeLock();
  deviceName: string;
  intr: Intrinsics | null = null;
  lastPose: Pose2D | null = null;
  lastFrame: PoseFrame | null = null;
  readonly rate = new RateMeter(2000);
  readonly inferMs = new MovingAverage(30);
  mode: DisplayMode = 'overlay';
  /** 2D描画の上に重ねる追加の描画 */
  extraDraw:
    | ((ctx: CanvasRenderingContext2D, map: { scale: number; offsetX: number; offsetY: number }) => void)
    | null = null;
  onPose: (f: PoseFrame) => void = () => {};
  invalidJoints: Set<number> | undefined;
  error: string | null = null;

  constructor(
    readonly cfg: AppConfig,
    readonly role: 'main' | 'sub',
  ) {
    this.deviceName = loadJson<string>(KEYS.deviceName, role === 'main' ? 'iphone15-A' : 'iphone15-B');
    this.video = h('video', { playsinline: true, muted: true, autoplay: true });
    this.overlay = h('canvas', { class: 'overlay' });
    this.stage = h('div', { class: 'stage mode-overlay' }, this.video, this.overlay);
    this.setMode(loadJson<DisplayMode>(KEYS.displayMode, 'overlay'));
  }

  setMode(m: DisplayMode): void {
    this.mode = m;
    this.stage.classList.remove('mode-video', 'mode-skeleton', 'mode-overlay', 'mode-3d');
    this.stage.classList.add(`mode-${m}`);
    saveJson(KEYS.displayMode, m);
    this.draw();
  }

  async setDeviceName(name: string): Promise<void> {
    this.deviceName = name;
    saveJson(KEYS.deviceName, name);
    this.intr = await loadIntrinsics(name);
  }

  get resolutionOk(): boolean {
    return (
      !!this.intr &&
      !!this.cam &&
      this.intr.imageSize[0] === this.cam.width &&
      this.intr.imageSize[1] === this.cam.height
    );
  }

  /** カメラ → 推定器 → フレームループの順に起動する */
  async start(status: (s: string) => void): Promise<void> {
    status('内部パラメータを読み込み中…');
    this.intr = await loadIntrinsics(this.deviceName);
    status('カメラを起動中…');
    this.cam = await openCamera(this.video, this.cfg.params.video);
    status('姿勢推定のモデルを読み込み中…');
    const delegate = loadJson<Delegate | 'auto'>(KEYS.delegate, 'auto');
    this.est = await PoseEstimator.create({ model: this.cfg.params.poseModel, delegate });
    this.loop = new FrameLoop(this.video, this.cfg.params.frameIntervalMs, (f) => this.process(f));
    this.loop.start();
    new ResizeObserver(() => this.draw()).observe(this.stage);
    status('');
  }

  private process(f: FrameInfo): void {
    if (!this.est || !this.cam) return;
    const w = this.video.videoWidth;
    const hh = this.video.videoHeight;
    const t0 = performance.now();
    let pose: Pose2D | null = null;
    try {
      pose = this.est.detect(this.video, f.t - performance.timeOrigin, w, hh);
    } catch (e) {
      this.error = (e as Error).message;
      console.error(e);
    }
    const ms = performance.now() - t0;
    this.inferMs.push(ms);
    this.rate.tick(nowMs());
    this.lastPose = pose;
    this.lastFrame = { t: f.t, pose, w, h: hh, inferMs: ms };
    this.draw();
    this.onPose(this.lastFrame);
  }

  /** 2D骨格を描く */
  draw(): void {
    if (this.mode === 'video' || this.mode === '3d') return;
    const { w, h: ch } = syncCanvasSize(this.overlay);
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, w, ch);
    if (this.mode === 'skeleton') {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, w, ch);
    }
    const vw = this.video.videoWidth || this.cfg.params.video.height;
    const vh = this.video.videoHeight || this.cfg.params.video.width;
    const map = fitContain(vw, vh, w, ch);
    if (this.lastPose) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      drawSkeleton2D(ctx, this.lastPose, {
        minVisibility: this.cfg.params.fusion.minVisibility,
        ...map,
        lineWidth: 3 * dpr,
        radius: 4 * dpr,
        invalid: this.invalidJoints,
      });
    }
    this.extraDraw?.(ctx, map);
  }

  /** 校正画像の撮影用：現在のフレームをPNGにする（計測時と同じ解像度） */
  async snapshotPng(): Promise<{ blob: Blob; w: number; h: number }> {
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    c.getContext('2d')!.drawImage(this.video, 0, 0);
    const blob = await new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error('PNGにできませんでした'))), 'image/png'),
    );
    return { blob, w: c.width, h: c.height };
  }
}

/** 表示モードのボタン（①〜④） */
export function modeButtons(
  core: { mode: DisplayMode; setMode(m: DisplayMode): void },
  with3d: boolean,
  hasVideo = true,
): HTMLElement {
  const defs: [DisplayMode, string][] = [
    ['video', '①映像'],
    ['skeleton', '②骨格'],
    ['overlay', '③合成'],
  ];
  if (with3d) defs.push(['3d', '④3D']);
  const wrap = h('div', { class: 'modes' });
  const buttons = defs.map(([m, label]) => {
    const b = h(
      'button',
      {
        onclick: () => (core.setMode(m), update()),
        disabled: !hasVideo && (m === 'video' || m === 'overlay'),
      },
      label,
    );
    wrap.appendChild(b);
    return { m, b };
  });
  const update = () => buttons.forEach(({ m, b }) => b.classList.toggle('on', core.mode === m));
  update();
  return wrap;
}
