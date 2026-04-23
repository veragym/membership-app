-- ═══════════════════════════════════════════════════════════════════════════
-- migration_v11_tasks.sql — 월간 업무 달력 + 체크리스트 풀 (2026-04-23)
-- ═══════════════════════════════════════════════════════════════════════════
-- 대상 앱 : VeraGym/membership-app (회원권 회원관리)
-- Supabase: lrzffwawpoidimlrbfxe
--
-- ▣ 실행 방법
--   1) Supabase 대시보드 → SQL Editor 열기
--   2) 이 파일 전체 복사 → 붙여넣기 → Run
--   3) 실패 시 오류 라인만 별도 실행 (전체는 IF NOT EXISTS 로 안전 재실행 가능)
--
-- ▣ 변경 요약
--   1. 신규 테이블 : tasks, task_items
--   2. 기존 테이블 수정 : staff_schedules.task_item_id (nullable FK) 추가
--   3. VIEW        : v_tasks_with_progress (진행도 포함)
--   4. 트리거      : updated_at 자동갱신 · is_done 토글 시 done_at/done_by 세팅
--   5. RLS         : authenticated 전체 R/W/D (staff_schedules 동일 패턴)
--   6. 인덱스      : 월간 조회, 체크리스트 풀, 일정↔항목 FK 조회 최적화
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. tasks (기간 업무) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tasks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  description TEXT,
  category    TEXT        NOT NULL DEFAULT '기타'
              CHECK (category IN ('홍보','이벤트','발주','유지보수','기타')),
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','done','archived','cancelled')),
  created_by  UUID        REFERENCES public.trainers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_tasks_date_range
  ON public.tasks (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON public.tasks (status) WHERE status = 'active';

-- ─── 2. task_items (체크리스트 항목) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID        NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  order_index INT         NOT NULL DEFAULT 0,
  content     TEXT        NOT NULL,
  is_done     BOOLEAN     NOT NULL DEFAULT FALSE,
  done_at     TIMESTAMPTZ,
  done_by     UUID        REFERENCES public.trainers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_items_task
  ON public.task_items (task_id, order_index);
CREATE INDEX IF NOT EXISTS idx_task_items_pool
  ON public.task_items (is_done, order_index) WHERE is_done = FALSE;

-- ─── 3. staff_schedules ↔ task_items 연결 ──────────────────────────────
ALTER TABLE public.staff_schedules
  ADD COLUMN IF NOT EXISTS task_item_id UUID
    REFERENCES public.task_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sched_task_item
  ON public.staff_schedules (task_item_id) WHERE task_item_id IS NOT NULL;

-- ─── 4. updated_at 자동 갱신 트리거 ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_updated      ON public.tasks;
DROP TRIGGER IF EXISTS trg_task_items_updated ON public.task_items;
CREATE TRIGGER trg_tasks_updated
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_task_items_updated
  BEFORE UPDATE ON public.task_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─── 5. is_done 토글 시 done_at / done_by 자동 세팅 ───────────────────
CREATE OR REPLACE FUNCTION public.task_item_done_stamp()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_done = TRUE AND (OLD.is_done IS DISTINCT FROM TRUE) THEN
    NEW.done_at = NOW();
    IF NEW.done_by IS NULL THEN
      BEGIN
        NEW.done_by := auth.uid();
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  ELSIF NEW.is_done = FALSE AND OLD.is_done = TRUE THEN
    NEW.done_at = NULL;
    NEW.done_by = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_items_done_stamp ON public.task_items;
CREATE TRIGGER trg_task_items_done_stamp
  BEFORE UPDATE ON public.task_items
  FOR EACH ROW EXECUTE FUNCTION public.task_item_done_stamp();

-- ─── 6. 진행도 뷰 ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_tasks_with_progress AS
SELECT t.*,
       COALESCE(i.total, 0)                            AS items_total,
       COALESCE(i.done,  0)                            AS items_done,
       CASE WHEN COALESCE(i.total, 0) = 0 THEN 0
            ELSE ROUND(i.done::NUMERIC / i.total * 100)
       END                                             AS progress_pct
FROM public.tasks t
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT                           AS total,
         COUNT(*) FILTER (WHERE is_done)::INT    AS done
  FROM public.task_items
  WHERE task_id = t.id
) i ON TRUE;

-- ─── 7. RLS (authenticated 전체 R/W/D — staff_schedules 패턴 준용) ────
ALTER TABLE public.tasks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tasks_all_authenticated"      ON public.tasks;
DROP POLICY IF EXISTS "task_items_all_authenticated" ON public.task_items;

CREATE POLICY "tasks_all_authenticated"
  ON public.tasks
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "task_items_all_authenticated"
  ON public.task_items
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- ═══ 끝 ═══════════════════════════════════════════════════════════════
-- 사후 확인 쿼리 (선택):
--   SELECT * FROM public.v_tasks_with_progress;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'staff_schedules' AND column_name = 'task_item_id';
