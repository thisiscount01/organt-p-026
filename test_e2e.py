#!/usr/bin/env python3
"""E2E 브라우저 검증: 음식점 위생 AI 안전점수 서비스"""
import time, sys
from playwright.sync_api import sync_playwright

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("console", lambda msg: errors.append(msg.text()) if msg.type == "error" else None)

        # ─── 1. 초기 화면 ─────────────────────────────────────────────
        page.goto("http://localhost:3000/")
        try:
            page.wait_for_selector("#cold-overlay.hidden", timeout=8000)
        except Exception:
            pass  # 이미 숨겨진 경우
        page.screenshot(path="/tmp/ss1_initial.png")
        title   = page.title()
        records = page.locator("#stat-records").text_content()
        model_v = page.locator("#stat-model").text_content()
        print(f"[SS1] 초기화면: 제목='{title}'  업소={records}  모델={model_v}")

        # ─── 2. 검색: 치킨 ────────────────────────────────────────────
        page.fill("#q", "치킨")
        page.click("#btn-search")
        page.wait_for_selector(".rest-card", timeout=6000)
        page.screenshot(path="/tmp/ss2_search.png")
        cnt    = page.locator(".rest-card").count()
        status = page.locator("#status-msg").text_content()
        badge0 = page.locator(".card-viol-badge").nth(0).text_content()
        print(f"[SS2] 검색(치킨): 카드={cnt}개  상태='{status}'  첫카드위반={badge0}")

        # ─── 3. 상세 모달 ─────────────────────────────────────────────
        page.locator(".rest-card").nth(0).click()
        page.wait_for_selector("#detail-wrap.open", timeout=5000)
        time.sleep(1.2)
        page.screenshot(path="/tmp/ss3_detail.png")
        score = page.locator(".score-arc-num .n").text_content()
        grade = page.locator(".grade-pill").text_content()
        expl  = page.locator(".explanation-box").text_content()
        vr    = page.locator(".viol-row").count()
        nv    = page.locator(".no-viol").count()
        print(f"[SS3] 상세: score={score}  grade='{grade}'")
        print(f"      설명: {expl[:80]}...")
        print(f"      위반행={vr}  무위반박스={nv}")

        # ─── 4. 닫기 후 주소 검색으로 대체 ──────────────────────────
        page.click("#detail-close")
        time.sleep(0.4)
        page.fill("#q", "강남구")
        page.click("#btn-search")
        page.wait_for_selector(".rest-card", timeout=5000)
        cnt2 = page.locator(".rest-card").count()
        print(f"[검색] 강남구 검색결과: {cnt2}건")

        # ─── 5. 1자 검색어 (클라이언트 차단 확인) ───────────────────
        page.fill("#q", "가")
        page.click("#btn-search")
        time.sleep(0.5)
        status2 = page.locator("#status-msg").text_content()
        print(f"[엣지] 1자 검색 status: '{status2}'")

        # ─── 6. 두 번째 카드 상세 (다른 등급 확인) ──────────────────
        page.fill("#q", "삼겹살")
        page.click("#btn-search")
        try:
            page.wait_for_selector(".rest-card", timeout=5000)
            cards = page.locator(".rest-card").count()
            if cards > 0:
                page.locator(".rest-card").nth(cards - 1).click()
                page.wait_for_selector("#detail-wrap.open", timeout=5000)
                time.sleep(1.0)
                page.screenshot(path="/tmp/ss4_detail2.png")
                s2 = page.locator(".score-arc-num .n").text_content()
                g2 = page.locator(".grade-pill").text_content()
                print(f"[SS4] 삼겹살 상세: score={s2} grade='{g2}'")
                page.click("#detail-close")
        except Exception as e:
            print(f"[SS4] 삼겹살 없음 또는 오류: {e}")

        # ─── 결과 ────────────────────────────────────────────────────
        print(f"\nJS 콘솔 오류: {'없음' if not errors else str(errors)}")
        browser.close()
        print("✓ E2E 완료")

if __name__ == "__main__":
    main()
