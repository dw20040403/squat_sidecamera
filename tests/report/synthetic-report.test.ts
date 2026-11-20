// 合成データによる誤差のレポート（plan フェーズ1 手順10）。tests/reports/synthetic-report.md に出力する
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import params from '../../config/params.json';
import layout from '../../config/layout.json';
import { processSequence } from '../../web/src/fusion/pipeline';
import { cameraCenter } from '../../web/src/fusion/camera';
import { JOINT_INDICES } from '../../web/src/fusion/landmarks';
import { normalize, type Vec3 } from '../../web/src/fusion/math';
import { computeAngles, METRIC_KEYS } from '../../web/src/metrics/angles';
import type { LayoutCamera, Params } from '../../web/src/params';
import { makeSequence } from '../synthetic/generator';

const P = params as unknown as Params;
const NO_FILTER: Params = { ...P, fusion: { ...P.fusion, oneEuro: { minCutoff: 1e6, beta: 0, dCutoff: 1 } } };
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../reports/synthetic-report.md');

interface Result {
  depth: number;
  lateral: number;
  vertical: number;
  total: number;
  metrics: Record<string, number>;
  missing: number;
}

function evaluate(
  lay: { main: LayoutCamera; sub: LayoutCamera },
  sigma: number,
  p: Params,
  seed = 11,
  durationS = 15,
): Result {
  const seq = makeSequence({ durationS, layout: lay, noise: { sigmaPx: sigma }, seed });
  const frames = processSequence(seq.main, seq.sub, seq.cams, p);
  const c1 = cameraCenter(seq.cams.main.extr);
  const c2 = cameraCenter(seq.cams.sub.extr);
  const depthDir = normalize([c1[0] + c2[0], c1[1] + c2[1], 0]) ?? ([0, 1, 0] as Vec3);
  const latDir: Vec3 = [-depthDir[1], depthDir[0], 0];
  const sq = { d: 0, l: 0, v: 0, n: 0 };
  const mErr: Record<string, number[]> = Object.fromEntries(METRIC_KEYS.map((k) => [k, []]));
  let missing = 0;
  frames.forEach((f, i) => {
    const truth = seq.truth[i].joints;
    JOINT_INDICES.forEach((j, k) => {
      const X = f.joints3d[k];
      if (!X) {
        missing++;
        return;
      }
      const e = [X[0] - truth[j][0], X[1] - truth[j][1], X[2] - truth[j][2]];
      sq.d += (e[0] * depthDir[0] + e[1] * depthDir[1]) ** 2;
      sq.l += (e[0] * latDir[0] + e[1] * latDir[1]) ** 2;
      sq.v += e[2] ** 2;
      sq.n++;
    });
    const ta = computeAngles(truth, p.metrics);
    for (const k of METRIC_KEYS) {
      if (f.angles[k] !== null && ta[k] !== null) mErr[k].push(Math.abs(f.angles[k]! - ta[k]!));
    }
  });
  const rms = (s: number) => Math.sqrt(s / Math.max(1, sq.n)) * 100;
  return {
    depth: rms(sq.d),
    lateral: rms(sq.l),
    vertical: rms(sq.v),
    total: rms(sq.d + sq.l + sq.v),
    metrics: Object.fromEntries(
      METRIC_KEYS.map((k) => [k, mErr[k].length ? mErr[k].reduce((a, b) => a + b, 0) / mErr[k].length : NaN]),
    ),
    missing: missing / (frames.length * JOINT_INDICES.length),
  };
}

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const metricHeader = `| ${METRIC_KEYS.join(' | ')} |`;
const metricCells = (r: Result) => METRIC_KEYS.map((k) => f1(r.metrics[k])).join(' | ');

