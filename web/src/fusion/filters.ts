// One Euroフィルタと欠損値の保持

import type { Vec3 } from './math';

export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

const alpha = (cutoff: number, dtS: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtS);
};

/** スカラーのOne Euroフィルタ。時刻はms、速度は単位/秒 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(private p: OneEuroParams) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = tMs;
      return x;
    }
    const dt = (tMs - this.tPrev) / 1000;
    if (!(dt > 0)) return this.xPrev;
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(this.p.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(dxHat);
    const a = alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tMs;
    return xHat;
  }
}

/** 3次元点のOne Euroフィルタ（成分ごと） */
export class OneEuroFilter3 {
  private f: OneEuroFilter[];
  constructor(p: OneEuroParams) {
    this.f = [new OneEuroFilter(p), new OneEuroFilter(p), new OneEuroFilter(p)];
  }
  reset(): void {
    this.f.forEach((f) => f.reset());
  }
  filter(x: Vec3, tMs: number): Vec3 {
    return [this.f[0].filter(x[0], tMs), this.f[1].filter(x[1], tMs), this.f[2].filter(x[2], tMs)];
  }
}

/** 無効な値のとき、直前の有効値を最大maxHoldMsまで保持する */
export class HoldLast<T> {
  private last: T | null = null;
  private lastT = -Infinity;
  constructor(private maxHoldMs: number) {}

  reset(): void {
    this.last = null;
    this.lastT = -Infinity;
  }

  /** 戻り値：value＝出力、held＝保持した値か */
  update(value: T | null, tMs: number): { value: T | null; held: boolean } {
    if (value !== null) {
      this.last = value;
      this.lastT = tMs;
      return { value, held: false };
    }
    if (this.last !== null && tMs - this.lastT <= this.maxHoldMs) return { value: this.last, held: true };
    this.last = null;
    return { value: null, held: false };
  }
}
