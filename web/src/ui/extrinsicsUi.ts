// 外部校正の流れ（spec 5.4.2、plan フェーズ4 手順6）
import { loadDetector, type DetectorPreference, type LoadedDetector } from '../calib/aruco';
import { estimateExtrinsics, grabFrame, type ExtrinsicsResult } from '../calib/extrinsics';
import { measuredLayout } from '../calib/layout';
import type { BoardConfig } from '../params';
import { View3D } from '../render/view3d';
import { KEYS, loadJson } from '../util/storage';
import type { DeviceCore } from './device';
import type { MainContext } from './mainContext';
import { clear, fmtNum, h, openSheet, toast } from './dom';
import { openLayoutScreen } from './layoutScreen';

let detectorCache: Promise<LoadedDetector> | null = null;

export function getDetector(dictionary: string): Promise<LoadedDetector> {
  if (!detectorCache) {
    detectorCache = loadDetector(loadJson<DetectorPreference>(KEYS.arucoDetector, 'auto'), dictionary);
    detectorCache.catch(() => (detectorCache = null));
  }
  return detectorCache;
}

/** 映像の数フレームでマーカーを検出し、再投影誤差が最も小さい結果を返す */
export async function detectExtrinsics(
  core: DeviceCore,
  board: BoardConfig,
  onStatus: (s: string) => void,
  frames = 8,
): Promise<{ result: ExtrinsicsResult; detector: LoadedDetector }> {
  if (!core.intr) throw new Error(`内部パラメータ（${core.deviceName}）がありません`);
  if (!core.resolutionOk) throw new Error('映像の解像度が内部パラメータの校正時と一致しません');
  onStatus('マーカーの検出器を読み込み中…');
  const det = await getDetector(board.dictionary);
  onStatus(`検出中（${det.detector.name}、読み込み ${(det.loadMs / 1000).toFixed(1)}秒）…`);
  let best: ExtrinsicsResult | null = null;
  let maxMarkers = 0;
  for (let i = 0; i < frames; i++) {
    const img = grabFrame(core.video);
    const markers = det.detector.detect(img);
    maxMarkers = Math.max(maxMarkers, markers.length);
    const r = estimateExtrinsics(markers, board, core.intr, det.detector);
    if (
      r &&
      (!best ||
        r.markers.length > best.markers.length ||
        (r.markers.length === best.markers.length && r.reprojErrPx < best.reprojErrPx))
    )
      best = r;
    await new Promise((res) => setTimeout(res, 120));
  }
  if (!best) throw new Error(`ボードのマーカーが見つかりません（検出できたマーカー：最大${maxMarkers}個）`);
  return { result: best, detector: det };
}

