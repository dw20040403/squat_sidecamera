// オフラインモードの画面（offline.html）。MacのChromeやSafariでも動く
import '../styles.css';
import { loadConfig } from '../configLoader';
import { mergeDeep, type Params } from '../params';
import type { Delegate } from '../pose/landmarker';
import { isSession, sessionStats, type Session, type SessionStats } from '../record/session';
import { saveSession } from '../record/store';
import type { CalibrationFile, RecordingMeta } from '../ui/calibState';
import { clear, fmtNum, h, labeled, toast } from '../ui/dom';
import { Player } from '../ui/playback';
import { exportSession } from '../ui/sessionsScreen';
import { METRIC_KEYS, METRIC_LABELS } from '../metrics/angles';
import {
  buildOfflineSession,
  camerasFromCalibration,
  inferVideos,
  recomputeSession,
  type Inferred2D,
} from './runner';

interface OfflineState {
  state: 'idle' | 'running' | 'done' | 'error';
  error?: string;
  progress?: number;
  stats?: SessionStats;
  session?: Session;
}

declare global {
  interface Window {
    __offline: OfflineState;
  }
}

const files: {
  mainVideo?: File;
  subVideo?: File;
  mainMeta?: RecordingMeta;
  subMeta?: RecordingMeta;
  calibration?: CalibrationFile;
  session?: Session;
  names: Record<string, string>;
} = { names: {} };

let cache2d: Inferred2D | null = null;
let player: Player | null = null;
const runs: { label: string; stats: SessionStats }[] = [];

async function readJson<T>(f: File): Promise<T> {
  return JSON.parse(await f.text()) as T;
}

