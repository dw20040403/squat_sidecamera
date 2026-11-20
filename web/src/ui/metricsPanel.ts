// 指標パネル（spec 5.7.2）：7項目を2列で、映像の下部に半透明で重ねて表示する
import { formatAngle, METRIC_KEYS, METRIC_LABELS, type Angles } from '../metrics/angles';
import { KEYS, loadJson, saveJson } from '../util/storage';
import { h } from './dom';

export class MetricsPanel {
  readonly el: HTMLElement;
  readonly toggle: HTMLButtonElement;
  private cells = new Map<string, HTMLElement>();

  constructor() {
    this.el = h('div', { class: 'metrics' });
    const order = [
      'kneeFlexL',
      'kneeFlexR',
      'toeOutL',
      'toeOutR',
      'kneeInL',
      'kneeInR',
      'trunkLean',
    ] as const;
    for (const k of order) {
      const v = h('b', {}, '—');
      this.cells.set(k, v);
      const side = k.endsWith('L') ? 'L' : k.endsWith('R') ? 'R' : 'C';
      this.el.appendChild(h('div', { class: `m ${side}` }, h('span', {}, METRIC_LABELS[k]), v));
    }
    this.toggle = h(
      'button',
      {
        class: 'btn small ghost panel-toggle',
        onclick: () => this.setVisible(this.el.classList.contains('hidden')),
      },
      '指標',
    );
    this.setVisible(loadJson(KEYS.panelVisible, true));
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
    saveJson(KEYS.panelVisible, v);
  }

  update(a: Angles | null): void {
    for (const k of METRIC_KEYS) this.cells.get(k)!.textContent = a ? formatAngle(a[k]) : '—';
  }
}
