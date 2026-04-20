# membership-app

베라짐 미사점 **회원권·PT 통합 회원 관리** SPA (관리자/상담직원 전용).

- 스택: Vanilla JS + Supabase JS v2 CDN (빌드 스텝 없음)
- 탭: 문의관리 · 통계 · PT등록회원 · 홍보관리 · 설정(admin)
- DB: Supabase 프로젝트 `lrzffwawpoidimlrbfxe` (veragym-app 공유)
- 배포: GitHub Pages (`veragym.github.io/membership-app/`)

## 초기 설정 (최초 clone 시)

```bash
cp js/config.example.js js/config.js
# js/config.js 를 열어 SUPABASE_URL + SUPABASE_ANON_KEY 입력
```

`js/config.js` 는 `.gitignore` 로 커밋되지 않습니다.

## 로컬 실행

```bash
python -m http.server 8765
# 브라우저: http://localhost:8765/
```

정적 서빙만 필요하므로 어떤 HTTP 서버든 무방합니다.

## 권한

- `admin` / `counselor` (`trainers.role`) 만 로그인 허용
- `trainer` role 은 auth 단계에서 거부됨
- 테이블 RLS 가 최종 가드

## 구조

```
index.html
css/{tokens.css, app.css}
js/
  config.example.js   # 템플릿 (커밋됨)
  config.js           # 실제 키 (.gitignore)
  app.js              # 앱 초기화, 탭 라우팅
  auth.js             # 로그인 + 권한 체크
  api.js              # Supabase 클라이언트
  utils.js            # formatPhone/debounce/escHtml/sanitizeSearch
  components/         # toast, modal, dropdown
  tabs/               # inquiry, pt, import, stats, settings, promo
```

## 배포

`main` 브랜치 푸시 → GitHub Pages 자동 빌드
