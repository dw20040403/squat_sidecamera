import { describe, expect, it } from 'vitest';
import {
  matMul,
  matrixToRodrigues,
  orthonormalize,
  rodriguesToMatrix,
  solveLinear,
  symmetricEigen,
  transpose,
  det3,
  median,
  type Vec3,
} from '../../web/src/fusion/math';

describe('math', () => {
  it('ロドリゲス表現と回転行列の相互変換', () => {
    for (const r of [
      [0.1, -0.2, 0.3],
      [1.2, 0.4, -2.0],
      [0, 0, 3.1],
      [Math.PI - 1e-8, 0, 0],
    ] as Vec3[]) {
      const R = rodriguesToMatrix(r);
      expect(det3(R)).toBeCloseTo(1, 9);
      const RtR = matMul(transpose(R), R);
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) expect(RtR[i][j]).toBeCloseTo(i === j ? 1 : 0, 9);
      const R2 = rodriguesToMatrix(matrixToRodrigues(R));
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(R2[i][j]).toBeCloseTo(R[i][j], 6);
    }
  });

  it('連立方程式', () => {
    const A = [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ];
    const x = solveLinear(A, [8, -11, -3])!;
    expect(x[0]).toBeCloseTo(2);
    expect(x[1]).toBeCloseTo(3);
    expect(x[2]).toBeCloseTo(-1);
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
  });

  it('対称行列の固有値分解', () => {
    const S = [
      [4, 1, 0, 0],
      [1, 3, 0.5, 0],
      [0, 0.5, 2, 0.2],
      [0, 0, 0.2, 1],
    ];
    const { values, vectors } = symmetricEigen(S);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    for (let k = 0; k < 4; k++) {
      const v = vectors[k];
      const Sv = S.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
      for (let i = 0; i < 4; i++) expect(Sv[i]).toBeCloseTo(values[k] * v[i], 9);
    }
  });

  it('回転行列への正規化', () => {
    const R = rodriguesToMatrix([0.3, 0.2, -0.1]);
    const noisy = R.map((r) => r.map((v) => v + 0.01));
    const O = orthonormalize(noisy);
    expect(det3(O)).toBeCloseTo(1, 6);
  });

  it('中央値', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
