// 再生画面（spec 5.8）：表示モード①〜④、再生・一時停止、シーク、再生速度、指標の時系列グラフ
import { jointsByIndex } from '../fusion/fuser';
import { MetricsChart } from '../render/chart';
import { drawSkeleton2D, fitContain, syncCanvasSize } from '../render/view2d';
import { View3D } from '../render/view3d';
import type { Session, SessionFrame } from '../record/session';
import { h } from './dom';
import { modeButtons, type DisplayMode } from './device';
import { MetricsPanel } from './metricsPanel';

export class Player {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private video: HTMLVideoElement | null = null;
  private overlay: HTMLCanvasElement;
  private view3d: View3D | null = null;
  private view3dEl: HTMLElement;
  private chart: MetricsChart;
  private panel = new MetricsPanel();
  private seek: HTMLInputElement;
  private timeLabel: HTMLElement;
  private playBtn: HTMLButtonElement;
  mode: DisplayMode;
  private t: number;
  private playing = false;
  private rate = 1;
  private raf = 0;
  private lastTick = 0;
  private videoUrl: string | null = null;

  constructor(
    private s: Session,
    videoBlob: Blob | null,
    private minVisibility = 0.5,
  ) {
    const hasVideo = !!videoBlob && !!s.video;
    this.mode = hasVideo ? 'overlay' : 'skeleton';
    this.t = s.frames.length ? s.frames[0].t : s.startedAt;
    this.overlay = h('canvas', { class: 'overlay' });
    this.view3dEl = h('div', { class: 'view3d' });
    this.stage = h('div', { class: `stage mode-${this.mode}` });
    if (hasVideo) {
      this.videoUrl = URL.createObjectURL(videoBlob!);
      this.video = h('video', { playsinline: true, muted: true, src: this.videoUrl, preload: 'auto' });
      this.stage.appendChild(this.video);
      this.video.addEventListener('seeked', () => this.render());
    }
    this.stage.append(this.overlay, this.view3dEl);
    const presets = h(
      'div',
      { class: 'presets' },
      ...(['front', 'side', 'top', 'reset'] as const).map((p) =>
        h(
          'button',
          { onclick: () => this.view3d?.preset(p) },
          { front: '正面', side: '側面', top: '上', reset: 'リセット' }[p],
        ),
      ),
    );
    this.stage.append(modeButtons(this, true, hasVideo), presets, this.panel.toggle, this.panel.el);

    const canvas = h('canvas', { class: 'chart' });
    this.chart = new MetricsChart(canvas);
    this.chart.onSeek = (t) => this.seekTo(t);
    this.chart.setFrames(s.frames);
    const legend = h(
      'div',
      { class: 'legend' },
      ...MetricsChart.legend().map((l) => {
        const cb = h('input', { type: 'checkbox', checked: true });
        cb.addEventListener('change', () => {
          if (cb.checked) this.chart.visible.add(l.key);
          else this.chart.visible.delete(l.key);
          this.chart.draw();
        });
        return h('label', {}, cb, h('i', { style: `background:${l.color}` }), l.label);
      }),
    );

    const t0 = s.frames.length ? s.frames[0].t : s.startedAt;
    const t1 = s.frames.length ? s.frames[s.frames.length - 1].t : t0;
    this.seek = h('input', { type: 'range', min: 0, max: Math.max(1, t1 - t0), step: 10, value: 0 });
    this.seek.addEventListener('input', () => this.seekTo(t0 + Number(this.seek.value)));
    this.timeLabel = h('span', { class: 'note' }, '');
    this.playBtn = h(
      'button',
      { class: 'btn small', onclick: () => (this.playing ? this.pause() : this.play()) },
      '▶ 再生',
    );
    const speed = h(
      'select',
      {},
      ...[0.25, 0.5, 1].map((r) => h('option', { value: r, selected: r === 1 }, `${r}倍`)),
    );
    speed.addEventListener('change', () => {
      this.rate = Number(speed.value);
      if (this.video) this.video.playbackRate = this.rate;
    });
    this.el = h(
      'div',
      { class: 'player' },
      this.stage,
      h('div', { class: 'controls' }, this.playBtn, this.seek, speed, this.timeLabel),
      canvas,
      legend,
    );
    new ResizeObserver(() => {
      this.render();
      this.chart.draw();
    }).observe(this.stage);
    this.render();
  }

  setMode(m: DisplayMode): void {
    this.mode = m;
    this.stage.className = `stage mode-${m}`;
    if (m === '3d' && !this.view3d) {
      this.view3d = new View3D(this.view3dEl);
      this.view3d.setCameras([
        { label: 'main', extr: this.s.devices.main.extrinsics, color: 0x3b82f6 },
        { label: 'sub', extr: this.s.devices.sub.extrinsics, color: 0xf97316 },
      ]);
    }
    this.render();
  }

  private frameAt(t: number): SessionFrame | null {
    const fr = this.s.frames;
    if (!fr.length) return null;
    let lo = 0;
    let hi = fr.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (fr[m].t <= t) lo = m;
      else hi = m - 1;
    }
    return fr[lo];
  }

  seekTo(t: number): void {
    this.t = t;
    if (this.video && this.s.video) this.video.currentTime = Math.max(0, (t - this.s.video.startedAt) / 1000);
    this.render();
  }

  play(): void {
    this.playing = true;
    this.playBtn.textContent = '❚❚ 一時停止';
    const t1 = this.s.frames.length ? this.s.frames[this.s.frames.length - 1].t : this.t;
    if (this.t >= t1) this.seekTo(this.s.frames[0]?.t ?? this.t);
    if (this.video) {
      this.video.playbackRate = this.rate;
      void this.video.play();
    }
    this.lastTick = performance.now();
    const loop = () => {
      if (!this.playing) return;
      const now = performance.now();
      if (this.video && this.s.video) this.t = this.s.video.startedAt + this.video.currentTime * 1000;
      else this.t += (now - this.lastTick) * this.rate;
      this.lastTick = now;
      if (this.t >= t1 || (this.video && this.video.ended)) {
        this.t = Math.min(this.t, t1);
        this.pause();
      }
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  pause(): void {
    this.playing = false;
    this.playBtn.textContent = '▶ 再生';
    this.video?.pause();
    cancelAnimationFrame(this.raf);
  }

  private render(): void {
    const f = this.frameAt(this.t);
    const t0 = this.s.frames[0]?.t ?? this.t;
    this.seek.value = String(this.t - t0);
    this.timeLabel.textContent = `${((this.t - t0) / 1000).toFixed(1)}秒`;
    this.chart.cursorT = this.t;
    this.chart.draw();
    this.panel.update(f ? f.angles : null);
    if (this.mode === '3d') {
      if (f && this.view3d) this.view3d.setJoints(jointsByIndex(f.joints3d, this.s.jointIndices));
      return;
    }
    const { w, h: ch } = syncCanvasSize(this.overlay);
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, w, ch);
    if (this.mode === 'skeleton') {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, w, ch);
    }
    if (this.mode !== 'video' && f?.main2d) {
      const [vw, vh] = this.s.devices.main.videoSize;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      drawSkeleton2D(ctx, f.main2d, {
        minVisibility: this.minVisibility,
        ...fitContain(vw, vh, w, ch),
        lineWidth: 3 * dpr,
        radius: 4 * dpr,
      });
    }
  }

  dispose(): void {
    this.pause();
    this.view3d?.dispose();
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
  }
}
