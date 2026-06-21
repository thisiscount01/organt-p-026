'use strict';

/**
 * 식품의약품안전처 음식점 위생 AI 안전점수 서비스 — 백엔드 서버
 * Node.js + Express
 *
 * 엔드포인트:
 *   GET  /health
 *   GET  /api/search?q=<음식점명>
 *   POST /api/predict  body: { biz_no }
 *   GET  /api/predict/:biz_no
 */

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── 미들웨어 ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 데이터 로더 (Eager init — cold-start 차단) ─────────────────────
let HYGIENE  = [];   // data/hygiene.json
let WEIGHTS  = null; // model/weights.json
let BIZ_IDX  = new Map();  // biz_no → hygiene record (O(1) lookup)

function loadData() {
  const hygienePath  = path.join(__dirname, 'data', 'hygiene.json');
  const weightsPath  = path.join(__dirname, 'model', 'weights.json');

  // hygiene.json
  if (fs.existsSync(hygienePath)) {
    try {
      HYGIENE = JSON.parse(fs.readFileSync(hygienePath, 'utf-8'));
      BIZ_IDX.clear();
      for (const r of HYGIENE) BIZ_IDX.set(String(r.biz_no), r);
      console.log(`[init] hygiene.json 로드: ${HYGIENE.length}개 업소`);
    } catch (e) {
      console.error('[init] hygiene.json 파싱 오류:', e.message);
      HYGIENE = [];
    }
  } else {
    console.warn('[init] hygiene.json 없음 — node preprocess.js 먼저 실행하세요');
  }

  // weights.json
  if (fs.existsSync(weightsPath)) {
    try {
      WEIGHTS = JSON.parse(fs.readFileSync(weightsPath, 'utf-8'));
      console.log(`[init] weights.json 로드: ${WEIGHTS.version}`);
    } catch (e) {
      console.error('[init] weights.json 파싱 오류:', e.message);
    }
  } else {
    console.warn('[init] weights.json 없음 — model/weights.json 필요');
  }
}

// ─── AI 점수 계산 (서버 단일 판정 원칙) ─────────────────────────────
function computeScore(biz) {
  if (!WEIGHTS) return { score: null, grade: null, confidence: null };

  const { features, weights, bias, scale, thresholds } = WEIGHTS;

  const totalViol  = biz.violation_count        || 0;
  const recentViol = biz.recent_violation_count || 0;

  // max_penalty_grade: violations 배열에서 직접 계산
  const PENALTY_GRADE = {
    '폐쇄명령': 3, '영업허가취소': 3, '등록취소': 3,
    '영업정지3개월': 2, '영업정지2개월': 2, '영업정지1개월': 2,
    '영업정지15일': 1, '영업정지7일': 1, '영업정지': 1,
    '시정명령': 0, '경고': 0, '과태료': 0, '과징금': 0,
  };
  let maxGrade = 0;
  for (const v of (biz.violations || [])) {
    const s = (v.penalty || v.type || '').replace(/\s+/g, '');
    for (const [k, g] of Object.entries(PENALTY_GRADE)) {
      if (s.includes(k)) { maxGrade = Math.max(maxGrade, g); break; }
    }
  }

  // days_since_last_violation → inverse feature
  const today = new Date();
  const lastDate = biz.last_inspect_date ? new Date(biz.last_inspect_date) : null;
  const daysSince = lastDate
    ? Math.max(0, Math.floor((today - lastDate) / (24 * 3600 * 1000)))
    : 9999;
  const daysSinceInv = daysSince >= 9999 ? 0 : (1 / (daysSince + 1)) * 365;

  const isClosed = biz.is_closed ? 1 : 0;

  // feature vector 순서: features 배열 기준
  const featureMap = {
    'total_violations':             totalViol,
    'recent_violations':            recentViol,
    'max_penalty_grade':            maxGrade,
    'days_since_last_violation_inv': daysSinceInv,
    'is_closed':                    isClosed,
  };

  let raw = bias;
  for (let i = 0; i < features.length; i++) {
    raw += (featureMap[features[i]] || 0) * (weights[i] || 0);
  }

  // 0~100 clamp
  const score = Math.min(100, Math.max(0, Math.round(raw)));

  // grade 판정 — 서버 단일 원칙 (클라이언트에 raw float 비공개)
  let grade;
  if      (score < thresholds.safe)    grade = 'safe';
  else if (score < thresholds.caution) grade = 'caution';
  else if (score < thresholds.warning) grade = 'warning';
  else                                  grade = 'critical';

  // confidence: 입력 feature의 풍부함 기반 (위반 데이터가 많을수록 신뢰도 ↑)
  const hasHistory   = totalViol > 0;
  const hasRecent    = recentViol > 0;
  const hasInspected = !!biz.last_inspect_date;
  const confPct = Math.min(0.95,
    0.40
    + (hasHistory   ? 0.20 : 0)
    + (hasRecent    ? 0.15 : 0)
    + (hasInspected ? 0.10 : 0)
    + Math.min(0.10, totalViol * 0.01)
  );
  const confidence = parseFloat(confPct.toFixed(2));

  return { score, grade, confidence };
}

