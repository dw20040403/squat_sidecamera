import { describe, expect, it } from 'vitest';
import params from '../../config/params.json';
import { AnomalyMonitor, type MonitorSample } from '../../web/src/monitor/anomaly';
import { RateMeter } from '../../web/src/monitor/fps';

const ok = (now: number): MonitorSample => ({
  now,
  channelOpen: true,
  lastSubPoseAt: now - 50,
  mainRequiredVisible: true,
  subRequiredVisible: true,
  reprojErrPx: 5,
  mainFps: 10,
  subFps: 10,
  rttMs: 15,
});

/** 100ms刻みの時系列を与えて、最初に中止した時刻と原因を返す */
function run(gen: (now: number) => Partial<MonitorSample>, untilMs = 10000) {
  const m = new AnomalyMonitor(params.monitor);
  m.start(0);
  for (let now = 0; now <= untilMs; now += 100) {
    const r = m.update({ ...ok(now), ...gen(now) });
    if (r) return r;
  }
  return null;
}

describe('異常の検知', () => {
  it('正常なら中止しない', () => {
    expect(run(() => ({}))).toBeNull();
  });
  it('副端末のデータが1秒届かない', () => {
    const r = run((now) => ({ lastSubPoseAt: Math.min(now - 50, 2000) }));
    expect(r?.reason).toBe('peer-timeout');
    expect(r?.at).toBe(3000);
  });
  it('DataChannelの切断が1秒続く', () => {
    const r = run((now) => (now >= 1000 ? { channelOpen: false } : {}));
    expect(r?.reason).toBe('peer-timeout');
    expect(r?.at).toBe(2000);
  });
  it('必須の関節が見えない状態が1秒続く（途中で戻れば中止しない）', () => {
    expect(run((now) => (now >= 1000 && now < 1800 ? { subRequiredVisible: false } : {}))).toBeNull();
    const r = run((now) => (now >= 1000 ? { mainRequiredVisible: false } : {}));
    expect(r?.reason).toBe('low-visibility');
    expect(r?.at).toBe(2000);
  });
  it('再投影誤差20px超が2秒続く', () => {
    const r = run((now) => (now >= 500 ? { reprojErrPx: 25 } : {}));
    expect(r?.reason).toBe('high-reproj');
    expect(r?.at).toBe(2500);
  });
  it('処理速度5fps未満が3秒続く', () => {
    const r = run((now) => (now >= 1000 ? { subFps: 4 } : {}));
    expect(r?.reason).toBe('low-fps');
    expect(r?.at).toBe(4000);
  });
  it('往復時間100ms超が3秒続く', () => {
    const r = run((now) => (now >= 1000 ? { rttMs: 150 } : {}));
    expect(r?.reason).toBe('high-rtt');
    expect(r?.at).toBe(4000);
  });
});

describe('RateMeter', () => {
  it('10fpsを測り、止まると下がる', () => {
    const r = new RateMeter(2000);
    for (let t = 0; t <= 3000; t += 100) r.tick(t);
    expect(r.rate(3000)!).toBeGreaterThan(9.5);
    expect(r.rate(3000)!).toBeLessThan(10.6);
    expect(r.rate(4500)!).toBeLessThan(3);
  });
});