/** ファイル名から役割を判断する */
async function assignFile(f: File): Promise<string> {
  const n = f.name.toLowerCase();
  if (f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/.test(n)) {
    if (n.startsWith('sub')) files.subVideo = f;
    else files.mainVideo = f;
    return n.startsWith('sub') ? 'subVideo' : 'mainVideo';
  }
  const j = await readJson<unknown>(f);
  if (isSession(j)) {
    files.session = j;
    return 'session';
  }
  const o = j as Record<string, unknown>;
  if (o && o.version === 1 && o.main && o.sub && (o.main as Record<string, unknown>).extrinsics) {
    files.calibration = j as CalibrationFile;
    return 'calibration';
  }
  if (o && (o.role === 'main' || o.role === 'sub') && typeof o.recordStartedAt === 'number') {
    if (o.role === 'main') files.mainMeta = j as RecordingMeta;
    else files.subMeta = j as RecordingMeta;
    return o.role === 'main' ? 'mainMeta' : 'subMeta';
  }
  throw new Error(`${f.name}：形式がわかりません`);
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  window.__offline = { state: 'idle' };
  const cfg = await loadConfig();
  const q = new URLSearchParams(location.search);

  const page = h('div', { style: 'max-width:960px;margin:0 auto;padding:12px' });
  root.appendChild(page);
  page.appendChild(h('h1', { style: 'font-size:20px' }, 'オフラインモード'));
  page.appendChild(
    h(
      'p',
      { class: 'note' },
      'テスト録画した2本の動画（main.mp4・sub.mp4）と付随データ（main-meta.json・sub-meta.json・calibration.json）を読み込み、リアルタイム処理と同じモジュールで処理します。記録したセッションのJSONを読み込むと、2Dデータから統合と指標だけを計算し直します。',
    ),
  );

  // 1. ファイル
  const assign = h('table', {});
  const showAssign = () => {
    clear(assign);
    const rows: [string, string, boolean][] = [
      ['主カメラの動画', files.names.mainVideo ?? '', !!files.mainVideo],
      ['副カメラの動画', files.names.subVideo ?? '', !!files.subVideo],
      ['main-meta.json', files.names.mainMeta ?? '', !!files.mainMeta],
      ['sub-meta.json', files.names.subMeta ?? '', !!files.subMeta],
      ['calibration.json', files.names.calibration ?? '', !!files.calibration],
      ['セッションのJSON（再計算）', files.names.session ?? '', !!files.session],
    ];
    for (const [label, name, ok] of rows)
      assign.appendChild(h('tr', {}, h('td', {}, ok ? '✓ ' : '　', label), h('td', { class: 'note' }, name)));
  };
  const input = h('input', {
    type: 'file',
    multiple: true,
    accept: 'video/*,.json,.mp4,.webm,.mov',
    'data-testid': 'files',
  });
  input.addEventListener('change', async () => {
    for (const f of Array.from(input.files ?? [])) {
      try {
        const role = await assignFile(f);
        files.names[role] = f.name;
      } catch (e) {
        toast((e as Error).message, 4000);
      }
    }
    showAssign();
    updateButtons();
  });
  page.append(h('h3', {}, '1. ファイルを選ぶ（まとめて選べます）'), input, assign);
  showAssign();

  // 2. 設定
  const offset = h('input', {
    type: 'number',
    min: -500,
    max: 500,
    step: 5,
    value: 0,
    'data-testid': 'offset',
  });
  const offsetRange = h('input', { type: 'range', min: -500, max: 500, step: 5, value: 0 });
  offset.addEventListener('input', () => (offsetRange.value = offset.value));
  offsetRange.addEventListener('input', () => (offset.value = offsetRange.value));
  const step = h('input', { type: 'number', min: 33, max: 500, step: 1, value: 100 });
  const delegate = h(
    'select',
    { 'data-testid': 'delegate' },
    ...['auto', 'CPU', 'GPU'].map((d) =>
      h('option', { value: d, selected: (q.get('delegate') ?? 'auto') === d }, d),
    ),
  );
  const model = h(
    'select',
    {},
    ...['full', 'lite', 'heavy'].map((m) =>
      h('option', { value: m, selected: cfg.params.poseModel === m }, m),
    ),
  );
  const paramText = h('textarea', {
    rows: 10,
    style: 'width:100%;font-family:monospace;font-size:12px',
    'data-testid': 'params',
  });
  paramText.value = JSON.stringify({ fusion: cfg.params.fusion, metrics: cfg.params.metrics }, null, 2);
  page.append(
    h('h3', {}, '2. 設定'),
    h('div', { class: 'row' }, labeled('副端末の時刻の補正（ms、±500）', offset), offsetRange),
    h(
      'div',
      { class: 'row' },
      labeled('刻み（ms）', step),
      labeled('デリゲート', delegate),
      labeled('モデル', model),
    ),
    h(
      'details',
      {},
      h('summary', {}, '統合のパラメータ（開発者向け：変えて「再計算」で比較できます）'),
      paramText,
    ),
  );

  // 3. 実行
  const progress = h('progress', { max: 1, value: 0, style: 'width:100%' });
  const status = h('div', { class: 'note', 'data-testid': 'status' }, '');
  const signal = { cancelled: false };
  const runBtn = h('button', { class: 'btn primary', 'data-testid': 'run' }, '推論して処理');
  const recomputeBtn = h('button', { class: 'btn', 'data-testid': 'recompute' }, '再計算（推論しない）');
  const cancelBtn = h('button', { class: 'btn ghost', onclick: () => (signal.cancelled = true) }, '中止');
  page.append(
    h('h3', {}, '3. 処理'),
    h('div', { class: 'row' }, runBtn, recomputeBtn, cancelBtn),
    progress,
    status,
  );

  const results = h('div', {});
  const compare = h('div', {});
  page.append(h('h3', {}, '4. 結果'), compare, results);

  const updateButtons = () => {
    runBtn.disabled = !(
      files.mainVideo &&
      files.subVideo &&
      files.mainMeta &&
      files.subMeta &&
      files.calibration
    );
    recomputeBtn.disabled = !(cache2d || files.session);
  };
  updateButtons();

  const currentParams = (): Params => {
    try {
      return mergeDeep(cfg.params, JSON.parse(paramText.value));
    } catch {
      throw new Error('統合のパラメータのJSONが正しくありません');
    }
  };

  const show = (s: Session, label: string) => {
    const st = sessionStats(s);
    runs.push({ label, stats: st });
    window.__offline = { state: 'done', stats: st, session: s };
    clear(results);
    player?.dispose();
    const video = files.mainVideo && s.video ? files.mainVideo : null;
    player = new Player(s, video, cfg.params.fusion.minVisibility);
    results.append(
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', onclick: () => exportSession(s, 'json') }, `session-${s.id}.json`),
        h('button', { class: 'btn', onclick: () => exportSession(s, 'csv') }, 'CSV'),
        h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              await saveSession(s, video);
              toast('このブラウザのセッション一覧に保存しました');
            },
          },
          '一覧に保存',
        ),
      ),
      h('div', { style: 'height:70vh;margin-top:8px' }, player.el),
    );
    renderCompare();
    status.textContent = `完了：${st.frames}フレーム、再投影誤差の平均 ${fmtNum(st.meanReprojErrPx, 2)}px、関節の欠損率 ${(st.jointMissingRate * 100).toFixed(1)}%`;
  };

  const renderCompare = () => {
    clear(compare);
    const t = h(
      'table',
      { 'data-testid': 'report' },
      h(
        'tr',
        {},
        h('th', {}, '実行'),
        h('th', { class: 'num' }, 'フレーム'),
        h('th', { class: 'num' }, '再投影誤差'),
        h('th', { class: 'num' }, '関節の欠損率'),
        h('th', { class: 'num' }, '左右補正'),
        ...METRIC_KEYS.map((k) => h('th', { class: 'num' }, `${METRIC_LABELS[k]}（範囲・欠損率）`)),
      ),
    );
    for (const r of runs) {
      t.appendChild(
        h(
          'tr',
          {},
          h('td', {}, r.label),
          h('td', { class: 'num' }, String(r.stats.frames)),
          h('td', { class: 'num' }, fmtNum(r.stats.meanReprojErrPx, 2, 'px')),
          h('td', { class: 'num' }, `${(r.stats.jointMissingRate * 100).toFixed(1)}%`),
          h('td', { class: 'num' }, `${(r.stats.swapRate * 100).toFixed(0)}%`),
          ...METRIC_KEYS.map((k) => {
            const m = r.stats.metrics[k];
            return h(
              'td',
              { class: 'num' },
              `${fmtNum(m.min, 0)}〜${fmtNum(m.max, 0)}° ${(m.missingRate * 100).toFixed(0)}%`,
            );
          }),
        ),
      );
    }
    compare.append(h('div', { style: 'overflow-x:auto' }, t));
  };

  runBtn.addEventListener('click', async () => {
    signal.cancelled = false;
    window.__offline = { state: 'running', progress: 0 };
    status.textContent = '推論中…';
    runBtn.disabled = true;
    try {
      const params = currentParams();
      const cams = camerasFromCalibration(files.calibration!, files.mainMeta, files.subMeta);
      const t0 = performance.now();
      cache2d = await inferVideos({
        mainVideo: files.mainVideo!,
        subVideo: files.subVideo!,
        mainMeta: files.mainMeta!,
        subMeta: files.subMeta!,
        offsetMs: Number(offset.value) || 0,
        stepMs: Number(step.value) || 100,
        delegate: delegate.value as Delegate | 'auto',
        model: model.value as Params['poseModel'],
        signal,
        onProgress: (d, n) => {
          progress.value = d / n;
          window.__offline.progress = d / n;
          status.textContent = `推論中… ${d}/${n}（${((performance.now() - t0) / 1000).toFixed(0)}秒）`;
        },
      });
      const s = buildOfflineSession(cache2d, cams, params, {
        calibration: files.calibration,
        mainMeta: files.mainMeta,
        subMeta: files.subMeta,
        sourceFiles: [
          files.names.mainVideo,
          files.names.subVideo,
          files.names.mainMeta,
          files.names.subMeta,
          files.names.calibration,
        ].filter(Boolean) as string[],
      });
      show(s, `推論（${cache2d.delegate}、補正${cache2d.offsetMs}ms）`);
    } catch (e) {
      window.__offline = { state: 'error', error: (e as Error).message };
      status.textContent = `エラー：${(e as Error).message}`;
    } finally {
      runBtn.disabled = false;
      updateButtons();
    }
  });

  recomputeBtn.addEventListener('click', () => {
    try {
      const params = currentParams();
      window.__offline = { state: 'running' };
      if (cache2d && files.calibration) {
        const cams = camerasFromCalibration(files.calibration, files.mainMeta, files.subMeta);
        show(
          buildOfflineSession(cache2d, cams, params, {
            calibration: files.calibration,
            mainMeta: files.mainMeta,
            subMeta: files.subMeta,
            sourceFiles: [],
          }),
          `再計算 ${runs.length + 1}`,
        );
      } else if (files.session) {
        show(recomputeSession(files.session, params), `セッションの再計算 ${runs.length + 1}`);
      }
    } catch (e) {
      window.__offline = { state: 'error', error: (e as Error).message };
      status.textContent = `エラー：${(e as Error).message}`;
    }
  });
}

void boot();
