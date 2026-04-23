"""
네이버 플레이스 순위 추적 크롤러 (map.naver.com 방식)
====================================================

실행:
  python place_rank.py              # 전체 active 키워드 크롤 (auto)
  python place_rank.py all          # 동일
  python place_rank.py test         # 테스트: '미사헬스장' 키워드 1개 파싱만 (DB insert 안 함)
  python place_rank.py <keyword_id> # 특정 키워드 1개만 (manual, jobs row 업데이트)

환경변수:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

동작:
  - 엔드포인트: https://map.naver.com/p/search/<keyword>?searchType=place
  - 결과는 #searchIframe 안에서 렌더링되므로 iframe 진입 후 파싱
  - 각 li에서 "광고" 뱃지가 있으면 제외하고 순위 매김
  - Playwright chromium + UA 로테이션 + 랜덤 대기
  - 카드 이름에 '베라짐' 포함 → is_found=true, branch 자동 태깅 (주소에 '미사'/'동탄')
  - 못 찾으면 is_found=false 1건만 기록
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
    # Desktop Chrome (Windows)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    # Desktop Edge
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
    # Desktop Safari (macOS)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    # Desktop Firefox
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
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
  // map.naver.com 의 #searchIframe 내부에서 실행되는 추출 스크립트.
  // 목적: li 아이템 중 '광고' 뱃지 없는 것만 순서대로 추출.
  const results = [];

  // 리스트 컨테이너 후보 — ul.place_biz_list / ul.lst_place / ul#_pcmap_list_scroll_container 등
  // 가장 많이 쓰이는 패턴: ul > li (각 li가 플레이스 1건)
  // 후보 li 집합: class 안에 'UEzoS' 또는 'place' 또는 텍스트 길이 충분한 li
  let items = Array.from(document.querySelectorAll('li.UEzoS, li.VLTHu, li.place_bluelink_wrapper, li[data-id]'));
  if (items.length < 2) {
    // fallback: ul 내부 li 전부
    const uls = Array.from(document.querySelectorAll('ul'));
    for (const ul of uls) {
      const lis = Array.from(ul.children).filter(c => c.tagName === 'LI');
      if (lis.length >= 3) {
        // 대표 후보 ul — 텍스트가 가장 많이 든 li가 3개 이상 있으면 채택
        const rich = lis.filter(li => (li.innerText || '').length > 15);
        if (rich.length >= 3) {
          items = rich;
          break;
        }
      }
    }
  }

  const isAdLi = (li) => {
    // '광고' 또는 'AD' 뱃지 감지
    // 패턴 1: 명시 클래스 (네이버가 자주 쓰는 광고 마커)
    if (li.querySelector('em.place_blind, span.place_blind, i.place_blind')) {
      const blind = li.querySelector('em.place_blind, span.place_blind, i.place_blind');
      if (/광고|ad/i.test(blind.innerText || '')) return true;
    }
    // 패턴 2: 인라인 텍스트로 "광고" 단독 단어가 들어간 span/em/i
    const marks = li.querySelectorAll('em, span, i, ins');
    for (const m of marks) {
      const t = (m.innerText || '').trim();
      if (t === '광고' || t === 'AD' || t === '광고!' || t === '광고ⓘ') return true;
    }
    // 패턴 3: innerText 맨 앞 줄에 '광고'
    const head = (li.innerText || '').trim().split('\\n').map(s => s.trim()).filter(Boolean)[0] || '';
    if (head === '광고' || head === '광고ⓘ' || head === '광고!' || head === '광고 ⓘ') return true;
    // 패턴 4: data-type/data-group에 ad
    if ((li.getAttribute('data-type') || '').toLowerCase().includes('ad')) return true;
    return false;
  };

  const getName = (li) => {
    const selectors = [
      'span.YwYLL', 'span.TYaxT', '.place_bluelink > span',
      'a.tzwk0 span', '.place_bluelink', 'strong', 'h3', 'h4',
      '.tit_place', '.place_name',
    ];
    for (const sel of selectors) {
      const el = li.querySelector(sel);
      if (el) {
        const t = (el.innerText || '').trim().split('\\n')[0].trim();
        if (t && t.length >= 2) return t;
      }
    }
    const lines = (li.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    // 첫 줄이 '광고' 류면 두 번째 줄
    for (const l of lines) {
      if (l === '광고' || l === '광고ⓘ' || l === '광고!' || l === 'AD') continue;
      if (l.length >= 2 && !/^\\d+$/.test(l)) return l;
    }
    return '';
  };

  const getAddress = (li) => {
    const lines = (li.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    for (const l of lines) {
      if (/(서울|경기|하남|화성|동탄|미사|인천|부산|대구|광주|대전|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주|[가-힣]+동\\s?\\d*|[가-힣]+로\\s?\\d+)/.test(l)) {
        return l;
      }
    }
    return '';
  };

  for (const li of items) {
    const text = (li.innerText || '').trim();
    if (!text || text.length < 5) continue;
    const ad = isAdLi(li);
    const name = getName(li);
    if (!name) continue;
    const address = getAddress(li);
    results.push({
      name,
      address,
      is_ad: ad,
      raw: text.replace(/\\n+/g, ' | ').slice(0, 200),
    });
  }

  return results;
}
"""


