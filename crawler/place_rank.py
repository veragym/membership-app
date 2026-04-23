"""
네이버 플레이스 순위 추적 크롤러
================================

실행:
  python place_rank.py              # 전체 active 키워드 크롤 (auto)
  python place_rank.py all          # 동일
  python place_rank.py test         # 테스트: '미사헬스장' 키워드 1개 파싱만 (DB insert 안 함)
  python place_rank.py <keyword_id> # 특정 키워드 1개만 (manual, jobs row 업데이트)

환경변수:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

동작:
  - 모바일 엔드포인트 https://m.search.naver.com/search.naver?where=m&query=KW
  - Playwright chromium + UA 로테이션 + 랜덤 대기 + 무한스크롤 시뮬
  - 카드 텍스트에 '베라짐' 포함 → is_found=true, branch 자동 태깅 (주소에 '미사'/'동탄')
  - 못 찾으면 스크롤 완료 후 is_found=false 1건만 기록
"""
import os
import sys
import json
import random
import asyncio
import traceback
from datetime import datetime, timezone

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("[fatal] playwright 미설치 — `pip install playwright && playwright install chromium` 필요")
    raise

try:
    import httpx
except ImportError:
    print("[fatal] httpx 미설치 — `pip install httpx`")
    raise


TARGET_NAME = "베라짐"   # 카드 이름 매칭 키워드
BRANCH_KEYWORDS = {"미사": "misa", "동탄": "dongtan"}

UA_POOL = [
    # iOS Safari
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    # Android Chrome
    "Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.103 Mobile Safari/537.36",
    # 네이버 인앱
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.7.4)",
]

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


# ─────────────────────────────────────
# Supabase REST 헬퍼 (service role)
# ─────────────────────────────────────
def _headers():
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _require_env():
    if not SUPABASE_URL or not SERVICE_KEY:
        print("[fatal] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수 필요")
        sys.exit(1)


async def sb_select(table: str, params: dict) -> list:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=_headers(), params=params)
        r.raise_for_status()
        return r.json()


async def sb_insert(table: str, row: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=_headers(), json=row)
        r.raise_for_status()
        data = r.json()
        return data[0] if isinstance(data, list) and data else {}


