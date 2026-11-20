// オフラインモードの自動実行（回帰テスト）。plan フェーズ5 手順5
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { syntheticSession } from '../synthetic/session';

const HERE = dirname(fileURLToPath(import.meta.url));

type Stats = {
  frames: number;
  meanReprojErrPx: number | null;
  jointMissingRate: number;
  metrics: Record<
    string,
    { missingRate: number; min: number | null; max: number | null; mean: number | null }
  >;
};

type OfflineWindow = Window & { __offline: { state: string; error?: string; stats?: unknown } };

async function waitDone(page: import('@playwright/test').Page, timeout = 120_000): Promise<Stats> {
  await page.waitForFunction(
    () => {
      const o = (window as unknown as OfflineWindow).__offline;
      return o && (o.state === 'done' || o.state === 'error');
    },
    null,
    { timeout },
  );
  const st = await page.evaluate(() => (window as unknown as OfflineWindow).__offline);
  expect(st.state, st.error).toBe('done');
  return st.stats as unknown as Stats;
}

test('記録したセッションのJSONを読み込み、2Dデータから再計算できる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/offline.html');
  const s = syntheticSession();
  await page.getByTestId('files').setInputFiles({
    name: `session-${s.id}.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(s)),
  });
  await expect(page.getByTestId('recompute')).toBeEnabled();
  await page.getByTestId('recompute').click();
  const st = await waitDone(page);
  expect(st.frames).toBe(s.frames.length);
  expect(st.meanReprojErrPx!).toBeLessThan(6);
  expect(st.jointMissingRate).toBeLessThan(0.05);
  expect(st.metrics.kneeFlexL.max!).toBeGreaterThan(85);
  expect(st.metrics.kneeFlexL.min!).toBeLessThan(20);
  expect(st.metrics.trunkLean.max!).toBeGreaterThan(25);
  // 3D表示に切り替えられる
  await page.getByRole('button', { name: '④3D' }).click();
  await expect(page.locator('.view3d canvas')).toBeVisible();
  // パラメータを変えて再計算し、比較表に2行並ぶ
  const p = JSON.parse(await page.getByTestId('params').inputValue());
  p.fusion.oneEuro.beta = 20;
  await page.getByText('統合のパラメータ').click();
  await page.getByTestId('params').fill(JSON.stringify(p));
  await page.getByTestId('recompute').click();
  await waitDone(page);
  await expect(page.getByTestId('report').locator('tr')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('オフラインの結果を一覧に保存し、主端末のセッション一覧から再生できる', async ({ page }) => {
  await page.goto('/offline.html');
  const s = syntheticSession(6);
  await page.getByTestId('files').setInputFiles({
    name: 'session.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(s)),
  });
  await page.getByTestId('recompute').click();
  await waitDone(page);
  await page.getByRole('button', { name: '一覧に保存' }).click();
  await expect(page.locator('#toast')).toContainText('保存しました');

  await page.goto('/?role=main');
  await page.getByRole('button', { name: 'メニュー' }).click();
  await page.getByRole('button', { name: 'セッション一覧' }).click();
  await expect(page.locator('.sheet').last()).toContainText(`${s.id}-re`);
  await page.locator('.sheet').last().getByRole('button', { name: '再生' }).first().click();
  await expect(page.locator('canvas.chart')).toBeVisible();
  // CSVのダウンロード
  const dl = page.waitForEvent('download');
  await page.locator('.sheet').last().getByRole('button', { name: 'CSV' }).click();
  expect((await dl).suggestedFilename()).toMatch(/^session-.*-metrics\.csv$/);
});

test('動画からの推論の流れが最後まで動く（人の映っていない合成動画、CPUデリゲート）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/offline.html?delegate=CPU');
  // ページ内でcanvasの映像を2秒録画して、テスト用の動画を作る
  const vids = await page.evaluate(async () => {
    const rec = async (color: string) => {
      const c = document.createElement('canvas');
      c.width = 360;
      c.height = 640;
      const ctx = c.getContext('2d')!;
      const stream = c.captureStream(30);
      const mime = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';
      const r = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      let k = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = 'white';
        ctx.fillRect((k++ * 7) % 300, 300, 40, 40);
      }, 33);
      r.start(200);
      await new Promise((res) => setTimeout(res, 2000));
      r.stop();
      await new Promise((res) => (r.onstop = res));
      clearInterval(timer);
      const b = new Blob(chunks, { type: mime });
      const buf = new Uint8Array(await b.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return { b64: btoa(s), mime };
    };
    return [await rec('#204060'), await rec('#406020')];
  });
  const s = syntheticSession(1);
  const intr = { ...s.devices.main.intrinsics!, imageSize: [360, 640] };
  const t0 = 1_763_366_400_000;
  const meta = (role: string) => ({
    role,
    deviceName: role,
    intrinsics: intr,
    recordStartedAt: t0,
    videoSize: [360, 640],
    mimeType: vids[0].mime,
  });
  const calib = {
    version: 1,
    createdAt: t0,
    main: {
      deviceName: 'main',
      intrinsics: intr,
      extrinsics: s.devices.main.extrinsics,
      videoSize: [360, 640],
    },
    sub: { deviceName: 'sub', intrinsics: intr, extrinsics: s.devices.sub.extrinsics, videoSize: [360, 640] },
    layout: { planned: null, measured: null },
  };
  const ext = vids[0].mime.includes('webm') ? 'webm' : 'mp4';
  await page.getByTestId('files').setInputFiles([
    { name: `main.${ext}`, mimeType: vids[0].mime, buffer: Buffer.from(vids[0].b64, 'base64') },
    { name: `sub.${ext}`, mimeType: vids[1].mime, buffer: Buffer.from(vids[1].b64, 'base64') },
    {
      name: 'main-meta.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(meta('main'))),
    },
    { name: 'sub-meta.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(meta('sub'))) },
    { name: 'calibration.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(calib)) },
  ]);
  await expect(page.getByTestId('run')).toBeEnabled();
  await page.getByTestId('run').click();
  const st = await waitDone(page, 280_000);
  expect(st.frames).toBeGreaterThanOrEqual(15);
  // 人が映っていないので、3Dはすべて欠損になる
  expect(st.jointMissingRate).toBe(1);
  // 推論結果のキャッシュから再計算できる
  await page.getByTestId('recompute').click();
  await waitDone(page);
});

// 実際のスクワット動画による回帰テスト。tests/fixtures/videos/ に動画と付随データ、
// tests/fixtures/baseline.json に基準値を置くと実行する（todo.md フェーズ5：基準の動画を選ぶ）
const fx = resolve(HERE, '../fixtures/videos');
const names = ['main.mp4', 'sub.mp4', 'main-meta.json', 'sub-meta.json', 'calibration.json'];
const hasFixtures =
  names.every((n) => existsSync(resolve(fx, n))) && existsSync(resolve(HERE, '../fixtures/baseline.json'));

test('テスト動画の回帰テスト（CPUデリゲート）', async ({ page }) => {
  test.skip(!hasFixtures, 'tests/fixtures/videos/ にテスト動画がありません');
  test.setTimeout(900_000);
  const baseline = JSON.parse(readFileSync(resolve(HERE, '../fixtures/baseline.json'), 'utf8')) as {
    maxMeanReprojErrPx: number;
    maxJointMissingRate: number;
    metrics: Record<string, { min: [number, number]; max: [number, number]; maxMissingRate: number }>;
  };
  await page.goto('/offline.html?delegate=CPU');
  await page.getByTestId('files').setInputFiles(names.map((n) => resolve(fx, n)));
  await page.getByTestId('run').click();
  const st = await waitDone(page, 850_000);
  expect(st.meanReprojErrPx!).toBeLessThan(baseline.maxMeanReprojErrPx);
  expect(st.jointMissingRate).toBeLessThan(baseline.maxJointMissingRate);
  for (const [k, b] of Object.entries(baseline.metrics)) {
    const m = st.metrics[k];
    expect(m.missingRate, k).toBeLessThan(b.maxMissingRate);
    expect(m.min!, `${k} min`).toBeGreaterThanOrEqual(b.min[0]);
    expect(m.min!, `${k} min`).toBeLessThanOrEqual(b.min[1]);
    expect(m.max!, `${k} max`).toBeGreaterThanOrEqual(b.max[0]);
    expect(m.max!, `${k} max`).toBeLessThanOrEqual(b.max[1]);
  }
});
