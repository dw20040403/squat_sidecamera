// 合成データからセッション形式（spec 6.3）のJSONを作る（オフラインモードの回帰テスト用）
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processSequence } from '../../web/src/fusion/pipeline';
import { JOINT_INDICES } from '../../web/src/fusion/landmarks';
import { measuredLayout } from '../../web/src/calib/layout';
import { toRecordFrame, type Session } from '../../web/src/record/session';
import type { Params } from '../../web/src/params';
import type { LayoutConfig } from '../../web/src/params';
import { makeSequence } from './generator';

// PlaywrightのESMローダーはJSONのimportに属性が必要なため、ファイルから読む
const cfgDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../config');
const params = JSON.parse(readFileSync(resolve(cfgDir, 'params.json'), 'utf8')) as Params;
const layout = JSON.parse(readFileSync(resolve(cfgDir, 'layout.json'), 'utf8')) as LayoutConfig;

export function syntheticSession(durationS = 12, sigmaPx = 3, swapProb = 0.1): Session {
  const preset = layout.presets.find((p) => p.id === layout.default)!;
  const seq = makeSequence({
    durationS,
    layout: preset,
    noise: { sigmaPx },
    subNoise: { sigmaPx, swapProb },
    seed: 42,
  });
  const P = params;
  const frames = processSequence(seq.main, seq.sub, seq.cams, P).map(toRecordFrame);
  const startedAt = seq.main[0].t;
  return {
    version: 1,
    id: '20261118-000000-synth',
    source: 'realtime',
    startedAt,
    endedAt: frames[frames.length - 1].t,
    aborted: null,
    subject: { id: 'SYN', heightM: 1.7, note: '合成データ' },
    trial: { label: 'normal' },
    devices: {
      main: {
        deviceName: 'synth-main',
        intrinsics: seq.cams.main.intr,
        extrinsics: seq.cams.main.extr,
        videoSize: [720, 1280],
      },
      sub: {
        deviceName: 'synth-sub',
        intrinsics: seq.cams.sub.intr,
        extrinsics: seq.cams.sub.extr,
        videoSize: [720, 1280],
      },
    },
    layout: {
      presetId: preset.id,
      planned: { main: preset.main, sub: preset.sub },
      measured: measuredLayout(seq.cams.main.extr, seq.cams.sub.extr),
    },
    params: P,
    jointIndices: JOINT_INDICES,
    frames,
    video: null,
  };
}