export function openExtrinsicsScreen(ctx: MainContext): void {
  openSheet('外部校正', (body, sheet) => {
    const status = h('div', { class: 'note' }, '');
    const result = h('div', {});
    const view = h('div', {
      style: 'position:relative;height:300px;border-radius:8px;overflow:hidden;margin-top:8px',
    });
    let v3: View3D | null = null;
    const run = async () => {
      clear(result);
      runBtn.disabled = true;
      try {
        if (!ctx.peer.channelsOpen) throw new Error('副端末と接続されていません');
        status.textContent = '両端末でマーカーを検出しています…';
        const subP = ctx.requestSubExtrinsics(30_000);
        const mainR = await detectExtrinsics(
          ctx.core,
          ctx.cfg.board,
          (s) => (status.textContent = `主端末：${s}`),
        );
        status.textContent = '副端末の結果を待っています…';
        const subR = await subP;
        const measured = measuredLayout(mainR.result.extr, { R: subR.R, t: subR.t });
        const calib = {
          savedAt: Date.now(),
          main: {
            deviceName: ctx.core.deviceName,
            extr: mainR.result.extr,
            reprojErrPx: mainR.result.reprojErrPx,
            videoSize: [ctx.core.cam!.width, ctx.core.cam!.height] as [number, number],
            markers: mainR.result.markers,
            method: `${mainR.detector.detector.name}/${mainR.result.method}`,
          },
          sub: {
            deviceName: ctx.sub.deviceName ?? 'sub',
            extr: { R: subR.R, t: subR.t, reprojErrPx: subR.reprojErrPx },
            reprojErrPx: subR.reprojErrPx,
            videoSize: ctx.sub.videoSize ?? ([0, 0] as [number, number]),
            markers: [],
            method: subR.detector ?? '',
          },
          measured,
        };
        status.textContent = '';
        result.append(
          h(
            'div',
            {},
            h(
              'table',
              {},
              h(
                'tr',
                {},
                h('th', {}, ''),
                h('th', { class: 'num' }, '再投影誤差'),
                h('th', {}, 'マーカー'),
                h('th', {}, '方式'),
              ),
              h(
                'tr',
                {},
                h('td', {}, '主端末'),
                h('td', { class: 'num' }, fmtNum(mainR.result.reprojErrPx, 2, 'px')),
                h('td', {}, mainR.result.markers.join(',')),
                h('td', {}, calib.main.method),
              ),
              h(
                'tr',
                {},
                h('td', {}, '副端末'),
                h('td', { class: 'num' }, fmtNum(subR.reprojErrPx, 2, 'px')),
                h('td', {}, String(subR.markers ?? '')),
                h('td', {}, calib.sub.method),
              ),
            ),
            h(
              'p',
              {},
              `実測の配置：主 ${measured.main.azimuthDeg.toFixed(1)}° ${measured.main.distanceM.toFixed(2)}m 高さ${measured.main.heightM.toFixed(2)}m ／ 副 ${measured.sub.azimuthDeg.toFixed(1)}° ${measured.sub.distanceM.toFixed(2)}m 高さ${measured.sub.heightM.toFixed(2)}m ／ 交差角 ${measured.crossingAngleDeg.toFixed(1)}°`,
            ),
            mainR.detector.fallbackReason
              ? h(
                  'div',
                  { class: 'warnbox' },
                  `OpenCV.jsが使えなかったため js-aruco2 を使いました：${mainR.detector.fallbackReason}`,
                )
              : null,
            h(
              'div',
              { class: 'row' },
              h(
                'button',
                {
                  class: 'btn primary',
                  onclick: () => {
                    ctx.saveCalib(calib);
                    toast('外部校正の結果を保存しました');
                  },
                },
                '保存',
              ),
              h('button', { class: 'btn', onclick: () => openLayoutScreen(ctx) }, '配置と比較'),
            ),
          ),
        );
        if (!v3) {
          view.replaceChildren();
          v3 = new View3D(view);
        }
        v3.setCameras([
          { label: 'main', extr: calib.main.extr, color: 0x3b82f6 },
          { label: 'sub', extr: calib.sub.extr, color: 0xf97316 },
        ]);
        v3.preset('top');
        result.appendChild(view);
      } catch (e) {
        status.textContent = '';
        result.appendChild(h('div', { class: 'errbox' }, (e as Error).message));
      } finally {
        runBtn.disabled = false;
      }
    };
    const runBtn = h('button', { class: 'btn primary', onclick: () => void run() }, '検出して計算');
    body.append(
      h(
        'p',
        { class: 'note' },
        '床に置いたArUcoマーカーボード（config/board.json）を2台から同時に撮影し、各カメラの位置と向きを求めます。ボード全体が2台の画面に入っていることを確認してください。',
      ),
      runBtn,
      status,
      result,
    );
    if (ctx.calib)
      body.appendChild(
        h(
          'p',
          { class: 'note' },
          `保存済みの校正：${new Date(ctx.calib.savedAt).toLocaleString()}（主 ${ctx.calib.main.reprojErrPx.toFixed(2)}px、副 ${ctx.calib.sub.reprojErrPx.toFixed(2)}px）`,
        ),
      );
    sheet.onClose = () => v3?.dispose();
  });
}
