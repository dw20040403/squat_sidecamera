#!/usr/bin/env python3
"""ArUcoマーカーボードの印刷用PDFを作る（plan フェーズ4 手順1）。

config/board.json のマーカーの配置（世界座標、m）に従って実寸で描く。
実寸で印刷できたか確認するための目盛り（100mm）と、原点・軸の向きも入れる。

例:
  python3 tools/gen_aruco_board.py                 # A2に1枚（入らなければ自動で大きい用紙）
  python3 tools/gen_aruco_board.py --paper A3x2    # A3横2枚に上下で分割（のりしろの線つき）

印刷するときは「実際のサイズ（100%）」を選び、印刷後に目盛りとマーカーの1辺を実測して、
ずれていれば config/board.json の座標を実測値に直すこと。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PAPERS = {"A4": (210, 297), "A3": (297, 420), "A2": (420, 594), "A1": (594, 841)}


def mm2px(mm: float, dpi: int) -> int:
    return int(round(mm / 25.4 * dpi))


def font(size: int) -> ImageFont.ImageFont:
    for name in ["/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc",
                 "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_board(board: dict, dpi: int, margin_mm: float) -> tuple[Image.Image, tuple[float, float, float, float]]:
    dict_id = getattr(cv2.aruco, board["dictionary"])
    d = cv2.aruco.getPredefinedDictionary(dict_id)
    pts = np.array([c for m in board["markers"] for c in m["corners"]], dtype=float)
    if np.abs(pts[:, 2]).max() > 1e-9:
        raise SystemExit("ボードの点はZ=0（床面）である必要があります")
    xmin, ymin = pts[:, 0].min() * 1000 - margin_mm, pts[:, 1].min() * 1000 - margin_mm
    xmax, ymax = pts[:, 0].max() * 1000 + margin_mm, pts[:, 1].max() * 1000 + margin_mm
    W, H = mm2px(xmax - xmin, dpi), mm2px(ymax - ymin, dpi)
    img = Image.new("L", (W, H), 255)
    # 世界のX→画像の右、Y（被験者の前）→画像の上
    to_px = lambda x_m, y_m: (mm2px(x_m * 1000 - xmin, dpi), mm2px(ymax - y_m * 1000, dpi))
    draw = ImageDraw.Draw(img)
    for m in board["markers"]:
        c = np.array(m["corners"], dtype=float)
        tl = to_px(c[0][0], c[0][1])
        br = to_px(c[2][0], c[2][1])
        side = br[0] - tl[0]
        if abs((br[1] - tl[1]) - side) > 2:
            raise SystemExit(f"マーカー{m['id']}が正方形でないか、軸に沿っていません（4隅の順序：左上・右上・右下・左下）")
        mk = cv2.aruco.generateImageMarker(d, int(m["id"]), side)
        img.paste(Image.fromarray(mk), tl)
        draw.text((tl[0], br[1] + mm2px(1.5, dpi)), f"ID {m['id']}", fill=0, font=font(mm2px(4, dpi)))
    # 原点の十字と軸
    ox, oy = to_px(0, 0)
    L = mm2px(8, dpi)
    draw.line([(ox - L, oy), (ox + L, oy)], fill=128, width=max(1, mm2px(0.3, dpi)))
    draw.line([(ox, oy - L), (ox, oy + L)], fill=128, width=max(1, mm2px(0.3, dpi)))
    return img, (xmin, ymin, xmax, ymax)


def decorate(page: Image.Image, dpi: int, x0: int, y0: int, text: str) -> None:
    """目盛り（100mm）と説明を入れる"""
    draw = ImageDraw.Draw(page)
    f = font(mm2px(3.5, dpi))
    L = mm2px(100, dpi)
    y = page.height - mm2px(12, dpi)
    x = x0
    draw.line([(x, y), (x + L, y)], fill=0, width=mm2px(0.4, dpi))
    for k in range(11):
        hh = mm2px(4 if k % 5 == 0 else 2, dpi)
        xx = x + mm2px(10 * k, dpi)
        draw.line([(xx, y - hh), (xx, y)], fill=0, width=mm2px(0.3, dpi))
    draw.text((x + L + mm2px(3, dpi), y - mm2px(4, dpi)), "100 mm（実測して確認）", fill=0, font=f)
    draw.text((x0, y0), text, fill=0, font=f)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", type=Path, default=ROOT / "config" / "board.json")
    ap.add_argument("--out", type=Path, default=ROOT / "aruco_board.pdf")
    ap.add_argument("--paper", default="auto", help="auto / A4 / A3 / A2 / A1 / A3x2")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--margin", type=float, default=15.0, help="マーカーの外側の余白（mm）")
    args = ap.parse_args()

    board = json.loads(args.board.read_text(encoding="utf-8"))
    img, (xmin, ymin, xmax, ymax) = render_board(board, args.dpi, args.margin)
    bw, bh = xmax - xmin, ymax - ymin
    info = (f"{board['dictionary']}  マーカー1辺 {board['markerSizeM']*1000:.0f}mm  "
            f"上＝被験者の前（+Y）、右＝被験者の右（+X）、十字＝原点")
    pages: list[Image.Image] = []
    footer = 30  # 目盛りと説明の分（mm）

    if args.paper == "A3x2":
        # Y方向（上下）に2分割し、それぞれA3横に置く。10mmののりしろ
        pw, ph = PAPERS["A3"][1], PAPERS["A3"][0]
        overlap = 10
        half = bh / 2
        if bw + 20 > pw or half + overlap + footer + 10 > ph:
            raise SystemExit("A3横2枚に入りません。--paper A2 などを使ってください")
        for k in range(2):
            y_from = max(0.0, k * half - overlap / 2)
            y_to = min(bh, (k + 1) * half + overlap / 2)
            crop = img.crop((0, mm2px(y_from, args.dpi), img.width, mm2px(y_to, args.dpi)))
            page = Image.new("L", (mm2px(pw, args.dpi), mm2px(ph, args.dpi)), 255)
            ox, oy = (page.width - crop.width) // 2, mm2px(10, args.dpi)
            page.paste(crop, (ox, oy))
            draw = ImageDraw.Draw(page)
            # のりしろの境界線（ここで重ねる）
            seam = oy + mm2px(half - y_from, args.dpi)
            draw.line([(ox, seam), (ox + crop.width, seam)], fill=160, width=1)
            decorate(page, args.dpi, ox, oy + crop.height + mm2px(3, args.dpi), f"{info}  ({k+1}/2：{'上' if k == 0 else '下'}半分。灰色の線で重ねる)")
            pages.append(page)
    else:
        need = (bw + 20, bh + footer + 10)
        order = ["A4", "A3", "A2", "A1"] if args.paper == "auto" else [args.paper]
        chosen = None
        for name in order:
            w, h = PAPERS[name]
            for (pw, ph) in [(w, h), (h, w)]:
                if need[0] <= pw and need[1] <= ph:
                    chosen = (name, pw, ph)
                    break
            if chosen:
                break
        if not chosen:
            raise SystemExit(f"用紙に入りません（必要 {need[0]:.0f}×{need[1]:.0f}mm）")
        name, pw, ph = chosen
        page = Image.new("L", (mm2px(pw, args.dpi), mm2px(ph, args.dpi)), 255)
        ox = (page.width - img.width) // 2
        oy = mm2px(10, args.dpi)
        page.paste(img, (ox, oy))
        decorate(page, args.dpi, ox, oy + img.height + mm2px(3, args.dpi), f"{info}  用紙 {name}")
        pages.append(page)
        print(f"用紙: {name}（{pw}×{ph}mm）")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    pages[0].save(args.out, "PDF", resolution=args.dpi, save_all=True, append_images=pages[1:])
    pages[0].save(args.out.with_suffix(".png"), dpi=(args.dpi, args.dpi))
    print(f"出力: {args.out}（{len(pages)}ページ）と {args.out.with_suffix('.png').name}")
    print("印刷は「実際のサイズ（100%）」で。印刷後に目盛りとマーカーの1辺を実測し、board.json を実測値に直してください。")


if __name__ == "__main__":
    main()
