// エントリーポイント：?role=main / ?role=sub で切り替える
import '../styles.css';
import { loadConfig } from '../configLoader';
import { h } from './dom';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const role = new URLSearchParams(location.search).get('role');
  if (role !== 'main' && role !== 'sub') {
    root.appendChild(
      h(
        'div',
        { class: 'home' },
        h('h1', {}, 'スクワット姿勢計測'),
        h('p', { class: 'note' }, '2台のiPhoneで、それぞれの役割を選んでください。'),
        h('a', { class: 'btn primary', href: '?role=main' }, '主端末（カメラA・表示・記録）'),
        h('a', { class: 'btn', href: '?role=sub' }, '副端末（カメラB）'),
        h('a', { class: 'btn ghost', href: '/offline.html' }, 'オフラインモード'),
      ),
    );
    return;
  }
  document.title = `${role === 'main' ? '主端末' : '副端末'} - スクワット姿勢計測`;
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    root.appendChild(
      h(
        'div',
        { class: 'home' },
        h('div', { class: 'errbox' }, `設定を読み込めませんでした：${(e as Error).message}`),
      ),
    );
    return;
  }
  if (role === 'main') {
    const { MainApp } = await import('./mainApp');
    const app = new MainApp(cfg, root);
    (window as unknown as { __app: unknown }).__app = app;
    await app.start();
  } else {
    const { SubApp } = await import('./subApp');
    const app = new SubApp(cfg, root);
    (window as unknown as { __app: unknown }).__app = app;
    await app.start();
  }
}

void boot();
