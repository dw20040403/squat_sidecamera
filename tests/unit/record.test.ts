import { describe, expect, it } from 'vitest';
import { createZip, crc32 } from '../../web/src/record/zip';
import { sessionIdFromTime, sessionStats, sessionToCsv, type Session } from '../../web/src/record/session';
import { emptyAngles } from '../../web/src/metrics/angles';

describe('ZIP', () => {
  it('CRC32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('ZIPの構造', () => {
    const z = createZip([
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'b/c.png', data: new Uint8Array([1, 2, 3]) },
    ]);
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(z.length - 22 + 10, true)).toBe(2);
  });
});

describe('セッション', () => {
  const s: Session = {
    version: 1,
    id: 'x',
    source: 'realtime',
    startedAt: 1000,
    endedAt: 1200,
    aborted: null,
    subject: { id: 'S01', heightM: 1.7, note: '' },
    trial: { label: 'normal' },
    devices: {
      main: { deviceName: 'a', intrinsics: null, extrinsics: null, videoSize: [720, 1280] },
      sub: { deviceName: 'b', intrinsics: null, extrinsics: null, videoSize: [720, 1280] },
    },
    layout: null,
    params: {},
    jointIndices: [0],
    frames: [
      {
        t: 1000,
        main2d: null,
        sub2d: null,
        joints3d: [[0, 0, 1]],
        angles: { ...emptyAngles(), kneeFlexL: 85.24 },
        quality: { reprojErrPx: 3.456, validJoints: 23, swapApplied: true },
      },
      {
        t: 1100,
        main2d: null,
        sub2d: null,
        joints3d: [null],
        angles: emptyAngles(),
        quality: { reprojErrPx: null, validJoints: 0, swapApplied: false },
      },
    ],
  };
  it('CSV：nullは空欄', () => {
    const csv = sessionToCsv(s).trim().split('\n');
    expect(csv[0]).toBe(
      't_ms,elapsed_s,kneeFlexL,kneeFlexR,trunkLean,toeOutL,toeOutR,kneeInL,kneeInR,reprojErrPx,validJoints,swapApplied',
    );
    expect(csv[1]).toBe('1000.0,0.000,85.2,,,,,,,3.46,23,1');
    expect(csv[2]).toBe('1100.0,0.100,,,,,,,,,0,0');
  });
  it('統計', () => {
    const st = sessionStats(s);
    expect(st.frames).toBe(2);
    expect(st.metrics.kneeFlexL.missingRate).toBe(0.5);
    expect(st.jointMissingRate).toBe(0.5);
    expect(st.swapRate).toBe(0.5);
  });
  it('セッションIDは現地時刻', () => {
    const t = new Date(2026, 10, 17, 18, 30, 5).getTime();
    expect(sessionIdFromTime(t)).toBe('20261117-183005');
  });
});
