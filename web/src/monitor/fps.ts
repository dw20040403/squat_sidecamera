// 直近の時間窓でのイベントの頻度（fps）を測る

export class RateMeter {
  private times: number[] = [];
  private first: number | null = null;
  constructor(private windowMs = 2000) {}

  tick(now: number): void {
    if (this.first === null) this.first = now;
    this.times.push(now);
    this.trim(now);
  }

  private trim(now: number): void {
    while (this.times.length && this.times[0] <= now - this.windowMs) this.times.shift();
  }

  /** 現在のレート（回/秒）。観測を始めてから短すぎるときはnull。イベントが止まると下がる */
  rate(now: number): number | null {
    if (this.first === null) return null;
    this.trim(now);
    const span = Math.min(this.windowMs, now - this.first);
    if (span < 300) return null;
    return (this.times.length / span) * 1000;
  }

  reset(): void {
    this.times = [];
    this.first = null;
  }
}

/** 値の移動平均（処理時間の表示など） */
export class MovingAverage {
  private values: number[] = [];
  constructor(private n = 20) {}
  push(v: number): void {
    this.values.push(v);
    if (this.values.length > this.n) this.values.shift();
  }
  get value(): number | null {
    if (!this.values.length) return null;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }
}