async def sb_update(table: str, pk_col: str, pk_val, patch: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.patch(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=_headers(),
            params={pk_col: f"eq.{pk_val}"},
            json=patch,
        )
        r.raise_for_status()
        data = r.json()
        return data[0] if isinstance(data, list) and data else {}


# ─────────────────────────────────────
# 파싱
# ─────────────────────────────────────
def detect_branch(address: str) -> str | None:
    """주소에 '미사' 포함 → misa, '동탄' 포함 → dongtan. 둘 다면 먼저 등장한 키워드."""
    if not address:
        return None
    positions = []
    for kw, code in BRANCH_KEYWORDS.items():
        idx = address.find(kw)
        if idx >= 0:
            positions.append((idx, code))
    if not positions:
        return None
    positions.sort()
    return positions[0][1]


CARD_EXTRACT_JS = """
() => {
  const results = [];
  const items = Array.from(document.querySelectorAll('li.VLTHu, li.bx'));

  items.forEach(li => {
    const text = (li.innerText || '').trim();
    if (!text || text.length < 2) return;

    const isVLTHu = li.classList.contains('VLTHu');
    if (!isVLTHu) {
      const hasPlaceLink = !!li.querySelector('a.place_link');
      const hasMPlaceHref = Array.from(li.querySelectorAll('a')).some(
        a => a.href && a.href.includes('place.naver.com')
      );
      if (!hasPlaceLink && !hasMPlaceHref) return;
    }

    let name = '';
    const ywyllEl = li.querySelector('span.YwYLL');
    const placeLink = li.querySelector('a.place_link');
    const strongEl = li.querySelector('strong');
    const h3El = li.querySelector('h3');

    if (ywyllEl) {
      name = ywyllEl.innerText.trim().split('\\n')[0].trim();
    } else if (placeLink) {
      name = placeLink.innerText.trim().split('\\n')[0].trim();
    } else if (strongEl) {
      name = strongEl.innerText.trim().split('\\n')[0].trim();
    } else if (h3El) {
      name = h3El.innerText.trim().split('\\n')[0].trim();
    } else {
      const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
      name = lines.find(l => l.length > 2 && !/^\\d+$/.test(l) && l !== '이미지수') || lines[0] || '';
    }

    if (!name) return;

    const allLines = text.split('\\n').map(s => s.trim()).filter(Boolean);
    let address = '';
    for (const l of allLines) {
      if (/(서울|경기|하남|화성|동탄|미사|인천|부산|대구|광주|대전|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주|[가-힣]+동\\s?\\d*|[가-힣]+로\\s?\\d+)/.test(l)) {
        address = l;
        break;
      }
    }

    results.push({ name, address, raw: text.slice(0, 200) });
  });

  return results;
}
"""


async def click_next_page(page) -> bool:
    """플레이스 위젯의 '다음 페이지' 버튼 클릭 시도. 성공 시 True."""
    clicked_sel = await page.evaluate(
        """
        () => {
          // 네이버 모바일 통합검색 플레이스 위젯 pagination
          // 일반적으로 '다음'/'next' 텍스트 또는 오른쪽 화살표 아이콘
          const selectors = [
            'a._btn_next:not([aria-disabled="true"])',
            'a.btn_next:not([aria-disabled="true"])',
            'button._btn_next:not(:disabled)',
            'button.btn_next:not(:disabled)',
            'a[role="button"][aria-label*="다음"]',
            'button[aria-label*="다음"]',
            // 플레이스 위젯 전용
            '.api_flicking_wrap a.flick_next:not(.disabled)',
            '.tit_map_area + div a.btn_next',
          ];
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              if (el.offsetParent === null) continue;
              if (el.disabled) continue;
              if (el.getAttribute('aria-disabled') === 'true') continue;
              el.scrollIntoView({block: 'center'});
              el.click();
              return sel;
            }
          }
          // 최후 수단: '다음' 텍스트가 있는 anchor/button 찾기
          const allBtns = Array.from(document.querySelectorAll('a, button'));
          for (const el of allBtns) {
            const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
            if (t === '다음' || t === 'Next' || t === '다음 페이지') {
              if (el.offsetParent === null) continue;
              if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
              el.scrollIntoView({block: 'center'});
              el.click();
              return 'text-match:' + t;
            }
          }
          return null;
        }
        """
    )
    return bool(clicked_sel), clicked_sel


async def scroll_and_collect(page, keyword: str) -> list[dict]:
    """m.search.naver.com 통합검색 페이지 → 플레이스 위젯 페이지네이션 순회 수집.

    동작:
      1) 첫 페이지 로드 + 몇 번 스크롤해서 지도 섹션을 뷰포트에 노출
      2) 첫 페이지 카드 수집
      3) '다음 페이지' 버튼 찾아 클릭 → 로드 대기 → 카드 수집 반복
      4) 더 이상 다음 페이지 없거나 최대 MAX_PAGES(8) 도달 시 종료
      5) 이름 기준 중복 제거 후 DOM 등장순으로 반환
    """
    url = f"https://m.search.naver.com/search.naver?where=m&query={keyword}"
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(random.uniform(1.8, 2.6))

    # 지도/플레이스 섹션이 뷰포트에 들어오도록 약간 스크롤
    for _ in range(random.randint(3, 6)):
        await page.mouse.wheel(0, 700)
        await asyncio.sleep(random.uniform(0.4, 0.8))

    all_cards: list[dict] = []
    seen_names: set[str] = set()
    MAX_PAGES = 8

    for page_num in range(1, MAX_PAGES + 1):
        await asyncio.sleep(random.uniform(0.8, 1.4))

        # 현재 페이지 카드 수집
        page_cards = await page.evaluate(CARD_EXTRACT_JS) or []
        new_this_round = 0
        for c in page_cards:
            nm = (c.get("name") or "").strip()
            if not nm or nm in seen_names:
                continue
            seen_names.add(nm)
            all_cards.append(c)
            new_this_round += 1

        print(f"[{keyword}] page {page_num}: page_cards={len(page_cards)}, new={new_this_round}, total={len(all_cards)}")

        if page_num >= MAX_PAGES:
            break

        # 다음 페이지 버튼 클릭 시도
        ok, sel = await click_next_page(page)
        if not ok:
            print(f"[{keyword}] no more pages (next btn not found at page {page_num})")
            break
        # 버튼 클릭 후 새 카드 렌더 대기
        await asyncio.sleep(random.uniform(1.5, 2.5))

        # 카드 렌더 감지 (최대 추가 3초 대기)
        for _ in range(6):
            check = await page.evaluate(
                "() => document.querySelectorAll('li.VLTHu, li.bx').length"
            )
            if check >= 1:
                break
            await asyncio.sleep(0.5)

    return all_cards


async def crawl_keyword(browser, kw_row: dict, source: str, dry_run: bool = False) -> list[dict]:
    """단일 키워드에 대해 1회 무한스크롤 검색 → 베라짐 카드 발견 기록(s).

    반환: 기록된 history rows (dict 리스트).
    - 베라짐이 여러 카드 나오면(미사/동탄 각각) 각 branch별 1건씩 기록
    - 못 찾으면 is_found=false 1건만 기록
    - page=1 고정 (네이버 통합검색은 페이지네이션 없음)
    """
    keyword = kw_row["keyword"]
    ua = random.choice(UA_POOL)
    ctx = await browser.new_context(
        user_agent=ua,
        locale="ko-KR",
        timezone_id="Asia/Seoul",
        viewport={"width": 390, "height": 844},
        extra_http_headers={"Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"},
    )
    page = await ctx.new_page()

    found_by_branch: dict[str | None, dict] = {}  # branch -> {rank, name, address}
    results_rows = []

    try:
        cards = await scroll_and_collect(page, keyword)
        print(f"[{keyword}] collected={len(cards)}")

        for idx, card in enumerate(cards, start=1):
            name = card.get("name", "")
            address = card.get("address", "")
            if TARGET_NAME in name:
                branch = detect_branch(address) or detect_branch(name)
                if branch in found_by_branch:
                    continue  # 이미 기록
                found_by_branch[branch] = {
                    "rank": idx,
                    "name": name,
                    "address": address,
                }
                print(f"  >>> FOUND '{name}' branch={branch} at rank={idx}")

        # 결과 row 조립 (page=1 고정)
        if found_by_branch:
            for branch, info in found_by_branch.items():
                row = {
                    "keyword_id": kw_row["id"],
                    "keyword": keyword,
                    "branch": branch,
                    "page": 1,
                    "rank": info["rank"],
                    "is_found": True,
                    "card_name": info["name"][:200],
                    "card_address": (info["address"] or "")[:300],
                    "source": source,
                }
                results_rows.append(row)
        else:
            print(f"[{keyword}] veragym NOT found in {len(cards)} cards")
            results_rows.append({
                "keyword_id": kw_row["id"],
                "keyword": keyword,
                "branch": None,
                "page": None,
                "rank": None,
                "is_found": False,
                "source": source,
            })

    except Exception as e:
        traceback.print_exc()
        results_rows.append({
            "keyword_id": kw_row["id"],
            "keyword": keyword,
            "branch": None,
            "page": None,
            "rank": None,
            "is_found": False,
            "error": str(e)[:500],
            "source": source,
        })
    finally:
        await ctx.close()

    if not dry_run:
        for row in results_rows:
            try:
                await sb_insert("place_rank_history", row)
            except Exception as e:
                print(f"[warn] insert failed: {e}")

    return results_rows


# ─────────────────────────────────────
# 엔트리 포인트
# ─────────────────────────────────────
async def run_all(source: str = "auto"):
    _require_env()
    kws = await sb_select(
        "place_rank_keywords",
        {"select": "id,keyword,is_active", "is_active": "eq.true", "order": "sort_order.asc"},
    )
    if not kws:
        print("[info] active 키워드 없음 — 종료")
        return
    print(f"[info] {len(kws)}개 키워드 크롤 시작 (source={source})")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        for kw in kws:
            try:
                await crawl_keyword(browser, kw, source)
            except Exception as e:
                print(f"[error] kw={kw['keyword']} failed: {e}")
            await asyncio.sleep(random.uniform(4.0, 9.0))
        await browser.close()


async def run_one(keyword_id: str, source: str = "manual"):
    _require_env()
    kws = await sb_select(
        "place_rank_keywords",
        {"select": "id,keyword,is_active", "id": f"eq.{keyword_id}"},
    )
    if not kws:
        print(f"[warn] keyword {keyword_id} not found")
        return
    kw = kws[0]

    # 이 키워드 관련 pending job
    jobs = await sb_select(
        "place_rank_jobs",
        {
            "select": "id,status",
            "keyword_id": f"eq.{keyword_id}",
            "status": "eq.pending",
            "order": "requested_at.desc",
            "limit": "1",
        },
    )
    job_id = jobs[0]["id"] if jobs else None

    if job_id:
        await sb_update("place_rank_jobs", "id", job_id, {
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
        })

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
            await crawl_keyword(browser, kw, source)
            await browser.close()
        if job_id:
            await sb_update("place_rank_jobs", "id", job_id, {
                "status": "done",
                "finished_at": datetime.now(timezone.utc).isoformat(),
            })
    except Exception as e:
        if job_id:
            await sb_update("place_rank_jobs", "id", job_id, {
                "status": "failed",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "error": str(e)[:500],
            })
        raise


async def run_test():
    """DB insert 없이 '미사헬스장' 키워드로 파싱만 검증."""
    fake_kw = {"id": "00000000-0000-0000-0000-000000000000", "keyword": "미사헬스장"}
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        rows = await crawl_keyword(browser, fake_kw, "manual", dry_run=True)
        await browser.close()
    print("\n===== TEST RESULT =====")
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    if arg == "test":
        asyncio.run(run_test())
    elif arg in ("all", "auto"):
        # 자동 실행 시 0~59분 랜덤 지연 (cron 빈도 분산)
        if os.environ.get("GITHUB_EVENT_NAME") == "schedule":
            import time
            delay = random.randint(0, 3540)
            print(f"[info] schedule jitter sleep {delay}s")
            time.sleep(delay)
        asyncio.run(run_all("auto"))
    else:
        # UUID로 간주
        asyncio.run(run_one(arg, "manual"))


if __name__ == "__main__":
    main()
