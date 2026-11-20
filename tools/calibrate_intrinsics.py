#!/usr/bin/env python3
"""内部パラメータの校正（spec 5.4.1）。

アプリの「校正画像撮影」でダウンロードしたZIP（または画像のフォルダ）から、
OpenCVの calibrateCamera でカメラ行列と歪み係数を求め、config/intrinsics/<deviceName>.json に出力する。

例:
  python3 tools/calibrate_intrinsics.py calib-iphone15-A.zip --device iphone15-A --cols 9 --rows 6 --square 25

  --cols/--rows はチェッカーボードの「内側の交点」の数（9×6の交点なら 10×7 マス）。
  --square は印刷後に実測した1マスの大きさ（mm）。
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import sys
import zipfile
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
IMG_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}


def load_images(src: Path) -> list[tuple[str, np.ndarray]]:
    out: list[tuple[str, np.ndarray]] = []
    if src.is_file() and src.suffix.lower() == ".zip":
        with zipfile.ZipFile(src) as z:
            for name in sorted(z.namelist()):
                if Path(name).suffix.lower() in IMG_EXT:
                    buf = np.frombuffer(z.read(name), np.uint8)
                    img = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
                    if img is not None:
                        out.append((name, img))
    elif src.is_dir():
        for p in sorted(src.iterdir()):
            if p.suffix.lower() in IMG_EXT:
                img = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
                if img is not None:
                    out.append((p.name, img))
    else:
        sys.exit(f"入力が見つかりません: {src}")
    return out


def find_corners(img: np.ndarray, pattern: tuple[int, int]) -> np.ndarray | None:
    # まずSB版（精度が高く、ぼけに強い）。だめなら従来版＋サブピクセル
    if hasattr(cv2, "findChessboardCornersSB"):
        ok, c = cv2.findChessboardCornersSB(img, pattern, flags=cv2.CALIB_CB_EXHAUSTIVE + cv2.CALIB_CB_ACCURACY)
        if ok:
            return c.reshape(-1, 1, 2).astype(np.float32)
    ok, c = cv2.findChessboardCorners(img, pattern, cv2.CALIB_CB_ADAPTIVE_THRESH + cv2.CALIB_CB_NORMALIZE_IMAGE)
    if not ok:
        return None
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 1e-4)
    return cv2.cornerSubPix(img, c, (11, 11), (-1, -1), crit)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path, help="校正画像のZIPまたはフォルダ")
    ap.add_argument("--device", required=True, help="deviceName（例: iphone15-A）")
    ap.add_argument("--cols", type=int, default=9, help="内側の交点の数（横）")
    ap.add_argument("--rows", type=int, default=6, help="内側の交点の数（縦）")
    ap.add_argument("--square", type=float, default=25.0, help="1マスの大きさ（mm）")
    ap.add_argument("--out", type=Path, default=ROOT / "config" / "intrinsics", help="出力先のフォルダ")
    ap.add_argument("--min-images", type=int, default=10)
    ap.add_argument("--rational", action="store_true", help="k4〜k6も推定する（出力はk1,k2,p1,p2,k3のみなので通常は使わない）")
    args = ap.parse_args()

    images = load_images(args.input)
    if not images:
        sys.exit("画像がありません")
    sizes = {img.shape[::-1] for _, img in images}
    if len(sizes) != 1:
        sys.exit(f"画像の解像度がそろっていません: {sizes}（計測時と同じ解像度で撮影してください）")
    w, h = next(iter(sizes))
    pattern = (args.cols, args.rows)
    objp = np.zeros((args.cols * args.rows, 3), np.float32)
    objp[:, :2] = np.mgrid[0 : args.cols, 0 : args.rows].T.reshape(-1, 2) * (args.square / 1000.0)

    obj_pts, img_pts, names = [], [], []
    for name, img in images:
        c = find_corners(img, pattern)
        status = "OK" if c is not None else "検出できず"
        print(f"  {name}: {status}")
        if c is not None:
            obj_pts.append(objp)
            img_pts.append(c)
            names.append(name)
    print(f"検出できた画像: {len(names)} / {len(images)}（解像度 {w}×{h}）")
    if len(names) < args.min_images:
        sys.exit(f"検出できた画像が{args.min_images}枚未満です。撮り直してください")

    flags = cv2.CALIB_RATIONAL_MODEL if args.rational else 0
    rms, K, dist, rvecs, tvecs = cv2.calibrateCamera(obj_pts, img_pts, (w, h), None, None, flags=flags)
    dist = dist.ravel()

    print("\n画像ごとの再投影誤差（px）:")
    per = []
    for name, o, i, r, t in zip(names, obj_pts, img_pts, rvecs, tvecs):
        p, _ = cv2.projectPoints(o, r, t, K, dist)
        e = float(np.sqrt(np.mean(np.sum((p.reshape(-1, 2) - i.reshape(-1, 2)) ** 2, axis=1))))
        per.append((e, name))
        print(f"  {name}: {e:.3f}")
    worst = sorted(per, reverse=True)[:3]
    print(f"\nRMS: {rms:.3f}px")
    print(f"fx={K[0,0]:.2f} fy={K[1,1]:.2f} cx={K[0,2]:.2f} cy={K[1,2]:.2f}")
    print(f"k1={dist[0]:.5f} k2={dist[1]:.5f} p1={dist[2]:.5f} p2={dist[3]:.5f} k3={dist[4]:.5f}")
    if rms >= 1.0:
        print("警告: RMSが1px以上です。誤差の大きい画像を除くか、撮り直してください:", ", ".join(n for _, n in worst))

    out = {
        "deviceName": args.device,
        "imageSize": [int(w), int(h)],
        "K": {"fx": float(K[0, 0]), "fy": float(K[1, 1]), "cx": float(K[0, 2]), "cy": float(K[1, 2])},
        "dist": {"k1": float(dist[0]), "k2": float(dist[1]), "p1": float(dist[2]), "p2": float(dist[3]), "k3": float(dist[4])},
        "rms": float(rms),
        "date": dt.date.today().isoformat(),
        "images": len(names),
        "board": {"cols": args.cols, "rows": args.rows, "squareMm": args.square},
    }
    args.out.mkdir(parents=True, exist_ok=True)
    dst = args.out / f"{args.device}.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n出力: {dst}")


if __name__ == "__main__":
    main()
