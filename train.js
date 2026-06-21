'use strict';

/**
 * 음식점 위생 AI 위험도 모델 학습 — OLS(최소자승법) + 동적 임계값 보정
 *
 * 알고리즘: 정규방정식(Normal Equation) 기반 OLS
 *   w* = (X^T X)^{-1} X^T y
 * 장점: 경사하강법 수렴 불안정·클래스 불균형 문제 없음, 전역 최적해 보장
 *
 * 입력:  data/features.json
 * 출력:  model/weights.json (v1.0-trained)
 *
 * feature 순서 (server.js featureMap 일치):
 *   [0] total_violations
 *   [1] recent_violations
 *   [2] max_penalty_grade
 *   [3] days_since_last_violation_inv  (features.json의 days_since_last_violation에서 변환)
 *   [4] is_closed
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── 데이터 로드 ──────────────────────────────────────────────────────
const records = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'features.json'), 'utf-8')
);
console.log(`[학습] 레코드: ${records.length}개`);
if (records.length < 10) {
  console.error('학습 데이터 부족. node preprocess.js 먼저 실행하세요.');
  process.exit(1);
}

// ─── Feature 변환 ─────────────────────────────────────────────────────
// days_since_last_violation → inverse  (server.js와 동일 공식)
function daysToInv(days) {
  if (days === undefined || days === null || days >= 9999) return 0;
  return (1 / (days + 1)) * 365;
}

const N = records.length;
const X = records.map(r => [
  r.total_violations  || 0,
  r.recent_violations || 0,
  r.max_penalty_grade || 0,
  daysToInv(r.days_since_last_violation),
  r.is_closed         || 0,
]);

// ─── 학습 레이블 설계 ────────────────────────────────────────────────
/**
 * 식약처 행정처분 심각도 기준으로 위험 점수(0~100) 정의
 *
 * 설계 목표:
 *   위반 0건         → 0~12   (안전)
 *   위반 1~2건 경미  → 13~34  (주의)
 *   위반 3~4건 중간  → 35~64  (경고)
 *   중대/최근 다수   → 65~100 (위험)
 *
 * 임계값 학습 후 데이터 분포 기반으로 자동 보정.
 */
function trueScore(x) {
  const [totalViol, recentViol, maxGrade, invDays, isClosed] = x;

  let s = 0;

  // 총 위반건수: 1건=8, 2건=14, 3건=19 … (체감 증가)
  s += totalViol > 0
    ? Math.min(32, 8 + (totalViol - 1) * 6)
    : 0;

  // 최근 1년 위반건수 (총량보다 더 높은 가중치)
  s += Math.min(28, recentViol * 14);

  // 최대 처분 등급 (0~3 → 0/20/40/60)
  s += maxGrade * 20;

  // 최근성 (최근일수록 위험, invDays 최대값 ≈ 183 for 2-day-old)
  s += Math.min(18, invDays * 0.1);

  // 폐업
  s += isClosed * 10;

  return clamp(Math.round(s), 0, 100);
}

const Y = X.map(trueScore);

// 레이블 분포 (임시 임계값 30/50/70 기준)
const dist = { safe:0, caution:0, warning:0, critical:0 };
Y.forEach(y => {
  if (y < 30) dist.safe++;
  else if (y < 50) dist.caution++;
  else if (y < 70) dist.warning++;
  else dist.critical++;
});
console.log('[레이블 분포] (임시 t=30/50/70 기준)');
console.log(`  safe=${dist.safe} caution=${dist.caution} warning=${dist.warning} critical=${dist.critical}`);

// ─── OLS — 정규방정식 ──────────────────────────────────────────────
// X_aug: N×(F+1),  augment with intercept column
const F = 5;
const Xa = X.map(row => [1, ...row]);  // N × 6

// A = X_aug^T X_aug  (6×6)
function mat(r, c, fill = 0) {
  return Array.from({ length: r }, () => new Array(c).fill(fill));
}

const A = mat(F + 1, F + 1);
for (let i = 0; i < N; i++) {
  for (let r = 0; r <= F; r++) {
    for (let c = 0; c <= F; c++) {
      A[r][c] += Xa[i][r] * Xa[i][c];
    }
  }
}

// b = X_aug^T y  (6×1)
const Bvec = new Array(F + 1).fill(0);
for (let i = 0; i < N; i++) {
  for (let r = 0; r <= F; r++) {
    Bvec[r] += Xa[i][r] * Y[i];
  }
}

// 가우스 소거법 + 후방대입으로 A·w = B 풀기
function gaussianElimination(A, B) {
  const n = B.length;
  // 확장행렬 [A | B]
  const M = A.map((row, i) => [...row, B[i]]);

  for (let col = 0; col < n; col++) {
    // 피벗 선택 (절댓값 최대)
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) continue;  // 특이행렬 처리

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col] / pivot;
      for (let c = col; c <= n; c++) {
        M[row][c] -= factor * M[col][c];
      }
    }
  }

  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

const wOLS = gaussianElimination(A, Bvec);
const biasOLS  = wOLS[0];
const wFinal   = wOLS.slice(1);

