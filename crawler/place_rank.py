"""
네이버 플레이스 순위 추적 크롤러 (search.naver.com 통합검색 방식, v2)
=====================================================================

실행:
  python place_rank.py              # 전체 active 키워드 크롤 (auto)
  python place_rank.py all          # 동일
  python place_rank.py test         # 테스트: '미사헬스장' 키워드 1개 파싱만 (DB insert 안 함)
  python place_rank.py <keyword_id> # 특정 키워드 1개만 (manual, jobs row 업데이트)

환경변수:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

동작:
  - 엔드포인트: https://search.naver.com/search.naver?query=<keyword>
  - 통합검색 결과 중 '플레이스' 박스 스코프 파싱
  - 각 카드에서 '광고' 뱃지 있는 것 제외하고 누적 순위 매김
  - 페이지 구조:
      1페이지: 광고3 + 일반5   → 누적순위 1~5
      2~5페이지: 광고2 + 일반6  → 누적순위 6~11, 12~17, 18~23, 24~29
  - '< 1/5 >' 페이지네이션 우측 화살표 클릭 → 최대 5페이지 순회
  - 카드 이름에 '베라짐' 포함 → is_found=true, branch 자동 태깅 (주소에 '미사'/'동탄')
  - 못 찾으면 is_found=false 1건만 기록, error 필드에 디버그 JSON 저장
"""
import os
import sys
import json
import random
import asyncio
import hashlib
import traceback
from urllib.parse import quote
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


TARGET_NAME = "베라짐"
BRANCH_KEYWORDS = {"미사": "misa", "동탄": "dongtan"}
MAX_PAGES = 5         # 통합검색 플레이스 박스 최대 페이지
MAX_SNAPSHOTS = 20    # 경쟁사 스냅샷 저장 상한 (DOM 순 1~20, 광고 포함)

UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
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
# 파싱 헬퍼
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


def is_target_name(name: str) -> bool:
    """베라짐 이름 매칭 (공백/영문/하이픈 변형 대응)."""
    if not name:
        return False
    n = name.lower().replace(' ', '').replace('-', '')
    return any(t in n for t in ['베라짐', 'veragym', 'vera짐'])


async def fetch_image_hash(image_url: str) -> str | None:
    """이미지 URL → bytes 다운로드 → MD5 해시.

    실패 시 None 반환 (네트워크 오류, 이미지 없음, 차단 등).
    Phase 1에서는 해시 저장만 (변경 감지용). Phase 2에서 비교.
    """
    if not image_url:
        return None
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
            r = await c.get(image_url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; ImageFetch/1.0)",
                "Referer": "https://search.naver.com/",
            })
            if r.status_code != 200 or not r.content:
                return None
            return hashlib.md5(r.content).hexdigest()
    except Exception as e:
        # 조용히 None — 해시 실패가 전체 크롤을 막으면 안 됨
        return None


async def insert_snapshots_bulk(rows: list[dict]):
    """place_rank_snapshots bulk insert (httpx POST, 최대 500건 chunk)."""
    if not rows:
        return
    CHUNK = 100
    async with httpx.AsyncClient(timeout=30) as c:
        for i in range(0, len(rows), CHUNK):
            chunk = rows[i:i+CHUNK]
            try:
                r = await c.post(
                    f"{SUPABASE_URL}/rest/v1/place_rank_snapshots",
                    headers={**_headers(), "Prefer": "return=minimal"},
                    json=chunk,
                )
                if r.status_code >= 400:
                    print(f"[warn] snapshot bulk insert 실패: {r.status_code} {r.text[:200]}")
            except Exception as e:
                print(f"[warn] snapshot bulk insert 예외: {e}")


