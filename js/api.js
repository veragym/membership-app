// Supabase 클라이언트 초기화
// CDN UMD가 window.supabase에 라이브러리를 등록 → createClient 호출 후 인스턴스로 대체
// (const로 재선언하면 Identifier already declared 에러 발생하므로 window 프로퍼티에 직접 할당)
window.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
