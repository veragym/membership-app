# Place Rank Crawler (search.naver.com 방식, v2)

네이버 **통합검색 결과의 '플레이스' 박스**에서 '베라짐' 카드의 누적 순위(1~29)를 추적하고 Supabase `place_rank_history`에 기록.

## 로직 요약

- 엔드포인트: `https://search.naver.com/search.naver?query=<keyword>`
- 플레이스 박스 스코프 내에서 8슬롯(2열×4행) × 최대 5페이지 순회
- 광고 뱃지(`광고`/`AD`/`광고ⓘ`) 제외하고 누적 순위 매김
  - 1페이지: 광고 3 + 일반 5 → 누적 1~5
  - 2~5페이지: 광고 2 + 일반 6 → 누적 6~29
- 카드명에 `베라짐` 포함 → `is_found=true`, 주소에 `미사`/`동탄` → branch 자동 태깅
- 미발견 시 `error` 컬럼에 디버그 JSON(스캔 페이지 수, 카드 수, 광고 수, 수집된 이름 목록) 저장

## 로컬 실행

```bash
pip install -r requirements.txt
playwright install chromium

set SUPABASE_URL=https://lrzffwawpoidimlrbfxe.supabase.co
set SUPABASE_SERVICE_ROLE_KEY=...

python place_rank.py test         # '미사헬스장' dry-run
python place_rank.py              # 전체 active 키워드
python place_rank.py <keyword_id> # 특정 키워드 1개
```

## GitHub Actions

- 워크플로: `.github/workflows/place-rank.yml`
- secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- cron: `7 */2 * * *` (매 2시간 7분) + 파이썬 내부 0~59분 랜덤 지연
- 수동 트리거: Actions 탭 Run workflow / Supabase Edge Function `trigger-place-rank`

## 감지 회피

- UA 로테이션 (Chrome/Edge/Safari/Firefox)
- 키워드 간 4~9초 랜덤 대기, 페이지 전환 간 1.5~2.3초
- `--disable-blink-features=AutomationControlled`

## 디버그

- `python place_rank.py test` 실행 시 콘솔에 페이지별 카드 이름 전부 출력
- 미발견(`is_found=false`) 시 DB의 `error` 컬럼에 JSON 디버그 정보 누적
  - `pages_scanned`, `total_cards_seen`, `total_ads`, `total_organic`
  - `per_page[]` — 페이지별 상세 (첫 카드 이름 등)
  - `collected_names[]` — 광고 제외 누적 순위 1~30위 이름
  - `box_signature` — 플레이스 박스 셀렉터 판단 경로

## 주의

- 네이버 DOM 클래스명은 주기적으로 바뀜. `PLACE_EXTRACT_JS`의 셀렉터 조정 필요할 수 있음.
- 페이지네이션 실패 시 `CLICK_NEXT_JS` 우선순위 로직 갱신 필요.
- `is_found=false` 지속 시 DB의 `error` JSON 확인 후 원인 진단.
