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


async def scroll_and_collect(page, keyword: str) -> list[dict]:
    """m.search.naver.com 통합검색 페이지에서 무한스크롤로 모든 카드 수집.

    - li.VLTHu (지도 카드) 셀렉터 사용 — span.YwYLL이 사업장명
    - 15~25회 스크롤, 각 0.6~1.2초 랜덤 대기
    - 2회 연속 li.VLTHu 카운트 동일하면 조기 종료
    """
    url = f"https://m.search.naver.com/search.naver?where=m&query={keyword}"
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(2.0)

    scroll_count = random.randint(15, 25)
    prev_count = 0
    stale_rounds = 0

    for i in range(scroll_count):
        await page.mouse.wheel(0, 1000)
        await asyncio.sleep(random.uniform(0.6, 1.2))

        # VLTHu(지도 카드) + bx color_blue(광고 플레이스 카드) 합산으로 수렴 판단
        cur_count = await page.evaluate(
            "() => document.querySelectorAll('li.VLTHu, li.bx.color_blue').length"
        )
        if cur_count == prev_count:
            stale_rounds += 1
            if stale_rounds >= 2:
                print(f"[{keyword}] scroll early stop at round {i+1} (no new cards, count={cur_count})")
                break
        else:
            stale_rounds = 0
        prev_count = cur_count

    # 최종 카드 파싱 — span.YwYLL이 검증된 사업장명 셀렉터
    # 순서: VLTHu(지도 카드)가 페이지 상단에 블록 형태로 노출되고,
    #       그 아래 bx 통합검색 결과 카드가 이어짐
    # 두 타입 모두 수집하여 실제 노출 순서(DOM 순서)로 rank 계산
    cards = await page.evaluate(
        """
        () => {
          const results = [];

          // VLTHu: 지도 섹션 플레이스 카드
          // bx: 통합검색 결과 카드 — place_link 없으면 플레이스 카드가 아님
          const items = Array.from(document.querySelectorAll('li.VLTHu, li.bx'));

          items.forEach(li => {
            const text = (li.innerText || '').trim();
            if (!text || text.length < 2) return;

            // li.bx 중 플레이스 관련 카드만 포함 (place_link 또는 m.place.naver.com 링크)
            const isVLTHu = li.classList.contains('VLTHu');
            if (!isVLTHu) {
              const hasPlaceLink = !!li.querySelector('a.place_link');
              const hasMPlaceHref = Array.from(li.querySelectorAll('a')).some(
                a => a.href && a.href.includes('place.naver.com')
              );
              if (!hasPlaceLink && !hasMPlaceHref) return;
            }

            // 이름 추출: span.YwYLL (검증된 셀렉터) → fallback 체인
            // place_link 텍스트는 키워드 목록 전체를 포함할 수 있으므로 첫 줄만 사용
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
              // 줄 기반 fallback: 이미지수/숫자 제외하고 첫 의미있는 줄
              const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
              name = lines.find(l => l.length > 2 && !/^\\d+$/.test(l) && l !== '이미지수') || lines[0] || '';
            }

            if (!name) return;

            // 주소 추출: 텍스트 줄 중 지역명 패턴 포함 줄
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

          // 중복 제거 (name 기준)
          const seen = new Set();
          return results.filter(r => {
            if (!r.name || seen.has(r.name)) return false;
            seen.add(r.name);
            return true;
          });
        }
        """
    )

    return cards or []


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
