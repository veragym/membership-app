# Place Rank Crawler

네이버 플레이스 검색 결과에서 '베라짐' 카드의 순위(페이지/카드순)를 추적하고 Supabase `place_rank_history`에 기록하는 크롤러.

## 로컬 실행
```bash
# 1) 의존성 설치
pip install -r requirements.txt
playwright install chromium

# 2) 환경변수
cp .env.example .env
# .env 편집: SUPABASE_SERVICE_ROLE_KEY 입력

# 3) 실행
set SUPABASE_URL=https://lrzffwawpoidimlrbfxe.supabase.co
set SUPABASE_SERVICE_ROLE_KEY=...
python place_rank.py test         # '미사헬스장' dry-run
python place_rank.py              # 전체 active 키워드
python place_rank.py <keyword_id> # 특정 키워드 1개
```

## GitHub Actions
- 워크플로: `.github/workflows/place-rank.yml`
- secrets 등록 필요:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
- cron: `7 */2 * * *` (매 2시간 7분) + 파이썬 내부 0~59분 랜덤 지연
- 수동 트리거: GitHub Actions 탭에서 **Run workflow** 클릭 또는
  Supabase Edge Function `trigger-place-rank` 호출

## 감지 회피
- UA 로테이션 (iOS/Android 6종)
- 키워드 간 4~9초 랜덤 대기, 페이지 내 스크롤 시뮬
- 모바일 엔드포인트(`m.search.naver.com` / `m.place.naver.com`) 사용
- `--disable-blink-features=AutomationControlled` 플래그

## 주의
- 네이버 DOM 구조 변경 시 `parse_cards_on_page()` 의 셀렉터 업데이트 필요.
- 실패/차단 감지 시 `place_rank_history.error` 컬럼에 이유 기록.
