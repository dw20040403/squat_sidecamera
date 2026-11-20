// 指標の時系列グラフ（canvas）。現在の再生位置を縦線で示す
import { METRIC_KEYS, METRIC_LABELS, type MetricKey } from '../metrics/angles';
import type { SessionFrame } from '../record/session';
import { syncCanvasSize } from './view2d';

const COLORS: Record<MetricKey, string> = {
  kneeFlexL: '#3b82f6',
  kneeFlexR: '#f97316',
  trunkLean: '#e5e7eb',
  toeOutL: '#60a5fa',
  toeOutR: '#fdba74',
  kneeInL: '#1d4ed8',
  kneeInR: '#c2410c',
};

export class MetricsChart {
  private frames: SessionFrame[] = [];
  private t0 = 0;
  private t1 = 1;
  visible = new Set<MetricKey>(METRIC_KEYS);
  cursorT: number | null = null;
  onSeek: (t: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const seek = (clientX: number) => {
      const r = canvas.getBoundingClientRect();
      const x = (clientX - r.left) / r.width;
      const pad = 0.08;
      const s = Math.min(1, Math.max(0, (x - pad) / (1 - pad - 0.02)));
      this.onSeek(this.t0 + s * (this.t1 - this.t0));
    };
    canvas.addEventListener('pointerdown', (e) => seek(e.clientX));
    canvas.addEventListener('pointermove', (e) => e.buttons && seek(e.clientX));
  }

  setFrames(frames: SessionFrame[]): void {
    this.frames = frames;
    this.t0 = frames.length ? frames[0].t : 0;
    this.t1 = frames.length ? frames[frames.length - 1].t : 1;
    if (this.t1 <= this.t0) this.t1 = this.t0 + 1;
    this.draw();
  }

  draw(): void {
    const { w, h } = syncCanvasSize(this.canvas);
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0f17';
    ctx.fillRect(0, 0, w, h);
    const padL = w * 0.08;
    const padR = w * 0.02;
    const padT = 8;
    const padB = 18;
    let lo = -30;
    let hi = 120;
    for (const f of this.frames)
      for (const k of this.visible) {
        const v = f.angles[k];
        if (v !== null) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    const X = (t: number) => padL + ((t - this.t0) / (this.t1 - this.t0)) * (w - padL - padR);
    const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
    ctx.strokeStyle = '#1f2937';
    ctx.fillStyle = '#9ca3af';
    ctx.font = `${Math.round(10 * (window.devicePixelRatio || 1))}px sans-serif`;
    ctx.lineWidth = 1;
    for (let v = Math.ceil(lo / 30) * 30; v <= hi; v += 30) {
      ctx.beginPath();
      ctx.moveTo(padL, Y(v));
      ctx.lineTo(w - padR, Y(v));
      ctx.stroke();
      ctx.fillText(`${v}°`, 2, Y(v) + 4);
    }
    const dur = (this.t1 - this.t0) / 1000;
    const step = dur > 60 ? 10 : dur > 20 ? 5 : 1;
    for (let s = 0; s <= dur; s += step) ctx.fillText(`${s}s`, X(this.t0 + s * 1000) - 6, h - 4);
    ctx.lineWidth = Math.max(1.5, (window.devicePixelRatio || 1) * 1.2);
    for (const k of METRIC_KEYS) {
      if (!this.visible.has(k)) continue;
      ctx.strokeStyle = COLORS[k];
      ctx.beginPath();
      let pen = false;
      for (const f of this.frames) {
        const v = f.angles[k];
        if (v === null) {
          pen = false;
          continue;
        }
        if (!pen) ctx.moveTo(X(f.t), Y(v));
        else ctx.lineTo(X(f.t), Y(v));
        pen = true;
      }
      ctx.stroke();
    }
    if (this.cursorT !== null) {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(this.cursorT), padT);
      ctx.lineTo(X(this.cursorT), h - padB);
      ctx.stroke();
    }
  }

  static legend(): { key: MetricKey; label: string; color: string }[] {
    return METRIC_KEYS.map((k) => ({ key: k, label: METRIC_LABELS[k], color: COLORS[k] }));
  }
}
