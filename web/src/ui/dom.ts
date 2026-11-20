// 小さなDOMヘルパー
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined | null>;
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function')
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

export interface Sheet {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
  onClose: () => void;
}

/** 画面全体を覆う画面（設定・校正・一覧など） */
export function openSheet(title: string, build: (body: HTMLElement, sheet: Sheet) => void): Sheet {
  const body = h('div', { class: 'sheet-body' });
  const sheet: Sheet = {
    el: null as unknown as HTMLElement,
    body,
    onClose: () => {},
    close: () => {
      sheet.el.remove();
      sheet.onClose();
    },
  };
  sheet.el = h(
    'div',
    { class: 'sheet' },
    h(
      'div',
      { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'btn ghost', onclick: () => sheet.close() }, '閉じる'),
    ),
    body,
  );
  document.body.appendChild(sheet.el);
  build(body, sheet);
  return sheet;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, ms = 2500): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast' });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove('show'), ms);
}

/** 赤い警告ダイアログ（spec 5.9） */
export function alertDialog(title: string, message: string, detail?: string): Promise<void> {
  return new Promise((resolve) => {
    const el = h(
      'div',
      { class: 'alert-overlay', role: 'alertdialog' },
      h(
        'div',
        { class: 'alert-box' },
        h('h2', {}, title),
        h('p', { class: 'alert-msg' }, message),
        detail ? h('p', { class: 'alert-detail' }, detail) : null,
        h('button', { class: 'btn', onclick: () => (el.remove(), resolve()) }, 'OK'),
      ),
    );
    document.body.appendChild(el);
  });
}

export function fmtNum(v: number | null | undefined, digits = 0, unit = ''): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit}`;
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function labeled(label: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, label), input);
}
