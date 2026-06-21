#!/usr/bin/env python3
"""
QA 최종 인수 검증 — 음식점 위생 AI 안전점수 서비스
시나리오:
  S1. /health  → status:ok, data_records:5000, model_loaded:true
  S2. /api/search?q=치킨  → score/grade 포함 결과
  S3. /api/predict/:biz_no  → 5개 필드 전체 포함
  S4. UI: 퀵칩 클릭 → 결과표시
  S5. UI: 카드 클릭 → 상세모달 (점수 아크·등급 pill·위반이력)
  S6. UI: 1자 검색 클라이언트 차단
  S7. UI: 빈 결과 empty-state
  S8. JS 콘솔 에러 없음
"""
import time, sys, json
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
GRADES = {"safe", "caution", "warning", "critical"}
RESULTS = {}

def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    RESULTS[name] = status
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))
    return cond

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 800},
            ignore_https_errors=True,
        )
        page = ctx.new_page()
        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        # ── S1. /health API ─────────────────────────────────────────────
        print("\n[S1] /health")
        resp = page.request.get(f"{BASE}/health")
        h = resp.json()
        check("S1.status_ok",       h.get("status") == "ok",           f"status={h.get('status')}")
        check("S1.data_records",    h.get("data_records") == 5000,     f"data_records={h.get('data_records')}")
        check("S1.model_loaded",    h.get("model_loaded") is True,     f"model_loaded={h.get('model_loaded')}")
        check("S1.model_version",   bool(h.get("model_version")),      f"version={h.get('model_version')}")
        check("S1.thresholds",      isinstance(h.get("thresholds"), dict), f"thresholds={h.get('thresholds')}")

        # ── S2. /api/search?q=치킨 ─────────────────────────────────────
        print("\n[S2] /api/search?q=치킨")
        resp2 = page.request.get(f"{BASE}/api/search?q=치킨")
        s = resp2.json()
        results = s.get("results", [])
        r0 = results[0] if results else {}
        check("S2.has_results",     len(results) > 0,                  f"total={s.get('total')}")
        check("S2.score_is_number", isinstance(r0.get("score"), (int,float)), f"score={r0.get('score')}")
        check("S2.grade_is_enum",   r0.get("grade") in GRADES,        f"grade={r0.get('grade')}")
        check("S2.biz_no_present",  bool(r0.get("biz_no")),           f"biz_no={r0.get('biz_no')}")
        check("S2.name_present",    bool(r0.get("name")),              f"name={r0.get('name')}")
        check("S2.score_range",     0 <= (r0.get("score") or 0) <= 100, f"score={r0.get('score')}")
        # is_closed 폐업 패널티 외 violation=0 & score>0 이상값
        anomalies = [r for r in results if r.get("violation_count", 0) == 0 and (r.get("score") or 0) > 0 and not r.get("is_closed")]
        check("S2.no_anomaly_score", len(anomalies) == 0, f"anomaly(non-closed viol=0 score>0)={len(anomalies)}건")

        # ── S3. /api/predict/:biz_no ────────────────────────────────────
        print("\n[S3] /api/predict/:biz_no")
        # 위반 있는 업소 우선
        target = next((r for r in results if r.get("violation_count", 0) > 0), r0)
        biz_no = target["biz_no"]
        resp3 = page.request.get(f"{BASE}/api/predict/{biz_no}")
        pd = resp3.json()
        check("S3.score",           isinstance(pd.get("score"), (int,float)) and 0<=pd["score"]<=100, f"score={pd.get('score')}")
        check("S3.grade",           pd.get("grade") in GRADES,         f"grade={pd.get('grade')}")
        check("S3.confidence",      isinstance(pd.get("confidence"),(int,float)) and 0<=pd["confidence"]<=1, f"conf={pd.get('confidence')}")
        check("S3.explanation",     isinstance(pd.get("explanation"),str) and len(pd["explanation"])>10, f"expl={pd.get('explanation','')[:40]}")
        check("S3.violations_list", isinstance(pd.get("violations"), list), f"violations type={type(pd.get('violations'))}")
        check("S3.violation_count", isinstance(pd.get("violation_count"), int), f"vcount={pd.get('violation_count')}")
        check("S3.biz_no",          pd.get("biz_no") == biz_no)
        check("S3.meta_version",    bool(pd.get("_meta",{}).get("model_version")), f"meta.version={pd.get('_meta',{}).get('model_version')}")
        check("S3.meta_scored_at",  bool(pd.get("_meta",{}).get("scored_at")))
        # grade/score 일관성 검증
        score = pd["score"]; grade = pd["grade"]; t = h["thresholds"]
        expected = "safe" if score < t["safe"] else "caution" if score < t["caution"] else "warning" if score < t["warning"] else "critical"
        check("S3.grade_score_consistent", grade == expected, f"score={score} → expected={expected} actual={grade}")
        print(f"      위반이력 {len(pd['violations'])}건, explanation: {pd.get('explanation','')[:80]}...")

        # ── S4. UI 초기 로드 & cold-overlay ─────────────────────────────
        print("\n[S4] UI: 초기 화면 & 퀵칩")
        page.goto(f"{BASE}/")
        # cold-overlay가 사라질 때까지 대기 (최대 15s)
        try:
            page.wait_for_selector("#cold-overlay.hidden", timeout=15000)
        except Exception:
            # 간혹 이미 숨겨진 경우 통과
            pass
        time.sleep(0.5)
        page.screenshot(path="/tmp/qa_s4_initial.png")
        stat_records = page.locator("#stat-records").text_content(timeout=3000)
        stat_model   = page.locator("#stat-model").text_content(timeout=3000)
        check("S4.stat_records",    "5,000" in stat_records or "5000" in stat_records, f"stat_records='{stat_records}'")
        check("S4.stat_model",      bool(stat_model.strip()) and stat_model.strip() != "—", f"stat_model='{stat_model}'")
        # welcome 화면에 퀵칩이 보임
        chip_cnt = page.locator(".chip").count()
        check("S4.chips_visible",   chip_cnt >= 3,                     f"chip count={chip_cnt}")

        # 퀵칩 '치킨' 클릭 → 결과 카드 표시
        page.locator(".chip", has_text="치킨").click()
        page.wait_for_selector(".rest-card", timeout=6000)
        page.screenshot(path="/tmp/qa_s4_chips.png")
        card_cnt = page.locator(".rest-card").count()
        status_msg = page.locator("#status-msg").text_content()
        check("S4.chip_produces_cards", card_cnt > 0,               f"cards={card_cnt}")
        check("S4.status_msg_shown",    "업소" in status_msg or "검색" in status_msg, f"status='{status_msg}'")
        # welcome 영역 사라짐
        welcome_visible = page.locator("#welcome").is_visible()
        check("S4.welcome_hidden",  not welcome_visible)

        # ── S5. 카드 클릭 → 상세 모달 ──────────────────────────────────
        print("\n[S5] 카드 클릭 → 상세 모달")
        page.locator(".rest-card").nth(0).click()
        page.wait_for_selector("#detail-wrap.open", timeout=6000)
        time.sleep(1.3)  # 애니메이션 + API 응답 완료
        page.screenshot(path="/tmp/qa_s5_modal.png")

        # 점수 아크 숫자
        arc_num = page.locator(".score-arc-num .n").text_content(timeout=3000)
        check("S5.score_arc_visible", arc_num.strip().isdigit(),      f"arc_num='{arc_num}'")
        # 등급 pill
        grade_pill = page.locator(".grade-pill").text_content(timeout=3000)
        check("S5.grade_pill_visible", grade_pill.strip() in {"안전","주의","경고","위험"}, f"grade_pill='{grade_pill}'")
        # 점수↔등급 일관성 (UI 레벨)
        score_ui = int(arc_num.strip()) if arc_num.strip().isdigit() else -1
        grade_kr = grade_pill.strip()
        grade_map_ui = {"안전": "safe","주의": "caution","경고": "warning","위험": "critical"}
        grade_ui = grade_map_ui.get(grade_kr, "?")
        t_ui = h["thresholds"]
        exp_ui = "safe" if score_ui < t_ui["safe"] else "caution" if score_ui < t_ui["caution"] else "warning" if score_ui < t_ui["warning"] else "critical"
        check("S5.score_grade_ui_consistent", grade_ui == exp_ui, f"score={score_ui} grade_kr={grade_kr} expected_ui={exp_ui}")
        # 설명 박스
        has_expl = page.locator(".explanation-box").count() > 0
        expl_text = page.locator(".explanation-box").text_content() if has_expl else ""
        check("S5.explanation_box",    has_expl and len(expl_text) > 10,   f"expl='{expl_text[:60]}...'")
        # 위반이력 OR 무위반 박스 (둘 중 하나 반드시)
        viol_rows = page.locator(".viol-row").count()
        no_viol   = page.locator(".no-viol").count()
        check("S5.violation_section",  viol_rows > 0 or no_viol > 0,   f"viol_rows={viol_rows} no_viol={no_viol}")
        # 신뢰도 바
        conf_bar = page.locator(".conf-bar").count()
        check("S5.conf_bar_exists",    conf_bar > 0)
        # 닫기 버튼
        page.locator("#detail-close").click()
        time.sleep(0.4)
        modal_closed = not page.locator("#detail-wrap.open").is_visible()
        check("S5.modal_closes",       modal_closed)

        # ── S5b. 위반 있는 업소 카드 → 위반 행 표시 확인 ───────────────
        print("\n[S5b] 위반 이력 있는 카드 모달")
        # 위반건수 있는 카드 찾기
        cards_all = page.locator(".rest-card").all()
        clicked_viol = False
        for card in cards_all:
            hint = card.locator(".hint").text_content() if card.locator(".hint").count() > 0 else ""
            if "위반 0건" not in hint:
                card.click()
                page.wait_for_selector("#detail-wrap.open", timeout=5000)
                time.sleep(1.3)
                page.screenshot(path="/tmp/qa_s5b_viol.png")
                viol_rows2 = page.locator(".viol-row").count()
                check("S5b.viol_rows_visible", viol_rows2 > 0, f"viol_rows={viol_rows2}")
                # 위반 날짜·유형·처분 칩 확인
                if viol_rows2 > 0:
                    viol_date = page.locator(".viol-date").nth(0).text_content()
                    viol_type = page.locator(".viol-type").nth(0).text_content()
                    check("S5b.viol_date_present",  bool(viol_date.strip()), f"date='{viol_date}'")
                    check("S5b.viol_type_present",  bool(viol_type.strip()), f"type='{viol_type}'")
                page.locator("#detail-close").click()
                time.sleep(0.3)
                clicked_viol = True
                break
        if not clicked_viol:
            check("S5b.viol_card_found", False, "치킨 검색 결과에 위반 업소 없음")

        # ── S6. 1자 검색 클라이언트 차단 ───────────────────────────────
        print("\n[S6] 1자 검색 차단")
        page.fill("#q", "치")
        page.click("#btn-search")
        time.sleep(0.5)
        status6 = page.locator("#status-msg").text_content()
        check("S6.single_char_blocked", "2자" in status6, f"status='{status6}'")
        # 결과 카드가 새로 바뀌지 않아야 함 (이전 카드가 그대로)
        page.screenshot(path="/tmp/qa_s6_1char.png")

        # ── S7. 빈 결과 empty-state ─────────────────────────────────────
        print("\n[S7] 빈 결과 empty-state")
        page.fill("#q", "zzzznotexist99999")
        page.click("#btn-search")
        time.sleep(1.5)
        empty_visible = page.locator("#empty-state").is_visible()
        results_cnt = page.locator(".rest-card").count()
        check("S7.empty_state_shown",  empty_visible,                  f"empty-state visible={empty_visible}")
        check("S7.no_cards",           results_cnt == 0,               f"card count={results_cnt}")
        page.screenshot(path="/tmp/qa_s7_empty.png")

        # ── S8. JS 콘솔 에러 ────────────────────────────────────────────
        print("\n[S8] JS 콘솔 에러")
        filtered_errors = [e for e in console_errors if "favicon" not in e.lower()]
        check("S8.no_console_errors",  len(filtered_errors) == 0,     f"errors={filtered_errors}")

        # ── 최종 판정 ───────────────────────────────────────────────────
        browser.close()
        print("\n" + "="*50)
        failed = [k for k,v in RESULTS.items() if v == "FAIL"]
        if failed:
            print(f"최종 인수: FAIL — 결함 {len(failed)}건: {', '.join(failed)}")
            sys.exit(1)
        else:
            print(f"최종 인수: PASS — 전체 {len(RESULTS)}개 체크포인트 통과")
            sys.exit(0)

if __name__ == "__main__":
    main()
