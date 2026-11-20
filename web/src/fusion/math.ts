// 3次元ベクトルと小さな行列の演算（DOMに依存しない純粋な関数）

export type Vec3 = [number, number, number];
export type Mat3 = number[][]; // 3×3（行優先）
export type Mat34 = number[][]; // 3×4

export const vec3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
export const lerp3 = (a: Vec3, b: Vec3, s: number): Vec3 => [
  a[0] + (b[0] - a[0]) * s,
  a[1] + (b[1] - a[1]) * s,
  a[2] + (b[2] - a[2]) * s,
];

export function normalize(a: Vec3): Vec3 | null {
  const n = norm(a);
  if (!(n > 1e-12)) return null;
  return [a[0] / n, a[1] / n, a[2] / n];
}

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;

/** 2つのベクトルのなす角（度）。どちらかが長さ0ならnull */
export function angleBetweenDeg(a: Vec3, b: Vec3): number | null {
  const na = norm(a);
  const nb = norm(b);
  if (!(na > 1e-12) || !(nb > 1e-12)) return null;
  const c = Math.min(1, Math.max(-1, dot(a, b) / (na * nb)));
  return deg(Math.acos(c));
}

export function identity3(): Mat3 {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

export function matVec3(M: Mat3, v: Vec3): Vec3 {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

export function matMul(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const m = B[0].length;
  const k = B.length;
  const C: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(m).fill(0);
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let l = 0; l < k; l++) s += A[i][l] * B[l][j];
      row[j] = s;
    }
    C.push(row);
  }
  return C;
}

export function transpose(A: number[][]): number[][] {
  const rows = A.length;
  const cols = A[0].length;
  const T: number[][] = [];
  for (let j = 0; j < cols; j++) {
    const r: number[] = [];
    for (let i = 0; i < rows; i++) r.push(A[i][j]);
    T.push(r);
  }
  return T;
}

export function det3(M: Mat3): number {
  return (
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
  );
}

/** 3×4の射影行列 [R|t] */
export function projectionMatrix(R: Mat3, t: number[]): Mat34 {
  return [
    [R[0][0], R[0][1], R[0][2], t[0]],
    [R[1][0], R[1][1], R[1][2], t[1]],
    [R[2][0], R[2][1], R[2][2], t[2]],
  ];
}

/**
 * 連立一次方程式 A x = b を部分ピボット選択つきのガウスの消去法で解く（n×n）。
 * 特異ならnull。
 */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    if (p !== c) [M[p], M[c]] = [M[c], M[p]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** 3×3の連立方程式 */
export function solve3(A: Mat3, b: Vec3): Vec3 | null {
  const x = solveLinear(A, b);
  return x ? [x[0], x[1], x[2]] : null;
}

/**
 * 対称行列の固有値分解（ヤコビ法）。固有値は昇順、vectors[k]がk番目の固有ベクトル。
 */
export function symmetricEigen(S: number[][]): { values: number[]; vectors: number[][] } {
  const n = S.length;
  const A = S.map((r) => [...r]);
  const V: number[][] = [];
  for (let i = 0; i < n; i++) {
    V.push(new Array<number>(n).fill(0));
    V[i][i] = 1;
  }
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [...Array(n).keys()].sort((a, b) => A[a][a] - A[b][b]);
  return {
    values: idx.map((i) => A[i][i]),
    vectors: idx.map((i) => V.map((row) => row[i])),
  };
}

/** ロドリゲス表現（回転ベクトル）→ 回転行列 */
export function rodriguesToMatrix(r: Vec3): Mat3 {
  const theta = norm(r);
  if (theta < 1e-12) return identity3();
  const [kx, ky, kz] = [r[0] / theta, r[1] / theta, r[2] / theta];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const v = 1 - c;
  return [
    [c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s],
    [ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s],
    [kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v],
  ];
}

/** 回転行列 → ロドリゲス表現 */
export function matrixToRodrigues(R: Mat3): Vec3 {
  const tr = R[0][0] + R[1][1] + R[2][2];
  const cosT = Math.min(1, Math.max(-1, (tr - 1) / 2));
  const theta = Math.acos(cosT);
  if (theta < 1e-9) return [0, 0, 0];
  if (Math.PI - theta < 1e-6) {
    // θ≈π：R = 2kkᵀ − I から軸を求める
    const xx = (R[0][0] + 1) / 2;
    const yy = (R[1][1] + 1) / 2;
    const zz = (R[2][2] + 1) / 2;
    let k: Vec3;
    if (xx >= yy && xx >= zz) {
      const x = Math.sqrt(xx);
      k = [x, R[0][1] / (2 * x), R[0][2] / (2 * x)];
    } else if (yy >= zz) {
      const y = Math.sqrt(yy);
      k = [R[0][1] / (2 * y), y, R[1][2] / (2 * y)];
    } else {
      const z = Math.sqrt(zz);
      k = [R[0][2] / (2 * z), R[1][2] / (2 * z), z];
    }
    const kn = normalize(k) ?? [1, 0, 0];
    return scale(kn, theta);
  }
  const s = 2 * Math.sin(theta);
  const axis: Vec3 = [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s];
  return scale(axis, theta);
}

/** 3×3行列を最も近い回転行列に直す（SVDの代わりに極分解の反復） */
export function orthonormalize(M: Mat3): Mat3 {
  let X = M.map((r) => [...r]);
  for (let i = 0; i < 30; i++) {
    const inv = invert3(transpose(X));
    if (!inv) break;
    const next = X.map((r, a) => r.map((v, b) => (v + inv[a][b]) / 2));
    let diff = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) diff += Math.abs(next[a][b] - X[a][b]);
    X = next;
    if (diff < 1e-12) break;
  }
  return X;
}

export function invert3(M: Mat3): Mat3 | null {
  const d = det3(M);
  if (Math.abs(d) < 1e-15) return null;
  const [a, b, c] = M[0];
  const [e, f, g] = M[1];
  const [h, i, j] = M[2];
  return [
    [(f * j - g * i) / d, (c * i - b * j) / d, (b * g - c * f) / d],
    [(g * h - e * j) / d, (a * j - c * h) / d, (c * e - a * g) / d],
    [(e * i - f * h) / d, (b * h - a * i) / d, (a * f - b * e) / d],
  ];
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}
