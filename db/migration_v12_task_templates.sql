-- ═══ v12: 매월 고정업무 템플릿 ════════════════════════════════════
-- 목적: 매월 반복되는 업무를 템플릿으로 관리하고, 월 단위로 복제 생성.

-- 1) task_templates: 반복 템플릿 정의
CREATE TABLE IF NOT EXISTS task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  category text NOT NULL DEFAULT '기타',
  day_of_month_start int NOT NULL CHECK (day_of_month_start BETWEEN 1 AND 31),
  duration_days int NOT NULL DEFAULT 1 CHECK (duration_days BETWEEN 1 AND 31),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2) task_template_items: 템플릿의 체크리스트 항목
CREATE TABLE IF NOT EXISTS task_template_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  order_index int NOT NULL DEFAULT 0,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_template_items_tpl_idx
  ON task_template_items(template_id, order_index);

-- 3) tasks에 템플릿 연결 칼럼
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES task_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_ym text;  -- 'YYYY-MM'

-- 중복 생성 방지: 같은 템플릿이 같은 달에 두 번 생성되지 않도록
CREATE UNIQUE INDEX IF NOT EXISTS tasks_template_ym_unique
  ON tasks(template_id, template_ym)
  WHERE template_id IS NOT NULL;

-- 4) updated_at 자동 갱신 (v11에서 만들어둔 touch_updated_at 재사용)
DROP TRIGGER IF EXISTS task_templates_touch ON task_templates;
CREATE TRIGGER task_templates_touch
  BEFORE UPDATE ON task_templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 5) RLS
ALTER TABLE task_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_template_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth all" ON task_templates;
CREATE POLICY "auth all" ON task_templates FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth all" ON task_template_items;
CREATE POLICY "auth all" ON task_template_items FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
