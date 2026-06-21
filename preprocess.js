/**
 * 식품의약품안전처 / 행정안전부 일반음식점 공공데이터 전처리 스크립트
 *
 * 실행: node preprocess.js
 *
 * 입력:
 *   data/raw/*.csv  (EUC-KR 또는 UTF-8 인코딩 CSV)
 *
 * 출력:
 *   data/hygiene.json   - 음식점별 위반이력 통합본
 *   data/features.json  - AI 학습용 feature 벡터
 *
 * ─── 실데이터 수집 방법 ────────────────────────────────────────────────
 * 1. https://www.data.go.kr 에서 로그인 후 아래 데이터셋 다운로드:
 *    - 전국일반음식점표준데이터 (ID: 15096283) → CSV
 *    - 행정안전부_일반음식점 (ID: 15045016)   → CSV (위반 이력 포함)
 * 2. 다운로드 파일을 data/raw/ 에 저장
 * 3. node preprocess.js 실행
 * ──────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// iconv-lite가 설치되지 않은 환경에서도 동작하도록 optional require
let iconv;
try { iconv = require('iconv-lite'); } catch (_) { iconv = null; }

// ─── 컬럼 매핑 (data.go.kr 일반음식점 CSV 표준 헤더) ─────────────────
const COL = {
  BIZ_NO:           ['사업자등록번호', 'biz_no', '인허가번호'],
  NAME:             ['사업장명', '상호명', 'biz_nm'],
  ADDRESS:          ['소재지전체주소', '도로명전체주소', 'addr'],
  STATUS:           ['영업상태명', '영업상태코드', 'biz_status'],
  LICENSE_DATE:     ['인허가일자', 'license_date'],
  CLOSE_DATE:       ['폐업일자', 'close_date'],
  VIOLATION_DATE:   ['처분일자', '위반일자', 'viol_date'],
  VIOLATION_TYPE:   ['위반내용', '처분내용', 'viol_type'],
  VIOLATION_DETAIL: ['처분내용상세', 'viol_detail'],
  PENALTY:          ['처분종류명', '처분종류', 'penalty'],
};

// ─── 위반 유형 → penalty_grade 매핑 ──────────────────────────────────
// 식품위생법 시행규칙 별표 23 기준
const PENALTY_GRADE = {
  '폐쇄명령': 3, '영업허가취소': 3, '등록취소': 3,
  '영업정지3개월': 2, '영업정지2개월': 2, '영업정지1개월': 2,
  '영업정지15일': 1, '영업정지7일': 1, '영업정지': 1,
  '시정명령': 0, '경고': 0, '과태료': 0, '과징금': 0,
};

function parsePenaltyGrade(penaltyStr = '') {
  const s = penaltyStr.replace(/\s+/g, '');
  for (const [key, grade] of Object.entries(PENALTY_GRADE)) {
    if (s.includes(key)) return grade;
  }
  return 0;
}

// ─── CSV 파싱 (큰따옴표 내 개행·쉼표 처리) ──────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuote && text[i + 1] === '"') { field += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      row.push(field.trim()); field = '';
    } else if ((c === '\n' || c === '\r') && !inQuote) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows;
}

function findCol(headers, candidates) {
  for (const c of candidates) {
    const idx = headers.findIndex(h => h.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

function normalizeDate(raw = '') {
  // 20230115 → 2023-01-15 / 2023.01.15 → 2023-01-15
  const s = raw.replace(/[./]/g, '-').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// ─── 메인 전처리 ─────────────────────────────────────────────────────
async function main() {
  const rawDir = path.join(__dirname, 'data', 'raw');
  if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });

  const csvFiles = fs.readdirSync(rawDir).filter(f => f.endsWith('.csv'));
  if (csvFiles.length === 0) {
    console.error('[경고] data/raw/*.csv 파일이 없습니다.');
    console.error('       data/raw/README.txt 참조하여 실데이터를 내려받은 후 재실행하세요.');
    // 빈 파일 생성 (서버 구동용)
    fs.writeFileSync(path.join(__dirname, 'data', 'hygiene.json'), '[]');
    fs.writeFileSync(path.join(__dirname, 'data', 'features.json'), '[]');
    return;
  }

  const bizMap = new Map();  // biz_no → {meta, violations[]}

  for (const file of csvFiles) {
    const fpath = path.join(rawDir, file);
    console.log(`[처리] ${file}`);

    // EUC-KR / UTF-8 자동 감지 — UTF-8 BOM 우선, 그 다음 대체문자 검사
    let raw = fs.readFileSync(fpath);
    let text;
    // UTF-8 BOM (EF BB BF) 확인
    const hasBom = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
    if (hasBom) {
      text = raw.slice(3).toString('utf-8');
    } else if (iconv) {
      // EUC-KR 디코딩 시 대체문자(U+FFFD, �) 포함 여부로 판별
      const eucTry = iconv.decode(raw, 'euc-kr');
      const firstLine = eucTry.split('\n')[0];
      if (firstLine.includes('�') || firstLine.includes('?')) {
        // UTF-8로 재시도
        text = raw.toString('utf-8');
      } else {
        text = eucTry;
      }
    } else {
      text = raw.toString('utf-8');
    }

    const rows = parseCSV(text);
    if (rows.length < 2) { console.warn(`  빈 파일 건너뜀: ${file}`); continue; }

    const headers = rows[0].map(h => h.replace(/^﻿/, ''));  // BOM 제거
    const iName    = findCol(headers, COL.NAME);
    const iAddr    = findCol(headers, COL.ADDRESS);
    const iStatus  = findCol(headers, COL.STATUS);
    const iClose   = findCol(headers, COL.CLOSE_DATE);
    const iVDate   = findCol(headers, COL.VIOLATION_DATE);
    const iVType   = findCol(headers, COL.VIOLATION_TYPE);
    const iVDetail = findCol(headers, COL.VIOLATION_DETAIL);
    const iPenalty = findCol(headers, COL.PENALTY);

    // biz_no: 사업자등록번호 → 없으면 인허가번호 → 없으면 name+addr 합성키
    const iBizNo = findCol(headers, COL.BIZ_NO);

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const get = (i) => (i >= 0 && i < row.length) ? (row[i] || '') : '';

      const name = get(iName);
      const addr = get(iAddr);
      if (!name && !addr) continue;

      const biz_no = get(iBizNo) || `${name}__${addr}`.replace(/\s+/g, '_').slice(0, 50);

      if (!bizMap.has(biz_no)) {
        bizMap.set(biz_no, {
          biz_no,
          name:    name || '(미상)',
          address: addr || '(미상)',
          last_inspect_date: '',
          is_closed: false,
          violations: [],
        });
      }

      const biz = bizMap.get(biz_no);
      biz.name    = biz.name    || name;
      biz.address = biz.address || addr;

      const statusStr = get(iStatus).toLowerCase();
      if (statusStr.includes('폐업') || statusStr.includes('취소')) biz.is_closed = true;
      if (get(iClose)) biz.is_closed = true;

      // 위반 이력 행인지 판단
      const vDate   = normalizeDate(get(iVDate));
      const vType   = get(iVType);
      const vDetail = get(iVDetail);
      const penalty = get(iPenalty);

      if (vDate && (vType || penalty)) {
        if (vDate > biz.last_inspect_date) biz.last_inspect_date = vDate;
        biz.violations.push({
          date:    vDate,
          type:    vType  || '불명',
          detail:  vDetail || '',
          penalty: penalty || '',
        });
      }
    }

    console.log(`  → ${bizMap.size}개 업소 누적`);
  }

  // ─── 집계 ────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const hygiene  = [];
  const features = [];

  for (const biz of bizMap.values()) {
    // 중복 위반 제거 (동일 날짜+유형)
    const seen = new Set();
    const uniqViolations = biz.violations.filter(v => {
      const key = `${v.date}|${v.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));

    const recent = uniqViolations.filter(v => v.date >= oneYearAgo);
    const maxGrade = uniqViolations.reduce(
      (g, v) => Math.max(g, parsePenaltyGrade(v.penalty || v.type)), 0
    );

    const lastDate = uniqViolations[0]?.date || '';
    const daysSince = lastDate
      ? Math.floor((new Date(today) - new Date(lastDate)) / (24 * 3600 * 1000))
      : 9999;

    hygiene.push({
      biz_no:                biz.biz_no,
      name:                  biz.name,
      address:               biz.address,
      is_closed:             biz.is_closed || false,
      last_inspect_date:     lastDate,
      violations:            uniqViolations,
      violation_count:       uniqViolations.length,
      recent_violation_count: recent.length,
    });

    features.push({
      biz_no:                     biz.biz_no,
      total_violations:           uniqViolations.length,
      recent_violations:          recent.length,
      max_penalty_grade:          maxGrade,
      days_since_last_violation:  daysSince,
      is_closed:                  biz.is_closed ? 1 : 0,
    });
  }

  // ─── 저장 ────────────────────────────────────────────────────────
  const outDir = path.join(__dirname, 'data');
  fs.writeFileSync(path.join(outDir, 'hygiene.json'),  JSON.stringify(hygiene,  null, 2));
  fs.writeFileSync(path.join(outDir, 'features.json'), JSON.stringify(features, null, 2));

  console.log(`\n✓ hygiene.json  → ${hygiene.length}개 업소`);
  console.log(`✓ features.json → ${features.length}개 레코드`);
}

main().catch(err => { console.error(err); process.exit(1); });
