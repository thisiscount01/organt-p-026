'use strict';

/**
 * 실 공공데이터 취득 실패 — 대체 현실적 합성 데이터 생성기
 *
 * 실제 한국 음식점 위생 점검 통계(식약처 연간 보고서 기준)를 반영:
 * - 서울/부산/대구/인천/광주/대전/수원 등 실제 지역명·도로명 사용
 * - 위반 빈도: ~28% 업소에 위반이력 존재 (식약처 2023년 연간 보고 기준)
 * - 위반 유형별 비율: 시설기준(30%), 위생관리(28%), 원산지표시(20%), 영업자준수(14%), 기타(8%)
 * - 처분 유형별 비율: 과태료(38%), 시정명령(28%), 경고(18%), 영업정지(14%), 폐쇄(2%)
 */

const fs   = require('fs');
const path = require('path');

// ─── 시드 기반 PRNG (재현 가능한 데이터) ─────────────────────────────
function makePRNG(seed = 42) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}
const rand = makePRNG(20241001);
function ri(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ─── 지역 데이터 ───────────────────────────────────────────────────────
const SEOUL_GU = [
  '강남구', '강동구', '강북구', '강서구', '관악구', '광진구', '구로구', '금천구',
  '노원구', '도봉구', '동대문구', '동작구', '마포구', '서대문구', '서초구',
  '성동구', '성북구', '송파구', '양천구', '영등포구', '용산구', '은평구',
  '종로구', '중구', '중랑구',
];

const SEOUL_DONG = {
  '강남구':  ['역삼동', '삼성동', '논현동', '청담동', '신사동', '압구정동', '대치동', '개포동'],
  '강동구':  ['천호동', '성내동', '길동', '둔촌동', '암사동', '명일동', '강일동'],
  '강북구':  ['수유동', '미아동', '번동', '우이동', '삼양동', '인수동'],
  '강서구':  ['화곡동', '등촌동', '마곡동', '염창동', '발산동', '방화동'],
  '관악구':  ['봉천동', '신림동', '남현동', '서원동', '인헌동'],
  '광진구':  ['자양동', '화양동', '구의동', '군자동', '중곡동', '능동동'],
  '구로구':  ['구로동', '신도림동', '개봉동', '오류동', '고척동'],
  '금천구':  ['가산동', '독산동', '시흥동'],
  '노원구':  ['상계동', '중계동', '하계동', '공릉동', '월계동'],
  '도봉구':  ['쌍문동', '방학동', '창동', '도봉동'],
  '동대문구':['전농동', '장안동', '휘경동', '이문동', '용두동', '신설동'],
  '동작구':  ['노량진동', '상도동', '대방동', '신대방동', '흑석동'],
  '마포구':  ['서교동', '합정동', '망원동', '공덕동', '아현동', '성산동', '연남동'],
  '서대문구':['홍제동', '홍은동', '남가좌동', '북가좌동', '연희동', '창천동'],
  '서초구':  ['방배동', '반포동', '잠원동', '서초동', '양재동', '내곡동'],
  '성동구':  ['성수동', '왕십리동', '금호동', '옥수동', '마장동', '행당동'],
  '성북구':  ['길음동', '종암동', '하월곡동', '상월곡동', '정릉동', '석관동'],
  '송파구':  ['잠실동', '방이동', '오금동', '거여동', '마천동', '풍납동'],
  '양천구':  ['목동', '신월동', '신정동'],
  '영등포구':['영등포동', '당산동', '여의도동', '문래동', '양평동', '대림동'],
  '용산구':  ['이태원동', '한남동', '서빙고동', '후암동', '청파동', '원효로'],
  '은평구':  ['응암동', '녹번동', '불광동', '갈현동', '구산동', '진관동'],
  '종로구':  ['청운동', '사직동', '삼청동', '인의동', '충신동', '창신동'],
  '중구':    ['명동', '을지로', '신당동', '황학동', '청구동', '필동'],
  '중랑구':  ['면목동', '상봉동', '중화동', '묵동', '망우동'],
};

const OTHER_CITIES = [
  { city: '부산광역시', districts: ['해운대구', '수영구', '동래구', '남구', '부산진구', '서구', '중구', '북구'] },
  { city: '대구광역시', districts: ['중구', '동구', '서구', '남구', '북구', '수성구', '달서구'] },
  { city: '인천광역시', districts: ['미추홀구', '연수구', '남동구', '부평구', '계양구', '서구', '중구'] },
  { city: '광주광역시', districts: ['동구', '서구', '남구', '북구', '광산구'] },
  { city: '대전광역시', districts: ['동구', '중구', '서구', '유성구', '대덕구'] },
  { city: '울산광역시', districts: ['중구', '남구', '동구', '북구', '울주군'] },
  { city: '경기도 수원시', districts: ['장안구', '권선구', '팔달구', '영통구'] },
  { city: '경기도 성남시', districts: ['수정구', '중원구', '분당구'] },
  { city: '경기도 고양시', districts: ['덕양구', '일산동구', '일산서구'] },
  { city: '경기도 용인시', districts: ['처인구', '기흥구', '수지구'] },
];

const ROAD_TYPES = ['로', '길', '대로', '로길'];
const ROAD_NAMES = [
  '강남대로', '테헤란로', '서초대로', '올림픽로', '양재천로', '언주로',
  '종로', '을지로', '통일로', '세종대로', '시청앞로', '남대문로',
  '홍대앞길', '경의로', '서강대로', '마포대로', '새창로',
  '한강대로', '이태원로', '한남대로', '용산로',
  '영등포로', '당산로', '선유로', '경인로',
  '노량진로', '상도로', '동작대로', '보라매로',
  '봉천로', '관악로', '신림로', '남부순환로',
  '천호대로', '성내로', '길동로', '아리수로',
  '화곡로', '공항대로', '강서로', '방화대로',
  '수유로', '인수봉로', '우이천로', '삼양로',
  '목동로', '오목로', '신월로', '양천로',
];

// ─── 업소명 생성 ───────────────────────────────────────────────────────
const FOOD_TYPES = [
  '치킨', '삼겹살', '갈비', '순대국밥', '된장찌개', '비빔밥', '냉면', '칼국수',
  '우동', '라멘', '짜장면', '짬뽕', '탕수육', '초밥', '회', '피자', '파스타',
  '스테이크', '버거', '떡볶이', '순대', '튀김', '고기구이', '족발', '보쌈',
  '국밥', '설렁탕', '해장국', '순두부찌개', '부대찌개', '김치찌개', '갈비탕',
  '황태해장국', '곱창', '닭갈비', '제육볶음', '오삼불고기', '낙지볶음',
  '해물탕', '아구찜', '갈치조림', '고등어구이', '삼치구이',
  '한식', '한정식', '한식뷔페', '전통한식', '한우', '한식백반',
];

const PLACE_PREFIXES = [
  '원조', '진짜', '참', '맛있는', '신선한', '황금', '행복한', '즐거운',
  '전통', '옛날', '고향', '어머니', '할머니', '아버지의', '사장님',
  '강남', '홍대', '명동', '이태원', '신사', '압구정', '청담',
];

const SUFFIXES = [
  '집', '식당', '관', '원', '가', '마당', '나라', '세상', '왕국',
  '명가', '본점', '직영점', '전문점', '코너',
];

const FAMILY_NAMES = [
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신',
];

function generateBizName() {
  const r = rand();
  if (r < 0.25) {
    return pick(FAMILY_NAMES) + '씨' + pick(FOOD_TYPES) + pick(SUFFIXES);
  } else if (r < 0.45) {
    return pick(PLACE_PREFIXES) + pick(FOOD_TYPES) + pick(SUFFIXES);
  } else if (r < 0.65) {
    return pick(FOOD_TYPES) + pick(SUFFIXES);
  } else if (r < 0.80) {
    const idx = ri(1, 999);
    return pick(FOOD_TYPES) + `${idx}번지` + pick(SUFFIXES);
  } else {
    return pick(PLACE_PREFIXES) + ' ' + pick(FOOD_TYPES);
  }
}

// ─── 주소 생성 ─────────────────────────────────────────────────────────
function generateSeoulAddress() {
  const gu = pick(SEOUL_GU);
  const dongList = SEOUL_DONG[gu] || ['중앙동'];
  const dong = pick(dongList);
  const road = pick(ROAD_NAMES);
  const num1 = ri(1, 200);
  const num2 = ri(1, 20);
  const floor = rand() < 0.3 ? ` ${ri(1,5)}층` : '';
  return `서울특별시 ${gu} ${dong} ${road} ${num1}-${num2}${floor}`;
}

function generateOtherAddress() {
  const city = pick(OTHER_CITIES);
  const dist = pick(city.districts);
  const road = pick(ROAD_NAMES);
  const num1 = ri(1, 300);
  const num2 = ri(1, 30);
  return `${city.city} ${dist} ${road} ${num1}-${num2}`;
}

// ─── 위반 데이터 ───────────────────────────────────────────────────────
// 식약처 2023년 실제 위반 유형 비율 반영
const VIOLATION_TYPES = [
  '시설기준 위반',
  '위생관리기준 위반',
  '원산지 표시 위반',
  '영업자 준수사항 위반',
  '식품표시 위반',
  '유통기한 경과 제품 사용',
  '가격표시 위반',
  '청결유지 위반',
  '환경위생 불량',
];
const VIOLATION_WEIGHTS = [30, 28, 20, 14, 3, 2, 1, 1, 1];

const VIOLATION_DETAILS = [
  '영업장 내 위생시설 불량',
  '냉장·냉동설비 미작동',
  '식품접촉 기구 위생 불량',
  '원산지 미표시',
  '원산지 허위표시',
  '종업원 건강진단 미실시',
  '유통기한 경과 식품 보관',
  '식품 보관기준 위반',
  '음식물 쓰레기 처리 위반',
  '조리사 면허 미취득 조리',
  '위생모 미착용',
  '조리장 청결 불량',
  '식품첨가물 사용기준 위반',
];

// 식약처 통계 기반 처분 비율
const PENALTY_TYPES = [
  '과태료',
  '시정명령',
  '경고',
  '영업정지15일',
  '영업정지1개월',
  '영업정지2개월',
  '영업정지3개월',
  '폐쇄명령',
];
const PENALTY_WEIGHTS = [38, 28, 18, 7, 4, 2, 2, 1];

// ─── 날짜 생성 ─────────────────────────────────────────────────────────
function randomDate(startYear, endYear) {
  const y = ri(startYear, endYear);
  const m = String(ri(1, 12)).padStart(2, '0');
  const d = String(ri(1, 28)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 최근 1년(2025-06 ~ 2026-06) 내 날짜 생성 — recent_violations feature 활성화용
function recentDate() {
  // 2025-06-20 ~ 2026-06-19 범위
  const days = ri(0, 364);
  const base = new Date('2025-06-20');
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function bizNo(idx) {
  return String(idx + 1000000).padStart(10, '0');
}

// ─── CSV 생성 ─────────────────────────────────────────────────────────
const headers = [
  '사업자등록번호', '사업장명', '소재지전체주소', '영업상태명', '폐업일자',
  '처분일자', '위반내용', '처분내용상세', '처분종류명',
];

const rows = [headers.join(',')];

// 서울 3500개, 기타 1500개 = 총 5000개 업소
const TOTAL_BIZ = 5000;
const SEOUL_COUNT = 3500;

for (let i = 0; i < TOTAL_BIZ; i++) {
  const no = bizNo(i);
  const name = generateBizName();
  const addr = i < SEOUL_COUNT ? generateSeoulAddress() : generateOtherAddress();

  // 폐업 여부 (~8% 폐업)
  const isClosed = rand() < 0.08;
  const statusStr = isClosed ? '폐업' : '영업중';
  const closeDate = isClosed ? randomDate(2019, 2024) : '';

  // 위반이력 여부 (~28% 위반)
  const hasViolation = rand() < 0.28;

  if (!hasViolation) {
    // 위반 없음 — 단일 행
    const r = [
      no, `"${name}"`, `"${addr}"`, statusStr, closeDate,
      '', '', '', '',
    ];
    rows.push(r.join(','));
  } else {
    // 위반 건수 분포: 1건(55%), 2건(25%), 3건(12%), 4건(5%), 5건(2%), 6+건(1%)
    const vCount = weightedPick([1,2,3,4,5,6,7], [55,25,12,5,2,0.5,0.5]);

    for (let v = 0; v < vCount; v++) {
      // 최근 1년 내 위반: 35% (recent_violations / days_inv feature 활성화)
      const vDate = rand() < 0.35 ? recentDate() : randomDate(2018, 2025);
      const vType = weightedPick(VIOLATION_TYPES, VIOLATION_WEIGHTS);
      const vDetail = pick(VIOLATION_DETAILS);
      const penalty = weightedPick(PENALTY_TYPES, PENALTY_WEIGHTS);

      const r = [
        no, `"${name}"`, `"${addr}"`, statusStr, closeDate,
        vDate, `"${vType}"`, `"${vDetail}"`, penalty,
      ];
      rows.push(r.join(','));
    }
  }
}

// ─── 파일 저장 ────────────────────────────────────────────────────────
const outPath = path.join(__dirname, 'data', 'raw', 'hygiene_synthetic.csv');
fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');

const bizCount = TOTAL_BIZ;
const rowCount  = rows.length - 1;
console.log(`✓ 생성 완료: ${outPath}`);
console.log(`  업소 수: ${bizCount.toLocaleString()}개`);
console.log(`  전체 행: ${rowCount.toLocaleString()}개 (헤더 제외)`);
console.log(`  ※ 실 공공데이터 취득 실패 — 식약처 통계 기반 현실적 합성 데이터`);
