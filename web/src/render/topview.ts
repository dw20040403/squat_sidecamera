// カメラ配置を上から見た図（spec 5.4.4）：被験者、2台のカメラ、視線、交差角
import { crossingAngleDeg, layoutToPosition } from '../calib/layout';
import type { LayoutCamera } from '../params';
import { syncCanvasSize } from './view2d';

export interface TopViewData {
  planned: { main: LayoutCamera; sub: LayoutCamera };
  measured?: { main: LayoutCamera; sub: LayoutCamera } | null;
}

export function drawTopView(canvas: HTMLCanvasElement, d: TopViewData): void {
  const { w, h } = syncCanvasSize(canvas);
  const ctx = canvas.getContext('2d')!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.fillStyle = '#0b0f17';
  ctx.fillRect(0, 0, w, h);
  const maxD =
    Math.max(
      3,
      d.planned.main.distanceM,
      d.planned.sub.distanceM,
      d.measured?.main.distanceM ?? 0,
      d.measured?.sub.distanceM ?? 0,
    ) * 1.2;
  const s = Math.min(w, h) / 2 / maxD;
  const cx = w / 2;
  const cy = h / 2;
  // 世界のX→右、Y（被験者の前）→上
  const P = (x: number, y: number) => [cx + x * s, cy - y * s] as const;
  // 距離の目盛り
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1;
  for (let r = 1; r <= maxD; r++) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * s, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#6b7280';
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.fillText('1m', cx + s + 2, cy - 2);
  // 被験者（正面の向きを三角で）
  ctx.fillStyle = '#e5e7eb';
  ctx.beginPath();
  ctx.arc(cx, cy, 8 * dpr, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  const [fx, fy] = P(0, 0.45);
  ctx.moveTo(fx, fy);
  ctx.lineTo(cx - 6 * dpr, cy - 10 * dpr);
  ctx.lineTo(cx + 6 * dpr, cy - 10 * dpr);
  ctx.closePath();
  ctx.fill();
  ctx.fillText('正面', fx + 6 * dpr, fy);

  const drawCam = (c: LayoutCamera, color: string, label: string, dashed: boolean) => {
    const [x, y] = layoutToPosition(c);
    const [px, py] = P(x, y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash(dashed ? [6 * dpr, 4 * dpr] : []);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.rect(px - 7 * dpr, py - 7 * dpr, 14 * dpr, 14 * dpr);
    if (dashed) ctx.stroke();
    else ctx.fill();
    ctx.fillText(label, px + 10 * dpr, py + 4 * dpr);
  };
  drawCam(d.planned.main, '#3b82f6', `主 ${d.planned.main.azimuthDeg.toFixed(0)}°`, false);
  drawCam(d.planned.sub, '#f97316', `副 ${d.planned.sub.azimuthDeg.toFixed(0)}°`, false);
  if (d.measured) {
    drawCam(d.measured.main, '#93c5fd', '主(実測)', true);
    drawCam(d.measured.sub, '#fdba74', '副(実測)', true);
  }
  ctx.fillStyle = '#e5e7eb';
  ctx.font = `${13 * dpr}px sans-serif`;
  ctx.fillText(`交差角 ${crossingAngleDeg(d.planned.main, d.planned.sub).toFixed(0)}°`, 8 * dpr, 18 * dpr);
  if (d.measured)
    ctx.fillText(`実測 ${crossingAngleDeg(d.measured.main, d.measured.sub).toFixed(1)}°`, 8 * dpr, 36 * dpr);
}
