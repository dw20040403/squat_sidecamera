// 主端末と副端末の接続（偽のカメラ）。シグナリング・WebRTC・時刻同期・姿勢データの受信を確認する
import { expect, test } from '@playwright/test';

test('主端末と副端末が接続し、時刻同期と姿勢データの受信ができる', async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ['camera'] });
  const errors: string[] = [];
  const open = async (role: 'main' | 'sub') => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${role}: ${e.message}`));
    await p.goto(`/?role=${role}`);
    return p;
  };
  const main = await open('main');
  const sub = await open('sub');
  await expect(main.locator('.statusbar')).toContainText('接続済み', { timeout: 60_000 });
  await expect(sub.locator('.statusbar')).toContainText('接続済み', { timeout: 60_000 });
  await expect(main.locator('.statusbar')).toContainText('ずれ', { timeout: 90_000 });
  // 副端末の受信レートが表示される
  await expect(main.locator('.statusbar')).not.toContainText('副—fps', { timeout: 60_000 });
  // 未校正なので測定は開始できず、理由が表示される
  await expect(main.getByRole('button', { name: '測定開始' })).toBeDisabled();
  await expect(main.locator('.reason')).toContainText('外部校正がまだです');
  // 副端末をリロードすると自動で再接続する
  await sub.reload();
  await expect(main.locator('.statusbar')).toContainText('接続済み', { timeout: 60_000 });
  // 同じ役割の2台目は拒否される
  const main2 = await ctx.newPage();
  await main2.goto('/?role=main');
  await expect(main2.locator('.statusbar')).toContainText('主端末が既にあります', { timeout: 60_000 });
  expect(errors).toEqual([]);
  await ctx.close();
});
