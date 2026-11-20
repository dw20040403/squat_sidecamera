// セッション一覧画面（spec 5.8）：日時、長さ、中止の有無。再生・ダウンロード・削除
import { ABORT_MESSAGES } from '../monitor/anomaly';
import { deleteSession, listSessions, loadSession, loadVideo, storageStatus } from '../record/store';
import { sessionToCsv, type Session } from '../record/session';
import { downloadBlob, downloadJson, downloadText, videoExt } from '../util/download';
import { clear, fmtDate, h, openSheet, toast } from './dom';
import { Player } from './playback';

export function exportSession(s: Session, kind: 'json' | 'csv'): void {
  if (kind === 'json') downloadJson(s, `session-${s.id}.json`);
  else downloadText(sessionToCsv(s), `session-${s.id}-metrics.csv`, 'text/csv');
}

export function openPlayback(s: Session, video: Blob | null, minVisibility: number): void {
  openSheet(`再生 ${s.id}`, (body, sheet) => {
    const p = new Player(s, video, minVisibility);
    body.appendChild(p.el);
    body.appendChild(
      h(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn small', onclick: () => exportSession(s, 'json') }, 'JSON'),
        h('button', { class: 'btn small', onclick: () => exportSession(s, 'csv') }, 'CSV'),
        video
          ? h(
              'button',
              {
                class: 'btn small',
                onclick: () => downloadBlob(video, `session-${s.id}-main.${videoExt(video.type)}`),
              },
              '映像',
            )
          : null,
      ),
    );
    sheet.onClose = () => p.dispose();
  });
}

export function openSessions(minVisibility: number): void {
  openSheet('セッション一覧', async (body) => {
    const st = h('p', { class: 'note' }, '');
    const list = h('div', {});
    body.append(st, list);
    const refresh = async () => {
      const s = await storageStatus();
      st.textContent = `保存容量：${s.usage !== null ? (s.usage / 1e6).toFixed(0) : '?'}MB / ${s.quota !== null ? (s.quota / 1e6).toFixed(0) : '?'}MB、${s.persisted ? '自動で消されない設定（persist）が有効' : 'Safariが保存データを自動で消すことがあります。必要なデータはダウンロードしてください'}`;
      clear(list);
      const items = await listSessions();
      if (!items.length) list.appendChild(h('p', { class: 'note' }, 'まだ記録がありません'));
      const tbl = h('table', {});
      for (const m of items) {
        const dur = m.endedAt
          ? ((m.endedAt - m.startedAt) / 1000).toFixed(1) + '秒'
          : '（記録中または異常終了）';
        tbl.appendChild(
          h(
            'tr',
            {},
            h(
              'td',
              {},
              h('div', {}, fmtDate(m.startedAt)),
              h(
                'div',
                { class: 'note' },
                `${m.id} ・ ${dur} ・ ${m.frameCount}フレーム ・ ${m.source === 'offline' ? 'オフライン' : 'リアルタイム'}${m.subjectId ? ` ・ ${m.subjectId}` : ''}${m.trialLabel ? ` ・ ${m.trialLabel}` : ''}`,
              ),
              m.aborted
                ? h(
                    'div',
                    { style: 'color:#ef4444;font-size:12px' },
                    `中止：${ABORT_MESSAGES[m.aborted.reason] ?? m.aborted.reason}`,
                  )
                : null,
            ),
            h(
              'td',
              {},
              h(
                'div',
                { class: 'row' },
                h(
                  'button',
                  {
                    class: 'btn small primary',
                    onclick: async () => {
                      const s = await loadSession(m.id);
                      if (!s) return toast('読み込めませんでした');
                      openPlayback(s, m.hasVideo ? await loadVideo(m.id) : null, minVisibility);
                    },
                  },
                  '再生',
                ),
                h(
                  'button',
                  {
                    class: 'btn small',
                    onclick: async () => {
                      const s = await loadSession(m.id);
                      if (s) exportSession(s, 'json');
                    },
                  },
                  'JSON',
                ),
                h(
                  'button',
                  {
                    class: 'btn small',
                    onclick: async () => {
                      const s = await loadSession(m.id);
                      if (s) exportSession(s, 'csv');
                    },
                  },
                  'CSV',
                ),
                m.hasVideo
                  ? h(
                      'button',
                      {
                        class: 'btn small',
                        onclick: async () => {
                          const v = await loadVideo(m.id);
                          if (v) downloadBlob(v, `session-${m.id}-main.${videoExt(v.type)}`);
                        },
                      },
                      '映像',
                    )
                  : null,
                h(
                  'button',
                  {
                    class: 'btn small ghost',
                    onclick: async () => {
                      if (!confirm(`セッション ${m.id} を削除しますか？（元に戻せません）`)) return;
                      await deleteSession(m.id);
                      await refresh();
                    },
                  },
                  '削除',
                ),
              ),
            ),
          ),
        );
      }
      list.appendChild(tbl);
    };
    await refresh();
  });
}
