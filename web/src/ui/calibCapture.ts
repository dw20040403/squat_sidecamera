// 校正画像撮影（spec 5.4.1）：チェッカーボードを15〜25枚撮影し、ZIPでまとめてダウンロードする
import { createZip } from '../record/zip';
import { downloadBlob } from '../util/download';
import type { DeviceCore } from './device';
import { h, openSheet, toast } from './dom';

export function openCalibCapture(core: DeviceCore): void {
  const shots: { blob: Blob; url: string; w: number; h: number }[] = [];
  openSheet('校正画像撮影', (body, sheet) => {
    const preview = h('video', {
      playsinline: true,
      muted: true,
      autoplay: true,
      style: 'width:100%;max-height:55vh;background:black;object-fit:contain',
    });
    preview.srcObject = core.cam?.stream ?? null;
    void preview.play().catch(() => {});
    const count = h('span', {}, '0枚');
    const thumbs = h('div', { class: 'thumbs' });
    const update = () => (count.textContent = `${shots.length}枚（目安15〜25枚）`);
    body.append(
      h(
        'p',
        { class: 'note' },
        `チェッカーボード（既定：9×6の交点、1マス25mm）を、画面の端や斜めの向きも含めていろいろな位置で撮影します。解像度は計測時と同じ ${core.cam?.width}×${core.cam?.height}、deviceName は ${core.deviceName} です。`,
      ),
      preview,
      h(
        'div',
        { class: 'row', style: 'margin:8px 0' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              const s = await core.snapshotPng();
              shots.push({ ...s, url: URL.createObjectURL(s.blob) });
              thumbs.appendChild(h('img', { src: shots[shots.length - 1].url }));
              update();
            },
          },
          '撮影',
        ),
        count,
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              if (!shots.length) return toast('まだ撮影していません');
              const entries = await Promise.all(
                shots.map(async (s, i) => ({
                  name: `calib-${core.deviceName}-${String(i + 1).padStart(2, '0')}.png`,
                  data: new Uint8Array(await s.blob.arrayBuffer()),
                })),
              );
              entries.push({
                name: 'info.json',
                data: new TextEncoder().encode(
                  JSON.stringify(
                    {
                      deviceName: core.deviceName,
                      imageSize: [core.cam?.width, core.cam?.height],
                      camera: core.cam?.label,
                      date: new Date().toISOString(),
                    },
                    null,
                    2,
                  ),
                ),
              });
              downloadBlob(
                new Blob([createZip(entries) as BlobPart], { type: 'application/zip' }),
                `calib-${core.deviceName}.zip`,
              );
            },
          },
          'ZIPでダウンロード',
        ),
        h(
          'button',
          {
            class: 'btn ghost',
            onclick: () => {
              shots.forEach((s) => URL.revokeObjectURL(s.url));
              shots.length = 0;
              thumbs.replaceChildren();
              update();
            },
          },
          '消去',
        ),
      ),
      thumbs,
      h('p', { class: 'note' }, 'ダウンロードしたZIPをMacで展開し、次を実行します：'),
      h(
        'pre',
        { class: 'code' },
        `python3 tools/calibrate_intrinsics.py calib-${core.deviceName}.zip --device ${core.deviceName} --cols 9 --rows 6 --square 25`,
      ),
    );
    update();
    sheet.onClose = () => shots.forEach((s) => URL.revokeObjectURL(s.url));
  });
}