# ─────────────────────────────────────
# 플레이스 박스 추출 JS
# ─────────────────────────────────────
# search.naver.com 통합검색 페이지에서 '플레이스' 섹션의 카드 8개 (광고 포함)를
# DOM 순서대로 추출. 네이버 클래스명이 자주 바뀌므로 다중 폴백 전략 사용.
PLACE_EXTRACT_JS = """
() => {
  const report = { found_box: false, box_signature: '', cards: [], pagination_info: '' };

  // ─── 1) 플레이스 박스 찾기 ───
  // 우선순위:
  //   A) 제목에 '플레이스' 포함한 section/div
  //   B) data-module-name/id에 place 포함
  //   C) 클래스명에 place 포함
  const allSections = Array.from(document.querySelectorAll('section, div.api_subject_bx, div[data-module-name], div[class*="place"]'));
  let box = null;

  for (const s of allSections) {
    // 헤더/타이틀에 '플레이스' 텍스트
    const heading = s.querySelector('h2, h3, .api_title, .title_area, [class*="title"]');
    if (heading && (heading.innerText || '').includes('플레이스')) {
      box = s; report.box_signature = 'heading-text'; break;
    }
    // data-module-name
    const mod = (s.getAttribute('data-module-name') || '').toLowerCase();
    if (mod.includes('place')) {
      box = s; report.box_signature = 'data-module=' + mod; break;
    }
  }

  // 폴백: 클래스명 'place'가 들어간 가장 큰 컨테이너
  if (!box) {
    const candidates = Array.from(document.querySelectorAll('[class*="place"]'))
      .filter(el => el.getBoundingClientRect().height > 200);
    if (candidates.length > 0) {
      candidates.sort((a,b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      box = candidates[0];
      report.box_signature = 'class-largest:' + (box.className || '').toString().slice(0, 60);
    }
  }

  if (!box) return report;
  report.found_box = true;

  // ─── 2) 카드 찾기 ───
  // 박스 안 li 또는 div 중 일정 크기 이상 + 텍스트 길이 충분한 것들
  let items = Array.from(box.querySelectorAll('li'));
  // 너무 작은 li (페이지 번호 등) 제거
  items = items.filter(li => {
    const t = (li.innerText || '').trim();
    if (t.length < 8) return false;
    const rect = li.getBoundingClientRect();
    return rect.height > 40;
  });

  // 카드가 li로 안 잡히면 div 기반 폴백
  if (items.length < 3) {
    const divs = Array.from(box.querySelectorAll('div'))
      .filter(d => {
        const t = (d.innerText || '').trim();
        const rect = d.getBoundingClientRect();
        return t.length > 15 && rect.height > 60 && rect.height < 400;
      });
    // 중복 제거 (부모-자식 관계 우선 자식 제외)
    const unique = divs.filter(d => !divs.some(p => p !== d && p.contains(d)));
    if (unique.length >= 3) {
      items = unique;
      report.box_signature += ' (div-fallback)';
    }
  }

  const isAdCard = (el) => {
    // 광고 마커: em/span/i 중 텍스트가 "광고", "AD", "광고ⓘ" 또는 aria-label 에 '광고'
    const marks = el.querySelectorAll('em, span, i, ins, strong');
    for (const m of marks) {
      const t = (m.innerText || m.textContent || '').trim();
      if (t === '광고' || t === '광고!' || t === '광고ⓘ' || t === '광고 ⓘ' || t === 'AD' || t === 'Ad') return true;
      const aria = m.getAttribute('aria-label') || '';
      if (aria.includes('광고')) return true;
    }
    // data-type 에 ad
    const dt = (el.getAttribute('data-type') || el.getAttribute('data-group') || '').toLowerCase();
    if (dt.includes('ad')) return true;
    // 클래스명에 'ad_' 접두어 (ex: ad_area, ad_module)
    const cls = (el.className || '').toString();
    if (/\\bad[_-]/i.test(cls)) return true;
    return false;
  };

  const getName = (el) => {
    // 1순위: place_bluelink 안의 span/strong
    const prio = [
      '.place_bluelink', '.place_bluelink > span', '.place_bluelink strong',
      '.YwYLL', '.TYaxT', 'a.tzwk0 span',
      '[class*="place_name"]', '[class*="place_tit"]',
      'strong a', 'a strong', 'h3 a', 'h4 a', 'h3', 'h4',
    ];
    for (const sel of prio) {
      const x = el.querySelector(sel);
      if (x) {
        const t = (x.innerText || x.textContent || '').trim().split('\\n')[0].trim();
        if (t && t.length >= 2 && t !== '광고') return t;
      }
    }
    // 폴백: 첫 번째 의미 있는 텍스트 라인
    const lines = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    for (const l of lines) {
      if (l === '광고' || l === 'AD' || /^\\d+$/.test(l)) continue;
      if (l.length >= 2 && l.length <= 60) return l;
    }
    return '';
  };

  const getAddress = (el) => {
    const lines = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    for (const l of lines) {
      if (/(서울|경기|인천|부산|대구|광주|대전|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주|하남|화성|동탄|미사)/.test(l)) {
        return l;
      }
      if (/[가-힣]+(동|읍|면|로|길)\\s?\\d*/.test(l)) return l;
    }
    return '';
  };

  // 대표 이미지 URL 추출 (img src 또는 background-image)
  const getImageUrl = (el) => {
    // 1) img 태그
    const imgs = el.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (src && /pstatic\\.net|ssl\\.pstatic|myplace|place/.test(src)) {
        // data URI나 빈 src 제외
        if (src.startsWith('http')) return src;
      }
    }
    // 2) background-image (inline style)
    const bgEls = el.querySelectorAll('[style*="background-image"]');
    for (const be of bgEls) {
      const style = be.getAttribute('style') || '';
      const m = style.match(/background-image\\s*:\\s*url\\(['\"]?([^'\")]+)['\"]?\\)/);
      if (m && m[1] && m[1].startsWith('http')) return m[1];
    }
    // 3) 첫 번째 img 무조건 (폴백)
    if (imgs.length > 0) {
      const src = imgs[0].getAttribute('src') || imgs[0].getAttribute('data-src') || '';
      if (src && src.startsWith('http')) return src;
    }
    return '';
  };

  for (const it of items) {
    const raw_text = (it.innerText || '').trim();
    if (raw_text.length < 5) continue;
    const name = getName(it);
    if (!name) continue;
    const is_ad = isAdCard(it);
    const address = getAddress(it);
    const image_url = getImageUrl(it);
    report.cards.push({
      name,
      address,
      is_ad,
      image_url,
      raw: raw_text.replace(/\\n+/g, ' | ').slice(0, 180),
    });
  }

  // 페이지네이션 단서
  const paginationCand = box.querySelector('.api_flicking_wrap, .api_flicking_btn_area, [class*="pagination"], [class*="paging"]');
  if (paginationCand) {
    report.pagination_info = (paginationCand.innerText || '').trim().slice(0, 80);
  }

  return report;
}
"""


