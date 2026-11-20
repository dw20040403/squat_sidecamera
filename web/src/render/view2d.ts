// canvasに2D骨格を描く（点と棒）。可視度が低い点は半透明
import { BONES, jointSide, type Pose2D } from '../fusion/landmarks';
import { SIDE_COLORS } from './colors';

export interface Draw2DOptions {
  minVisibility: number;
  /** 描画先の座標系への倍率（映像の画素→canvasの画素） */
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  lineWidth?: number;
  radius?: number;
  /** 関節ごとの無効の印（3D統合で無効になった関節など） */
  invalid?: Set<number>;
}

export function drawSkeleton2D(ctx: CanvasRenderingContext2D, pose: Pose2D, o: Draw2DOptions): void {
  const s = o.scale ?? 1;
  const ox = o.offsetX ?? 0;
  const oy = o.offsetY ?? 0;
  const P = (i: number) => [pose[i][0] * s + ox, pose[i][1] * s + oy] as const;
  const alpha = (i: number) => (pose[i][2] < o.minVisibility || o.invalid?.has(i) ? 0.3 : 1);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = o.lineWidth ?? 4;
  for (const b of BONES) {
    const [x1, y1] = P(b.a);
    const [x2, y2] = P(b.b);
    ctx.globalAlpha = Math.min(alpha(b.a), alpha(b.b));
    ctx.strokeStyle = SIDE_COLORS[b.side];
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  const r = o.radius ?? 5;
  for (const i of [0, ...Array.from({ length: 22 }, (_, k) => 11 + k)]) {
    if (i >= 17 && i <= 22) continue; // 手の点は省く
    const [x, y] = P(i);
    ctx.globalAlpha = alpha(i);
    ctx.fillStyle = SIDE_COLORS[jointSide(i)];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 映像（w×h）をcanvasに収めるための倍率とオフセット（contain） */
export function fitContain(
  w: number,
  h: number,
  cw: number,
  ch: number,
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(cw / w, ch / h);
  return { scale, offsetX: (cw - w * scale) / 2, offsetY: (ch - h * scale) / 2 };
}

/** canvasの大きさを表示サイズ×devicePixelRatioに合わせる */
export function syncCanvasSize(c: HTMLCanvasElement): { w: number; h: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return { w, h };
}