async def click_next_page(frame) -> tuple[bool, str | None]:
    """map.naver.com #searchIframe 내부의 '다음 페이지로' 버튼 클릭.

    네이버 지도 검색 iframe 페이지네이션:
      - 하단에 1,2,3,4,5 숫자 버튼 + '다음페이지' 화살표
      - a.mBN2s / button[aria-label='다음페이지'] / a[role='button'][class*='next'] 등
    """
    clicked_sel = await frame.evaluate(
        """
        () => {
          const isClickable = (el) => {
            if (!el || el.offsetParent === null) return false;
            if (el.getAttribute('aria-disabled') === 'true') return false;
            const cls = (el.className || '').toString();
            if (cls.includes('disabled') || cls.includes('qxokY')) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          // [1순위] aria-label 또는 innerText가 '다음페이지'인 <a>/<button>
          // 로그 검증: <A class='eUTV2' text='다음페이지'>가 유일한 명시적 '다음' 링크
          const candidates = Array.from(document.querySelectorAll('a, button'));
          for (const el of candidates) {
            const aria = el.getAttribute('aria-label') || '';
            const text = (el.innerText || '').trim();
            if (aria === '다음페이지' || aria === '다음 페이지' ||
                text === '다음페이지' || text === '다음 페이지') {
              if (!isClickable(el)) continue;
              el.scrollIntoView({block: 'center'});
              el.click();
              return 'next-by-text-or-aria';
            }
          }

          // [2순위] 활성 페이지 번호(.qxokY) 읽고 +1 번호에 해당하는 <a> 클릭
          const active = document.querySelector('a.qxokY, a[aria-current="true"], a.on');
          if (active) {
            const curNum = parseInt((active.innerText || '').trim(), 10);
            if (!isNaN(curNum)) {
              const parent = active.parentElement;
              if (parent) {
                const sibs = Array.from(parent.querySelectorAll('a'));
                for (const a of sibs) {
                  if (parseInt((a.innerText || '').trim(), 10) === curNum + 1) {
                    if (!isClickable(a)) continue;
                    a.scrollIntoView({block: 'center'});
                    a.click();
                    return `page-num-${curNum + 1}`;
                  }
                }
              }
            }
            // 활성 페이지 바로 다음 형제
            const nxt = active.nextElementSibling;
            if (nxt && nxt.tagName === 'A' && isClickable(nxt)) {
              nxt.scrollIntoView({block: 'center'});
              nxt.click();
              return 'active-next-sibling';
            }
          }

          return null;
        }
        """
    )
    return bool(clicked_sel), clicked_sel