# ─────────────────────────────────────
# 다음 페이지 클릭
# ─────────────────────────────────────
CLICK_NEXT_JS = """
() => {
  // 플레이스 박스 내의 '다음 페이지' 화살표 클릭.
  // 구조: < 1/5 > 형태, 우측 > 버튼을 클릭해야 다음 페이지로 전환.

  // 박스 스코프 재선정
  const sections = Array.from(document.querySelectorAll('section, div.api_subject_bx, div[data-module-name]'));
  let box = null;
  for (const s of sections) {
    const heading = s.querySelector('h2, h3, .api_title, .title_area, [class*="title"]');
    if (heading && (heading.innerText || '').includes('플레이스')) { box = s; break; }
    const mod = (s.getAttribute('data-module-name') || '').toLowerCase();
    if (mod.includes('place')) { box = s; break; }
  }
  if (!box) {
    const cands = Array.from(document.querySelectorAll('[class*="place"]'))
      .filter(el => el.getBoundingClientRect().height > 200);
    if (cands.length > 0) box = cands.sort((a,b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
  }
  if (!box) return null;

  const isClickable = (el) => {
    if (!el || el.offsetParent === null) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    const cls = (el.className || '').toString();
    if (cls.includes('disabled')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // [1순위] aria-label / 텍스트에 '다음' 있는 버튼
  const btns = Array.from(box.querySelectorAll('a, button'));
  for (const b of btns) {
    const aria = b.getAttribute('aria-label') || '';
    const txt = (b.innerText || '').trim();
    if (aria.includes('다음') || txt === '다음' || txt === '>' || txt === '▶') {
      if (!isClickable(b)) continue;
      b.scrollIntoView({block: 'center'});
      b.click();
      return 'next-by-aria-or-text';
    }
  }

  // [2순위] 우측 화살표 아이콘: class에 'next' 또는 'pg_next'
  for (const b of btns) {
    const cls = (b.className || '').toString().toLowerCase();
    if (cls.includes('next') || cls.includes('pg_next') || cls.includes('btn_next')) {
      if (!isClickable(b)) continue;
      b.scrollIntoView({block: 'center'});
      b.click();
      return 'next-by-class:' + cls.slice(0, 30);
    }
  }

  // [3순위] 활성 페이지 번호 다음 형제
  const active = box.querySelector('[aria-current="true"], .on, .active, .selected');
  if (active) {
    const num = parseInt((active.innerText || '').trim(), 10);
    if (!isNaN(num)) {
      const parent = active.parentElement;
      if (parent) {
        const sibs = Array.from(parent.querySelectorAll('a, button'));
        for (const s of sibs) {
          if (parseInt((s.innerText || '').trim(), 10) === num + 1) {
            if (!isClickable(s)) continue;
            s.scrollIntoView({block: 'center'});
            s.click();
            return 'page-num-' + (num + 1);
          }
        }
      }
    }
  }

  return null;
}
"""