// ─── 성능 평가 ────────────────────────────────────────────────────────
const preds = X.map(row => {
  let raw = biasOLS;
  for (let j = 0; j < F; j++) raw += wFinal[j] * row[j];
  return clamp(Math.round(raw), 0, 100);
});

const mse  = preds.reduce((s, p, i) => s + (p - Y[i]) ** 2, 0) / N;
const rmse = Math.sqrt(mse);

// ─── 동적 임계값 보정 ────────────────────────────────────────────────
// 목표: 데이터 분포 기반으로 임계값을 조정해
//       safe:caution:warning:critical ≈ 65:20:11:4 (식약처 위반통계 기반)
const sorted = [...preds].sort((a, b) => a - b);
function percentile(p) {
  const idx = Math.floor(N * p / 100);
  return sorted[Math.min(idx, N - 1)];
}

// 각 등급 상한 = 목표 누적 비율의 백분위수
const pSafe    = percentile(65);  // safe  상한 → 65th percentile
const pCaution = percentile(85);  // caution 상한 → 85th percentile
const pWarning = percentile(96);  // warning 상한 → 96th percentile

// 임계값이 모두 같거나 단조증가 위반이면 기본값 유지
const thresholds = {
  safe:    pSafe    > 0 && pSafe    < pCaution ? pSafe    : 30,
  caution: pCaution > 0 && pCaution < pWarning ? pCaution : 50,
  warning: pWarning > 0 && pWarning < 100      ? pWarning : 70,
};

// 임계값 기반 분류 정확도
function toGrade(s) {
  if (s < thresholds.safe)    return 0;
  if (s < thresholds.caution) return 1;
  if (s < thresholds.warning) return 2;
  return 3;
}

const trueGrades = Y.map(toGrade);
const predGrades = preds.map(toGrade);

const correct = trueGrades.filter((g, i) => g === predGrades[i]).length;
const acc     = (correct / N * 100).toFixed(1);

function calcPR(label) {
  const tp = trueGrades.filter((g, i) => g === label && predGrades[i] === label).length;
  const fp = trueGrades.filter((g, i) => g !== label && predGrades[i] === label).length;
  const fn = trueGrades.filter((g, i) => g === label && predGrades[i] !== label).length;
  const p  = tp / (tp + fp || 1);
  const r  = tp / (tp + fn || 1);
  const f1 = 2 * p * r / (p + r || 1);
  return { p: p.toFixed(3), r: r.toFixed(3), f1: f1.toFixed(3), tp, fp, fn };
}

console.log('\n[성능 평가]');
console.log(`  RMSE: ${rmse.toFixed(2)}`);
console.log(`  등급 분류 정확도: ${acc}%`);
console.log(`  동적 임계값: safe<${thresholds.safe} caution<${thresholds.caution} warning<${thresholds.warning}`);

['safe','caution','warning','critical'].forEach((g, i) => {
  const pr = calcPR(i);
  console.log(`  ${g.padEnd(10)}: P=${pr.p} R=${pr.r} F1=${pr.f1}  (TP=${pr.tp} FP=${pr.fp} FN=${pr.fn})`);
});

// 극단값 검증 (최대·최소 입력에서 점수가 의미있는지)
const maxX = [7, 5, 3, 182, 1];  // 최고위험
const minX = [0, 0, 0, 0,   0];  // 무위반
function predict(row) {
  let raw = biasOLS;
  for (let j = 0; j < F; j++) raw += wFinal[j] * row[j];
  return clamp(Math.round(raw), 0, 100);
}
console.log(`\n  극단값 검증: 무위반=${predict(minX)} / 최고위험=${predict(maxX)}`);

// ─── 저장 ──────────────────────────────────────────────────────────────
const weightsObj = {
  version:          'v1.0-trained',
  trained_at:       new Date().toISOString(),
  algorithm:        'OLS_normal_equation',
  training_records: N,
  metrics: {
    rmse:         parseFloat(rmse.toFixed(2)),
    grade_acc_pct: parseFloat(acc),
    safe_f1:      parseFloat(calcPR(0).f1),
    caution_f1:   parseFloat(calcPR(1).f1),
    warning_f1:   parseFloat(calcPR(2).f1),
    critical_f1:  parseFloat(calcPR(3).f1),
  },
  features: [
    'total_violations',
    'recent_violations',
    'max_penalty_grade',
    'days_since_last_violation_inv',
    'is_closed',
  ],
  weights:    wFinal.map(w => parseFloat(w.toFixed(6))),
  bias:       parseFloat(biasOLS.toFixed(6)),
  scale:      100.0,
  thresholds,
  notes: [
    'score = clamp(bias + sum(w_i * x_i), 0, 100)',
    'days_since_last_violation_inv = daysSince>=9999 ? 0 : (1/(daysSince+1))*365',
    'thresholds auto-calibrated to data percentiles (65/85/96th)',
  ].join(' | '),
};

const outPath = path.join(__dirname, 'model', 'weights.json');
fs.writeFileSync(outPath, JSON.stringify(weightsObj, null, 2));
console.log(`\n✓ model/weights.json 저장 (v1.0-trained)`);
console.log('  가중치:', wFinal.map(w => w.toFixed(3)));
console.log('  편향  :', biasOLS.toFixed(3));
