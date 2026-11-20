// カメラ配置の設定と確認の画面（spec 5.4.4）
import { compareLayout, crossingAngleDeg, layoutWarnings, triangulationErrorEstimate } from '../calib/layout';
import { focalPx } from '../fusion/camera';
import type { LayoutCamera } from '../params';
import { drawTopView } from '../render/topview';
import type { MainContext } from './mainContext';
import { clear, fmtNum, h, labeled, openSheet } from './dom';

export function openLayoutScreen(ctx: MainContext): void {
  const cfg = ctx.cfg.layout;
  openSheet('カメラ配置', (body) => {
    const sel = ctx.layoutSel;
    const preset = h(
      'select',
      {},
      h('option', { value: '' }, '手で入力'),
      ...cfg.presets.map((p) => h('option', { value: p.id, selected: p.id === sel.presetId }, p.label)),
    );
    const inputs = (role: 'main' | 'sub') => {
      const mk = (k: keyof LayoutCamera, step: number) => {
        const i = h('input', { type: 'number', step, value: sel[role][k] });
        i.addEventListener('input', () => {
          sel[role][k] = Number(i.value);
          sel.presetId = null;
          preset.value = '';
          refresh();
        });
        return i;
      };
      return { az: mk('azimuthDeg', 1), d: mk('distanceM', 0.05), hh: mk('heightM', 0.05) };
    };
    const im = inputs('main');
    const is = inputs('sub');
    preset.addEventListener('change', () => {
      const p = cfg.presets.find((x) => x.id === preset.value);
      if (p) {
        sel.presetId = p.id;
        sel.main = { ...p.main };
        sel.sub = { ...p.sub };
        im.az.value = String(p.main.azimuthDeg);
        im.d.value = String(p.main.distanceM);
        im.hh.value = String(p.main.heightM);
        is.az.value = String(p.sub.azimuthDeg);
        is.d.value = String(p.sub.distanceM);
        is.hh.value = String(p.sub.heightM);
      }
      refresh();
    });
    const canvas = h('canvas', { class: 'topview' });
    const info = h('div', {});
    body.append(
      labeled('プリセット', preset),
      h(
        'div',
        { class: 'grid3' },
        h('b', {}, '主端末'),
        h('span', {}, ''),
        h('span', {}, ''),
        labeled('方位角（°）', im.az),
        labeled('距離（m）', im.d),
        labeled('高さ（m）', im.hh),
      ),
      h(
        'div',
        { class: 'grid3' },
        h('b', {}, '副端末'),
        h('span', {}, ''),
        h('span', {}, ''),
        labeled('方位角（°）', is.az),
        labeled('距離（m）', is.d),
        labeled('高さ（m）', is.hh),
      ),
      h(
        'p',
        { class: 'note' },
        '方位角は被験者の正面を0°とし、被験者の右回り（上から見て時計回り）を正とします。三角測量の計算には、常に外部校正の結果を使います（ここでの設定は設置の目標・確認・記録のためのものです）。',
      ),
      canvas,
      info,
    );
    const refresh = () => {
      ctx.saveLayout(sel);
      const measured = ctx.calib?.measured ?? null;
      drawTopView(canvas, { planned: sel, measured });
      clear(info);
      for (const w of layoutWarnings(sel.main, sel.sub, cfg))
        info.appendChild(h('div', { class: 'warnbox' }, '注意：', w));
      const theta = measured ? measured.crossingAngleDeg : crossingAngleDeg(sel.main, sel.sub);
      const f = ctx.core.intr ? focalPx(ctx.core.intr) : 1050;
      const dist = measured
        ? (measured.main.distanceM + measured.sub.distanceM) / 2
        : (sel.main.distanceM + sel.sub.distanceM) / 2;
      const est = triangulationErrorEstimate(ctx.cfg.params.expected2dErrPx, f, dist, theta);
      info.appendChild(
        h(
          'div',
          { class: 'note' },
          `誤差の目安（2D誤差${ctx.cfg.params.expected2dErrPx}px、${measured ? '実測' : '設定'}の配置、交差角${theta.toFixed(0)}°）：奥行き方向 ${fmtNum(est.depthM * 100, 1)}cm、直交方向 ${fmtNum(est.lateralM * 100, 1)}cm（1台あたり ${fmtNum(est.sigmaM * 100, 1)}cm）`,
        ),
      );
      if (measured) {
        const diffs = compareLayout(sel, measured, cfg.tolerance);
        const tbl = h(
          'table',
          {},
          h(
            'tr',
            {},
            h('th', {}, ''),
            h('th', { class: 'num' }, '方位角'),
            h('th', { class: 'num' }, '距離'),
            h('th', { class: 'num' }, '高さ'),
          ),
        );
        for (const role of ['main', 'sub'] as const) {
          const m = measured[role];
          const p = sel[role];
          tbl.appendChild(
            h(
              'tr',
              {},
              h('td', {}, role === 'main' ? '主（実測/設定）' : '副（実測/設定）'),
              h('td', { class: 'num' }, `${m.azimuthDeg.toFixed(1)}° / ${p.azimuthDeg}°`),
              h('td', { class: 'num' }, `${m.distanceM.toFixed(2)} / ${p.distanceM}m`),
              h('td', { class: 'num' }, `${m.heightM.toFixed(2)} / ${p.heightM}m`),
            ),
          );
        }
        info.append(h('h3', {}, `校正後の比較（交差角 実測 ${measured.crossingAngleDeg.toFixed(1)}°）`), tbl);
        if (diffs.length)
          for (const d of diffs)
            info.appendChild(
              h(
                'div',
                { class: 'warnbox' },
                `警告：${d.role === 'main' ? '主端末' : '副端末'}の${{ azimuthDeg: '方位角', distanceM: '距離', heightM: '高さ' }[d.item]}が設定と${Math.abs(d.diff).toFixed(d.item === 'azimuthDeg' ? 1 : 2)}${d.item === 'azimuthDeg' ? '°' : 'm'}ずれています（許容範囲外）`,
              ),
            );
        else info.appendChild(h('div', { class: 'okbox' }, '実測の配置は設定の許容範囲内です'));
      } else
        info.appendChild(h('p', { class: 'note' }, '外部校正を行うと、実測の配置との比較を表示します。'));
    };
    refresh();
  });
}