# ─────────────────────────────────────
# 디버그 덤프
# ─────────────────────────────────────
async def debug_dump_place_box(page, keyword: str, label: str = ""):
    """플레이스 박스 후보들을 덤프. 박스 셀렉터 발굴용."""
    info = await page.evaluate(
        """
        () => {
          const heads = Array.from(document.querySelectorAll('h2, h3, .api_title, .title_area, [class*="title"]'))
            .filter(h => (h.innerText || '').includes('플레이스'));
          const hits = heads.map(h => {
            const sec = h.closest('section, div.api_subject_bx, div[data-module-name]');
            return {
              heading: (h.innerText || '').trim().slice(0, 40),
              heading_class: (h.className || '').toString().slice(0, 60),
              section_tag: sec ? sec.tagName : null,
              section_class: sec ? (sec.className || '').toString().slice(0, 80) : null,
              section_id: sec ? (sec.id || '') : null,
              data_module: sec ? (sec.getAttribute('data-module-name') || '') : null,
            };
          });
          return hits;
        }
        """
    )
    tag = f" ({label})" if label else ""
    print(f"[{keyword}] 플레이스 박스 후보{tag} ({len(info)}):")
    for i, c in enumerate(info):
        print(f"  {i+1}. heading='{c['heading']}' heading_class='{c['heading_class']}'")
        print(f"      section=<{c['section_tag']}> class='{c['section_class']}' id='{c['section_id']}' data-module='{c['data_module']}'")


