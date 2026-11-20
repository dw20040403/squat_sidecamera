// 校正の確認画面（spec 5.4.2、plan フェーズ4 手順7）：人が立った状態で三角測量し、再投影誤差と身長方向の長さを表示する
import { cameraCenter } from '../fusion/camera';
import type { FusedFrame } from '../fusion/fuser';
import { LM } from '../fusion/landmarks';
import { cameraAzimuthInBody } from '../metrics/angles';
import { MovingAverage } from '../monitor/fps';
import { wrapDeg } from '../calib/layout';
import type { MainContext } from './mainContext';
import { fmtNum, h, openSheet } from './dom';

export function openCalibCheck(ctx: MainContext): void {
  openSheet('校正の確認', (body, sheet) => {
    if (!ctx.calib) {
      body.appendChild(h('div', { class: 'errbox' }, '外部校正がまだです'));
      return;
    }
    const err = new MovingAverage(30);
    const height = new MovingAverage(30);
    const out = h('table', {});
    const row = (label: string) => {
      const v = h('td', { class: 'num' }, '—');
      out.appendChild(h('tr', {}, h('td', {}, label), v));
      return v;
    };
    const cErr = row('再投影誤差の平均（直近30フレーム）');
    const cValid = row('有効な関節の数');
    const cHeight = row('足首から肩までの高さ（m）');
    const cAzM = row('主カメラの方位角（体の正面基準）');
    const cAzS = row('副カメラの方位角（体の正面基準）');
    const cSwap = row('左右の入れ替え');
    const planned = ctx.layoutSel;
    body.append(
      h(
        'p',
        { class: 'note' },
        'ボードを取り除き、被験者に計測位置で正面を向いて立ってもらいます。再投影誤差の平均が5px程度以下なら良好です。体の正面を基準にしたカメラの方位角で、想定と違う向きに立っていないか確認できます。',
      ),
      out,
      h(
        'p',
        { class: 'note' },
        `設定の方位角：主 ${planned.main.azimuthDeg}°、副 ${planned.sub.azimuthDeg}°`,
      ),
    );
    const cm = cameraCenter(ctx.calib.main.extr);
    const cs = cameraCenter(ctx.calib.sub.extr);
    const off = ctx.onFused((f: FusedFrame) => {
      if (f.quality.reprojErrPx !== null) err.push(f.quality.reprojErrPx);
      const J = f.joints;
      const sh = [J[LM.leftShoulder], J[LM.rightShoulder]].filter(Boolean);
      const an = [J[LM.leftAnkle], J[LM.rightAnkle]].filter(Boolean);
      if (sh.length && an.length)
        height.push(
          sh.reduce((s, p) => s + p![2], 0) / sh.length - an.reduce((s, p) => s + p![2], 0) / an.length,
        );
      cErr.textContent = fmtNum(err.value, 1, 'px');
      cErr.style.color = (err.value ?? 0) > 5 ? '#f59e0b' : '';
      cValid.textContent = `${f.quality.validJoints} / 23`;
      cHeight.textContent = fmtNum(height.value, 2);
      const azm = cameraAzimuthInBody(J, cm);
      const azs = cameraAzimuthInBody(J, cs);
      cAzM.textContent =
        azm === null
          ? '—'
          : `${azm.toFixed(0)}°（設定との差 ${wrapDeg(azm - planned.main.azimuthDeg).toFixed(0)}°）`;
      cAzS.textContent =
        azs === null
          ? '—'
          : `${azs.toFixed(0)}°（設定との差 ${wrapDeg(azs - planned.sub.azimuthDeg).toFixed(0)}°）`;
      cSwap.textContent = f.quality.swapApplied ? 'あり' : 'なし';
    });
    sheet.onClose = off;
  });
}
