// 警告音（Web Audio API）。iOSではユーザーの操作のときにresumeしておく必要がある
export class Alarm {
  private ctx: AudioContext | null = null;

  constructor(private p: { frequencyHz: number; volume: number; durationMs: number }) {}

  /** 「測定開始」のタップ時に呼ぶ */
  unlock(): void {
    try {
      if (!this.ctx)
        this.ctx = new (
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        )();
      void this.ctx.resume();
    } catch {
      /* noop */
    }
  }

  play(): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = this.p.frequencyHz;
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    const d = this.p.durationMs / 1000;
    // 断続音
    for (let k = 0; k < d / 0.25; k++) {
      gain.gain.setValueAtTime(this.p.volume, t + k * 0.25);
      gain.gain.setValueAtTime(0, t + k * 0.25 + 0.15);
    }
    osc.start(t);
    osc.stop(t + d);
  }
}