async def debug_dump_cards(page, keyword: str, label: str = ""):
    """페이지 상에 존재하는 '플레이스스러운' li 엘리먼트들을 덤프. 카드 셀렉터 발굴용.

    page 인자는 Playwright Page 또는 Frame 어느 쪽이든 evaluate 지원.
    """
    info = await page.evaluate(
        """
        () => {
          const allLi = Array.from(document.querySelectorAll('li'));
          const candidates = [];
          for (const li of allLi) {
            const cls = (li.className || '').toString();
            const text = (li.innerText || '').trim();
            if (text.length < 10) continue;
            // 플레이스/헬스/영업 관련 힌트가 있는 li만
            const hint = /헬스|영업|예약|플레이스|place|VLTHu|lst_|_item|apollo|spot/.test(cls) ||
                         /영업 중|영업종료|영업시간|예약|리뷰/.test(text);
            if (!hint) continue;
            const rect = li.getBoundingClientRect();
            candidates.push({
              class: cls.slice(0, 80),
              textHead: text.replace(/\\n+/g, ' | ').slice(0, 80),
              y: Math.round(rect.top + (window.scrollY||0)),
              parentClass: ((li.parentElement && li.parentElement.className) || '').toString().slice(0, 60),
            });
            if (candidates.length >= 12) break;
          }
          return candidates;
        }
        """
    )
    tag = f" ({label})" if label else ""
    print(f"[{keyword}] card candidates{tag} ({len(info)}):")
    for i, c in enumerate(info):
        print(f"  {i+1}. y={c['y']} parent='{c['parentClass']}' class='{c['class']}' text='{c['textHead']}'")


async def debug_dump_pagination(page, keyword: str):
    """pagination 버튼 후보들을 덤프. 셀렉터 발굴용 디버그 함수."""
    info = await page.evaluate(
        """
        () => {
          const candidates = [];
          // 화살표/페이지 관련 가능성 있는 엘리먼트 후보
          const sel = 'a, button, [role="button"]';
          const all = Array.from(document.querySelectorAll(sel));
          for (const el of all) {
            const cls = el.className || '';
            const text = (el.innerText || '').trim().slice(0, 20);
            const aria = el.getAttribute('aria-label') || '';
            const key = (cls + ' ' + text + ' ' + aria).toLowerCase();
            if (key.includes('다음') || key.includes('next') || key.includes('nxt') ||
                key.includes('arr_next') || key.includes('pg_') || key.includes('flick') ||
                key.includes('btn_n') || key.includes('page')) {
              const rect = el.getBoundingClientRect();
              candidates.push({
                tag: el.tagName,
                class: cls.toString().slice(0, 100),
                text: text,
                aria: aria,
                visible: el.offsetParent !== null && rect.width > 0 && rect.height > 0,
              });
              if (candidates.length >= 20) break;
            }
          }
          return candidates;
        }
        """
    )
    print(f"[{keyword}] pagination candidates ({len(info)}):")
    for i, c in enumerate(info):
        print(f"  {i+1}. <{c['tag']}> class='{c['class']}' text='{c['text']}' aria='{c['aria']}' visible={c['visible']}")


async def _get_search_frame(page, timeout_ms: int = 30000):
    """map.naver.com #searchIframe 로드 대기 후 Frame 객체 반환.

    Cold start 내성:
      - 첫 키워드는 브라우저 initial load 비용이 커서 iframe 자체 등장까지 시간 걸림
      - iframe 엘리먼트가 보이면 li가 아직 없어도 프레임 반환 (caller가 추가 대기)
    """
    deadline = asyncio.get_event_loop().time() + (timeout_ms / 1000)
    frame_seen_at = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            el = await page.query_selector('iframe#searchIframe')
            if el:
                frame = await el.content_frame()
                if frame:
                    if frame_seen_at is None:
                        frame_seen_at = asyncio.get_event_loop().time()
                    # 프레임 내부에 li 렌더링 시작됐는지 체크
                    try:
                        await frame.wait_for_selector('ul li', timeout=3000)
                        return frame
                    except Exception:
                        pass
                    # iframe은 있는데 li가 오래도록 안 뜸 → 그래도 프레임 반환
                    if asyncio.get_event_loop().time() - frame_seen_at > 12:
                        print("[_get_search_frame] iframe present but no li for 12s — returning frame anyway")
                        return frame
        except Exception:
            pass
        await asyncio.sleep(0.4)
    return None