it('合成データの誤差レポートを出力する', () => {
  const lines: string[] = [];
  lines.push('# 合成データによる誤差のレポート', '');
  lines.push(`生成：${new Date().toISOString()}（\`npm run report\`）`, '');
  lines.push(
    '条件：周期3秒のスクワット（膝の曲げ5〜100°、体幹の前傾は膝の曲げ角度の0.35倍、つま先の開き15°、膝の入り込み最大3cm）、15秒、主10fps・副10fps（位相37msずれ、補間あり）、',
  );
  lines.push(
    '内部パラメータ fx=fy=1050px（720×1280、歪みあり）、カメラは腰の高さ（0.8m）を注視。関節位置の誤差はRMS（cm）、指標の誤差は平均絶対誤差（度）。',
    '',
  );
  lines.push('方向：奥行き＝2台のカメラの水平方向の二等分線、直交＝それに直交する水平方向、鉛直＝Z。', '');

  lines.push('## 1. 配置のプリセットごとの誤差', '');
  for (const sigma of [2, 5]) {
    for (const [label, p] of [
      ['平滑化なし', NO_FILTER],
      ['平滑化あり（params.jsonの係数）', P],
    ] as const) {
      lines.push(`### 2D誤差 σ=${sigma}px、${label}`, '');
      lines.push(`| プリセット | 奥行き | 直交 | 鉛直 | 合計 | 欠損率 ${metricHeader}`);
      lines.push(`|---|---|---|---|---|---|${METRIC_KEYS.map(() => '---').join('|')}|`);
      for (const pr of layout.presets) {
        const r = evaluate(pr, sigma, p);
        lines.push(
          `| ${pr.label} | ${f2(r.depth)} | ${f2(r.lateral)} | ${f2(r.vertical)} | ${f2(r.total)} | ${(r.missing * 100).toFixed(1)}% | ${metricCells(r)} |`,
        );
      }
      lines.push('');
    }
  }

  lines.push('## 2. 交差角による誤差（正面を中心に左右対称、距離2.5m・高さ1.0m、σ=5px、平滑化なし）', '');
  lines.push(
    '目安は spec 5.4.4節の式（σ_m＝σ×距離/fx：奥行き σ_m/(√2·sin(θ/2))、直交 σ_m/(√2·cos(θ/2))）。',
    '',
  );
  lines.push(`| 交差角 | 奥行き | 目安 | 直交 | 目安 | 鉛直 | 合計 ${metricHeader}`);
  lines.push(`|---|---|---|---|---|---|---|${METRIC_KEYS.map(() => '---').join('|')}|`);
  const sigmaM = (5 * 2.5) / 1050;
  const sweep: { theta: number; r: Result }[] = [];
  for (let theta = 30; theta <= 120; theta += 15) {
    const lay = {
      main: { azimuthDeg: -theta / 2, distanceM: 2.5, heightM: 1.0 },
      sub: { azimuthDeg: theta / 2, distanceM: 2.5, heightM: 1.0 },
    };
    const r = evaluate(lay, 5, NO_FILTER);
    sweep.push({ theta, r });
    const h = (theta * Math.PI) / 360;
    lines.push(
      `| ${theta}° | ${f2(r.depth)} | ${f2((sigmaM / (Math.SQRT2 * Math.sin(h))) * 100)} | ${f2(r.lateral)} | ${f2((sigmaM / (Math.SQRT2 * Math.cos(h))) * 100)} | ${f2(r.vertical)} | ${f2(r.total)} | ${metricCells(r)} |`,
    );
  }
  lines.push('');

  lines.push('## 3. One Euroフィルタの係数による比較（正面の左右、σ=5px）', '');
  lines.push('ノイズの減り方と遅れによる誤差のかね合い。「平滑化なし」が基準。', '');
  lines.push(`| minCutoff | beta | 合計(cm) ${metricHeader}`);
  lines.push(`|---|---|---|${METRIC_KEYS.map(() => '---').join('|')}|`);
  const front = layout.presets.find((x) => x.id === 'front-pair')!;
  const base = evaluate(front, 5, NO_FILTER);
  lines.push(`| 平滑化なし | — | ${f2(base.total)} | ${metricCells(base)} |`);
  const filterRows: { mc: number; beta: number; r: Result }[] = [];
  for (const mc of [0.5, 1, 2]) {
    for (const beta of [0.01, 1, 5, 10, 20]) {
      const p: Params = { ...P, fusion: { ...P.fusion, oneEuro: { minCutoff: mc, beta, dCutoff: 1 } } };
      const r = evaluate(front, 5, p);
      filterRows.push({ mc, beta, r });
      lines.push(`| ${mc} | ${beta} | ${f2(r.total)} | ${metricCells(r)} |`);
    }
  }
  lines.push('');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join('\n'));
  console.log(`report: ${outPath}`);

  // 最低限の健全性：交差角が大きいほど奥行き方向の誤差は小さくなる
  expect(sweep[sweep.length - 1].r.depth).toBeLessThan(sweep[0].r.depth);
  // beta=0.01は遅れが大きく、betaを上げると膝の曲げ角度の誤差が減る（spec 5.5の試算と同じ傾向）
  const kf = (mc: number, b: number) =>
    filterRows.find((x) => x.mc === mc && x.beta === b)!.r.metrics.kneeFlexL;
  expect(kf(1, 5)).toBeLessThan(kf(1, 0.01));
});