# ─────────────────────────────────────
# 메인 크롤 로직
# ─────────────────────────────────────
async def crawl_keyword(browser, kw_row: dict, source: str, dry_run: bool = False) -> list[dict]:
    """키워드 1개에 대해 search.naver.com 플레이스 박스 크롤링 → 베라짐 순위 기록.

    기록 규칙:
      - 베라짐 여러 카드(미사/동탄 각각) 시 각 branch별 1건씩
      - 못 찾으면 is_found=false 1건. error 필드에 디버그 JSON(누적 카드명/광고수 등).
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

    found_by_branch: dict[str | None, dict] = {}
    results_rows = []
    snapshot_rows: list[dict] = []  # Phase 1: 경쟁사 상위 20개 저장
    snapshot_timestamp = datetime.now(timezone.utc).isoformat()

    # 누적 통계 (디버그용)
    debug_stats = {
        "pages_scanned": 0,
        "total_cards_seen": 0,
        "total_ads": 0,
        "total_organic": 0,
        "per_page": [],      # [{page, cards, ads, organic, first_name}]
        "collected_names": [],  # 광고 제외 이름 (최대 30개)
        "box_signature": "",
    }

    try:
        url = f"https://search.naver.com/search.naver?where=nexearch&query={quote(keyword)}"
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        # 검색 결과 전체 로드 대기
        await asyncio.sleep(random.uniform(2.5, 3.8))

        # 디버그: 플레이스 박스 후보 덤프 (page1)
        await debug_dump_place_box(page, keyword, label="page1")

        cumulative_rank = 0
        for page_num in range(1, MAX_PAGES + 1):
            # 박스 아래로 스크롤 → lazy content 로드
            try:
                await page.evaluate(
                    """
                    () => {
                      const marker = Array.from(document.querySelectorAll('h2, h3, .api_title'))
                        .find(h => (h.innerText || '').includes('플레이스'));
                      if (marker) marker.scrollIntoView({block: 'center'});
                    }
                    """
                )
            except Exception:
                pass
            await asyncio.sleep(random.uniform(0.8, 1.4))

            try:
                report = await page.evaluate(PLACE_EXTRACT_JS)
            except Exception as e:
                print(f"[{keyword}] page {page_num} extract 실패: {e}")
                report = {"found_box": False, "cards": []}

            if page_num == 1:
                debug_stats["box_signature"] = report.get("box_signature", "")

            page_cards = report.get("cards", []) or []
            page_ads = sum(1 for c in page_cards if c.get("is_ad"))
            page_organic = len(page_cards) - page_ads
            first_name = page_cards[0].get("name", "") if page_cards else ""

            debug_stats["pages_scanned"] = page_num
            debug_stats["total_cards_seen"] += len(page_cards)
            debug_stats["total_ads"] += page_ads
            debug_stats["total_organic"] += page_organic
            debug_stats["per_page"].append({
                "page": page_num,
                "cards": len(page_cards),
                "ads": page_ads,
                "organic": page_organic,
                "first_name": first_name[:30],
            })

            print(f"[{keyword}] page {page_num}: cards={len(page_cards)} (광고={page_ads}, 일반={page_organic})")
            if page_cards:
                for idx, c in enumerate(page_cards[:12]):
                    tag = " [AD]" if c.get("is_ad") else ""
                    nm = (c.get("name") or "")[:40]
                    addr = (c.get("address") or "")[:30]
                    print(f"    {idx+1:2d}. {nm}{tag} | {addr}")

            # 광고 제외 + 누적 순위 매김 + 스냅샷 수집 (DOM 순 1~20)
            for c in page_cards:
                nm = (c.get("name") or "").strip()
                addr = (c.get("address") or "").strip()
                is_ad = bool(c.get("is_ad"))
                img_url = (c.get("image_url") or "").strip()

                # 스냅샷 index 확보 (nameless row는 snapshot 제외)
                snap_idx = None
                if nm and len(snapshot_rows) < MAX_SNAPSHOTS:
                    snap_idx = len(snapshot_rows)
                    snapshot_rows.append({
                        "keyword_id": kw_row["id"],
                        "snapshot_at": snapshot_timestamp,
                        "dom_rank": snap_idx + 1,
                        "organic_rank": None,  # 아래서 채움 (광고면 None 유지)
                        "page": page_num,
                        "is_ad": is_ad,
                        "business_name": nm[:200],
                        "address": addr[:300] if addr else None,
                        "image_url": img_url[:500] if img_url else None,
                        "image_hash": None,   # 뒤에서 채움
                        "source": source,
                    })

                if is_ad:
                    continue
                cumulative_rank += 1

                # 광고 아닌 카드만 organic_rank 부여
                if snap_idx is not None:
                    snapshot_rows[snap_idx]["organic_rank"] = cumulative_rank

                if len(debug_stats["collected_names"]) < 30:
                    debug_stats["collected_names"].append(f"{cumulative_rank}. {nm[:30]}")
                if is_target_name(nm):
                    branch = detect_branch(addr) or detect_branch(nm)
                    if branch in found_by_branch:
                        continue
                    found_by_branch[branch] = {
                        "rank": cumulative_rank,
                        "page": page_num,
                        "name": nm,
                        "address": addr,
                    }
                    print(f"    >>> FOUND '{nm}' branch={branch} rank={cumulative_rank} (page {page_num})")

            if page_num >= MAX_PAGES:
                break

            # 다음 페이지 클릭
            try:
                clicked = await page.evaluate(CLICK_NEXT_JS)
            except Exception as e:
                print(f"[{keyword}] next click 예외: {e}")
                clicked = None
            if not clicked:
                print(f"[{keyword}] 다음 버튼 없음 → page {page_num}에서 종료")
                break
            print(f"[{keyword}] next via '{clicked}'")
            await asyncio.sleep(random.uniform(1.5, 2.3))

        print(f"[{keyword}] 총 스캔: {debug_stats['pages_scanned']}페이지, 카드 {debug_stats['total_cards_seen']}개 (광고 {debug_stats['total_ads']}, 일반 {debug_stats['total_organic']})")

        # 결과 기록
        if found_by_branch:
            for branch, info in found_by_branch.items():
                results_rows.append({
                    "keyword_id": kw_row["id"],
                    "keyword": keyword,
                    "branch": branch,
                    "page": info["page"],
                    "rank": info["rank"],
                    "is_found": True,
                    "card_name": info["name"][:200],
                    "card_address": (info["address"] or "")[:300],
                    "source": source,
                })
        else:
            # 미발견 시 디버그 정보를 error 컬럼에 JSON으로 저장
            debug_json = json.dumps(debug_stats, ensure_ascii=False)[:490]
            results_rows.append({
                "keyword_id": kw_row["id"],
                "keyword": keyword,
                "branch": None,
                "page": None,
                "rank": None,
                "is_found": False,
                "error": debug_json,
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
            "error": (f"[exception] {str(e)} | debug={json.dumps(debug_stats, ensure_ascii=False)}")[:500],
            "source": source,
        })
    finally:
        await ctx.close()

    # Phase 1: 이미지 해시 계산 (동시 실행, 실패해도 전체 크롤에 영향 없음)
    if snapshot_rows:
        print(f"[{keyword}] snapshot {len(snapshot_rows)}건 이미지 해시 계산 중...")
        async def _hash(row):
            row["image_hash"] = await fetch_image_hash(row.get("image_url"))
        try:
            await asyncio.gather(*[_hash(r) for r in snapshot_rows], return_exceptions=True)
        except Exception as e:
            print(f"[warn] {keyword} 이미지 해시 병렬 실패: {e}")

    if not dry_run:
        for row in results_rows:
            try:
                await sb_insert("place_rank_history", row)
            except Exception as e:
                print(f"[warn] insert 실패: {e}")
        # Phase 1: 스냅샷 bulk insert
        if snapshot_rows:
            await insert_snapshots_bulk(snapshot_rows)
            print(f"[{keyword}] snapshot {len(snapshot_rows)}건 저장 완료")

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
    """DB insert 없이 '미사헬스장' 1개 파싱 검증."""
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
        # 정해진 시간(06/13/23)에 가까이 실행되도록 jitter 최소화 (0~5분)
        if os.environ.get("GITHUB_EVENT_NAME") == "schedule":
            import time
            delay = random.randint(0, 300)
            print(f"[info] schedule jitter sleep {delay}s")
            time.sleep(delay)
        asyncio.run(run_all("auto"))
    else:
        asyncio.run(run_one(arg, "manual"))


if __name__ == "__main__":
    main()