async def debug_dump_ad_markers(frame, keyword: str):
    """첫 li 3개의 em/span/i 텍스트를 덤프 — 광고 마커 DOM 구조 발굴용.

    한 번만 찍고 말 것 (page1에서만 호출).
    """
    info = await frame.evaluate(
        """
        () => {
          const items = Array.from(document.querySelectorAll('li.VLTHu, li.UEzoS, li[data-id]')).slice(0, 4);
          return items.map((li, idx) => ({
            idx,
            outerHead: (li.outerHTML || '').slice(0, 400),
            spans: Array.from(li.querySelectorAll('em, span, i, ins, strong, b, div')).slice(0, 25).map(s => ({
              tag: s.tagName,
              cls: (s.className || '').toString().slice(0, 50),
              text: (s.textContent || '').trim().slice(0, 30),
              aria: s.getAttribute('aria-label') || '',
            })).filter(s => s.text && s.text.length > 0),
          }));
        }
        """
    )
    print(f"[{keyword}] AD-MARKER dump ({len(info)} li inspected):")
    for r in info:
        print(f"  li[{r['idx']}] head={r['outerHead'][:120]}")
        for s in r['spans']:
            txt = s['text']
            # 광고 의심 후보 하이라이트
            flag = " <<< AD?" if ('광고' in txt or txt.lower() == 'ad') else ""
            print(f"    <{s['tag']}> cls='{s['cls']}' text='{txt}' aria='{s['aria']}'{flag}")


def is_target_name(name: str) -> bool:
    """베라짐 이름 매칭. 지도 등록명 변형 대응 (공백/영문)."""
    if not name:
        return False
    n = name.lower().replace(' ', '').replace('-', '')
    return any(t in n for t in ['베라짐', 'veragym', 'vera짐'])