// ─── 라우트 ──────────────────────────────────────────────────────────

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status:       'ok',
    data_records: HYGIENE.length,
    model_loaded: WEIGHTS !== null,
    model_version: WEIGHTS ? WEIGHTS.version : null,
    thresholds:   WEIGHTS ? WEIGHTS.thresholds : { safe: 30, caution: 50, warning: 70 },
    timestamp:    new Date().toISOString(),
  });
});

/**
 * GET /api/search?q=<검색어>&limit=20
 * 이름 또는 주소에 검색어 포함 업소 반환 (최대 limit개)
 */
app.get('/api/search', (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);

  if (!q) {
    return res.status(400).json({ error: '검색어(q)를 입력하세요.' });
  }
  if (q.length < 2) {
    return res.status(400).json({ error: '검색어는 2자 이상 입력하세요.' });
  }

  const lower = q.toLowerCase();
  const results = [];

  for (const r of HYGIENE) {
    if (results.length >= limit) break;
    if (
      (r.name    || '').toLowerCase().includes(lower) ||
      (r.address || '').toLowerCase().includes(lower)
    ) {
      const { score, grade } = computeScore(r);
      results.push({
        biz_no:          r.biz_no,
        name:            r.name,
        address:         r.address,
        violation_count: r.violation_count,
        is_closed:       r.is_closed || false,
        score,
        grade,
      });
    }
  }

  res.json({
    query:   q,
    total:   results.length,
    results,
  });
});

/**
 * POST /api/predict
 * body: { biz_no: string }
 * 응답: { biz_no, name, score, grade, violations, confidence, explanation }
 */
app.post('/api/predict', (req, res) => {
  const { biz_no } = req.body || {};
  if (!biz_no) {
    return res.status(400).json({ error: 'biz_no 필드가 필요합니다.' });
  }
  return _predict(String(biz_no), res);
});

/**
 * GET /api/predict/:biz_no
 */
app.get('/api/predict/:biz_no', (req, res) => {
  return _predict(req.params.biz_no, res);
});

function _predict(biz_no, res) {
  if (!WEIGHTS) {
    return res.status(503).json({
      error:  'model_not_loaded',
      detail: 'model/weights.json 파일이 없습니다. AI 엔지니어의 모델 파일을 배치하세요.',
    });
  }

  const biz = BIZ_IDX.get(biz_no);
  if (!biz) {
    return res.status(404).json({
      error:  'not_found',
      detail: `biz_no "${biz_no}"에 해당하는 업소를 찾을 수 없습니다.`,
    });
  }

  const { score, grade, confidence } = computeScore(biz);

  // explanation — 위반이력 요약 문자열 (LLM 없이 rule-based 생성)
  const explanation = buildExplanation(biz, score, grade);

  res.json({
    biz_no:      biz.biz_no,
    name:        biz.name,
    address:     biz.address,
    score,                         // 0~100 (높을수록 위험)
    grade,                         // "safe"|"caution"|"warning"|"critical"
    confidence,                    // 0.0~1.0
    explanation,                   // 자연어 설명 (rule-based)
    violations:  biz.violations,   // 전체 위반 이력
    violation_count:        biz.violation_count,
    recent_violation_count: biz.recent_violation_count,
    last_inspect_date:      biz.last_inspect_date,
    is_closed:              biz.is_closed || false,
    _meta: {
      model_version: WEIGHTS.version,
      scored_at:     new Date().toISOString(),
    },
  });
}

function buildExplanation(biz, score, grade) {
  const gradeText = { safe:'안전', caution:'주의', warning:'경고', critical:'위험' };
  const total  = biz.violation_count        || 0;
  const recent = biz.recent_violation_count || 0;

  if (total === 0) {
    if (biz.is_closed) {
      return `이 업소는 현재 폐업 상태입니다. 폐업 패널티가 반영돼 위생 안전점수 ${score}점으로 "${gradeText[grade]}" 등급입니다.`;
    }
    return `위반 이력이 없는 업소입니다. 위생 안전점수 ${score}점으로 "${gradeText[grade]}" 등급입니다.`;
  }

  const lastDate   = biz.last_inspect_date || '정보없음';
  const recentNote = recent > 0
    ? `최근 1년 내 ${recent}건의 위반이 있습니다.`
    : '최근 1년 내 위반 이력은 없습니다.';

  return `누적 위반 ${total}건. ${recentNote} 마지막 점검일 ${lastDate}. 위생 안전점수 ${score}점으로 "${gradeText[grade]}" 등급입니다.`;
}

// ─── 404 핸들러 ──────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', path: _req.path });
});

// ─── 에러 핸들러 ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'internal_server_error', detail: err.message });
});

// ─── 서버 시작 ───────────────────────────────────────────────────────
loadData();  // Eager init

app.listen(PORT, () => {
  console.log(`[server] 포트 ${PORT}에서 구동 중 — http://localhost:${PORT}`);
  console.log(`[server] /health | /api/search?q=<검색어> | POST /api/predict`);
});

module.exports = app;  // 테스트용 export
