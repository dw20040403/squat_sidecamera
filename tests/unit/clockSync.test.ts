import { describe, expect, it } from 'vitest';
import params from '../../config/params.json';
import {
  ClockSyncClient,
  estimateOffset,
  respondSync,
  syncSample,
  type SyncReq,
} from '../../web/src/net/clockSync';
import { rng } from '../synthetic/generator';

describe('時刻同期', () => {
  it('往復計測の式', () => {
    // 副の時計が主より300ms遅れている。片道10ms、主の処理2ms
    const s = syncSample(1000, 1310, 1312, 1022);
    expect(s.offset).toBe(300);
    expect(s.rtt).toBe(20);
  });
  it('往復時間が小さい5回分の中央値', () => {
    const samples = [
      { offset: 100, rtt: 10 },
      { offset: 101, rtt: 12 },
      { offset: 99, rtt: 11 },
      { offset: 150, rtt: 80 },
      { offset: 102, rtt: 13 },
      { offset: 98, rtt: 14 },
      { offset: 40, rtt: 90 },
    ];
    expect(estimateOffset(samples, 5)).toBe(100);
  });

  it('遅延とずれを模擬した通信で、ずれを数ms以内に推定する', async () => {
    const trueOffset = -1234.5; // 副の時計 + offset = 主の時計
    let simNow = 0; // 主時計
    const r = rng(7);
    const queue: { at: number; fn: () => void }[] = [];
    const schedule = (delay: number, fn: () => void) => queue.push({ at: simNow + delay, fn });
    const subNow = () => simNow - trueOffset;
    const client = new ClockSyncClient(params.clockSync, {
      now: subNow,
      send: (req: SyncReq) => {
        // 上りと下りの遅延は非対称でばらつく
        const up = 5 + r() * 20;
        schedule(up, () => {
          const t1 = simNow;
          const res = respondSync(req, t1, () => simNow + 0.5);
          const down = 5 + r() * 20;
          schedule(down + 0.5, () => client.handle(res));
        });
      },
      setTimer: (fn, ms) => {
        const h = { at: simNow + ms, fn };
        queue.push(h);
        return h;
      },
      clearTimer: (h) => {
        const i = queue.indexOf(h as never);
        if (i >= 0) queue.splice(i, 1);
      },
    });
    let finished = false;
    const done = client.initial().then((v) => ((finished = true), v));
    // イベントを時刻順に処理する（各イベントの後にマイクロタスクを流す）
    for (let i = 0; i < 10000 && !finished; i++) {
      await new Promise((res) => setTimeout(res, 0));
      if (finished || !queue.length) continue;
      queue.sort((a, b) => a.at - b.at);
      const e = queue.shift()!;
      simNow = e.at;
      e.fn();
    }
    expect(await done).toBe(true);
    expect(client.state.synced).toBe(true);
    expect(Math.abs(client.state.offset - trueOffset)).toBeLessThan(8);
    expect(client.toMain(subNow())).toBeCloseTo(simNow, -1);
  });
});