async def scroll_and_collect(page, keyword: str) -> list[dict]:
    """map.naver.com/p/search 페이지 → #searchIframe 진입 → 광고 제외 순위 수집.

    동작:
      1) map.naver.com/p/search/<keyword>?searchType=place 로드
      2) #searchIframe frame 대기 및 진입
      3) iframe 내부 스크롤 → 추가 로드
      4) 카드 수집 (광고 li는 별도 표시, 최종 순위에서 제외)
      5) 페이지 번호/다음 버튼 클릭 → 반복 (MAX_PAGES)
      6) 광고 아닌 카드만 DOM 등장순으로 반환
    """
    url = f"https://map.naver.com/p/search/{keyword}?searchType=place"
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)
    # 첫 키워드 cold start 대응 — 좀 더 여유 있게 대기
    await asyncio.sleep(random.uniform(3.5, 5.0))

    frame = await _get_search_frame(page, timeout_ms=30000)
    if not frame:
        print(f"[{keyword}] #searchIframe not found — skip")
        return []
    # iframe 찾은 직후에도 조금 더 안정화 시간
    await asyncio.sleep(random.uniform(1.0, 1.8))

    all_cards: list[dict] = []
    seen_names: set[str] = set()
    MAX_PAGES = 6

    async def scroll_iframe_to_bottom():
        """iframe 내부 스크롤 컨테이너를 끝까지 스크롤 (무한 로드 유도)."""
        prev_count = -1
        for _ in range(8):
            try:
                # 스크롤 컨테이너 후보를 찾아 스크롤 실행
                await frame.evaluate(
                    """
                    () => {
                      const containers = [
                        document.querySelector('#_pcmap_list_scroll_container'),
                        document.querySelector('.Ryr1F'),
                        document.scrollingElement,
                        document.documentElement,
                      ].filter(Boolean);
                      for (const c of containers) {
                        c.scrollTop = (c.scrollHeight || 10000);
                      }
                    }
                    """
                )
            except Exception:
                pass
            await asyncio.sleep(random.uniform(0.5, 0.9))
            try:
                count = await frame.evaluate("() => document.querySelectorAll('ul li').length")
            except Exception:
                count = 0
            if count == prev_count:
                break
            prev_count = count

    for page_num in range(1, MAX_PAGES + 1):
        await asyncio.sleep(random.uniform(0.8, 1.4))
        await scroll_iframe_to_bottom()

        try:
            page_cards = await frame.evaluate(CARD_EXTRACT_JS) or []
        except Exception as e:
            print(f"[{keyword}] extract failed on page {page_num}: {e}")
            page_cards = []

        new_this_round = 0
        ads_this_round = 0
        for c in page_cards:
            nm = (c.get("name") or "").strip()
            if not nm or nm in seen_names:
                continue
            seen_names.add(nm)
            all_cards.append(c)
            if c.get("is_ad"):
                ads_this_round += 1
            new_this_round += 1

        print(f"[{keyword}] page {page_num}: page_cards={len(page_cards)}, new={new_this_round} (ad={ads_this_round}), total={len(all_cards)}")

        # 첫 페이지에서 디버그 덤프
        if page_num == 1:
            await debug_dump_pagination(frame, keyword)
            await debug_dump_cards(frame, keyword, label="page1")
            await debug_dump_ad_markers(frame, keyword)

        if page_num >= MAX_PAGES:
            break

        ok, sel = await click_next_page(frame)
        if not ok:
            print(f"[{keyword}] no more pages — next btn not found at page {page_num}")
            break
        print(f"[{keyword}] clicked next via '{sel}'")
        await asyncio.sleep(random.uniform(1.8, 2.8))

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
        viewport={"width": 1440, "height": 900},
        extra_http_headers={"Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"},
    )
    page = await ctx.new_page()

    found_by_branch: dict[str | None, dict] = {}  # branch -> {rank, name, address}
    results_rows = []

    try:
        cards = await scroll_and_collect(page, keyword)
        total_cards = len(cards)
        ad_cards = sum(1 for c in cards if c.get("is_ad"))
        organic_cards = total_cards - ad_cards
        print(f"[{keyword}] collected={total_cards} (organic={organic_cards}, ads={ad_cards})")

        # 수집 이름 전부 덤프 (베라짐 어디 있는지 사용자 확인용)
        print(f"[{keyword}] collected names (all {total_cards}):")
        for i, c in enumerate(cards, start=1):
            ad_mark = " [AD]" if c.get("is_ad") else ""
            nm = (c.get("name") or "")[:40]
            ad_preview = (c.get("address") or "")[:30]
            print(f"  {i:3d}. {nm}{ad_mark} | {ad_preview}")

        # 베라/vera/veragym 부분 포함 후보 전체 나열
        veragym_candidates = [
            (i, c) for i, c in enumerate(cards, start=1)
            if ('베라' in (c.get('name') or ''))
            or ('vera' in (c.get('name') or '').lower())
            or ('veragym' in (c.get('name') or '').lower().replace(' ', ''))
        ]
        if veragym_candidates:
            print(f"[{keyword}] 베라/vera 후보 {len(veragym_candidates)}개:")
            for pos, c in veragym_candidates:
                print(f"  pos={pos} name='{c.get('name')}' addr='{c.get('address')}' ad={c.get('is_ad')}")
        else:
            print(f"[{keyword}] 베라/vera 후보 없음 (수집된 {total_cards}개 중)")

        # 광고 제외 순위 매김
        organic_idx = 0
        for card in cards:
            if card.get("is_ad"):
                continue  # 광고는 순위에서 제외
            organic_idx += 1
            name = card.get("name", "")
            address = card.get("address", "")
            if is_target_name(name):
                branch = detect_branch(address) or detect_branch(name)
                if branch in found_by_branch:
                    continue  # 이미 기록
                found_by_branch[branch] = {
                    "rank": organic_idx,
                    "name": name,
                    "address": address,
                }
                print(f"  >>> FOUND '{name}' branch={branch} at rank={organic_idx} (광고 {ad_cards}건 제외)")

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
