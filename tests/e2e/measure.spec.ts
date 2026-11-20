// 測定の開始 → 異常による中止 → 記録の保存（偽のカメラには人が映っていないので、可視度の条件で中止される）
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { lookAtCamera } from '../synthetic/generator';
import { measuredLayout } from '../../web/src/calib/layout';

const HERE = dirname(fileURLToPath(import.meta.url));
const INTR_FILE = resolve(HERE, '../../config/intrinsics/_e2e-fake.json');
const NAME = '_e2e-fake';

test.afterAll(() => rmSync(INTR_FILE, { force: true }));

test('測定を開始し、異常で中止され、中止の原因つきで記録が保存される', async ({ browser }) => {
  // 偽のカメラは横長1280×720なので、それに合わせた仮の内部パラメータを置く
  const intr = {
    deviceName: NAME,
    imageSize: [1280, 720],
    K: { fx: 1000, fy: 1000, cx: 640, cy: 360 },
    dist: { k1: 0, k2: 0, p1: 0, p2: 0, k3: 0 },
    rms: 0,
    date: '2026-11-18',
    approximate: true,
  };
  writeFileSync(INTR_FILE, JSON.stringify(intr));
  const cm = lookAtCamera({ azimuthDeg: -45, distanceM: 2.5, heightM: 1 }, intr as never);
  const cs = lookAtCamera({ azimuthDeg: 45, distanceM: 2.5, heightM: 1 }, intr as never);
  const calib = {
    savedAt: Date.now(),
    main: {
      deviceName: NAME,
      extr: cm.extr,
      reprojErrPx: 0.5,
      videoSize: [1280, 720],
      markers: [0, 1, 2, 3],
      method: 'test',
    },
    sub: {
      deviceName: NAME,
      extr: cs.extr,
      reprojErrPx: 0.5,
      videoSize: [1280, 720],
      markers: [0, 1, 2, 3],
      method: 'test',
    },
    measured: measuredLayout(cm.extr, cs.extr),
  };
  const ctx = await browser.newContext({ permissions: ['camera'] });
  await ctx.addInitScript(
    ([name, c]) => {
      localStorage.setItem('squat.deviceName', JSON.stringify(name));
      if (location.search.includes('role=main') && !sessionStorage.getItem('init')) {
        localStorage.setItem('squat.extrinsics', JSON.stringify(c));
        localStorage.setItem('squat.recordVideo', 'true');
        sessionStorage.setItem('init', '1');
      }
    },
    [NAME, calib] as const,
  );
  const main = await ctx.newPage();
  const sub = await ctx.newPage();
  await main.goto('/?role=main');
  await sub.goto('/?role=sub');
  const start = main.getByRole('button', { name: '測定開始' });
  await expect(start).toBeEnabled({ timeout: 90_000 });
  await start.click();
  await expect(main.locator('.statusbar')).toContainText('測定中');
  // 赤い警告ダイアログ
  const dlg = main.locator('.alert-overlay');
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  await expect(dlg).toContainText('測定を中止しました');
  await expect(dlg).toContainText(/関節|処理速度|データが届きません/);
  await dlg.getByRole('button', { name: 'OK' }).click();
  await expect(main.locator('#toast')).toContainText('記録を保存しました', { timeout: 15_000 });
  // 一覧に「中止」と原因が出る
  await main.getByRole('button', { name: 'メニュー' }).click();
  await main.getByRole('button', { name: 'セッション一覧' }).click();
  await expect(main.locator('.sheet').last()).toContainText('中止：');
  await ctx.close();
});
