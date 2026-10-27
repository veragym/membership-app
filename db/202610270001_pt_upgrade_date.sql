-- PT upgrade date support, based on the operator-supplied function on 2026-10-27.
-- Keeps the original 8-argument function unchanged for existing clients.
-- Adds an explicit 9th argument; no defaults, so PostgREST can distinguish both calls.
-- Preserves current-month trainer propagation, arithmetic, audit timestamps, owner and ACL.
-- Apply this file in the Supabase SQL Editor BEFORE publishing the web change.
BEGIN;

DO $verify_original$
DECLARE
  original_body text;
BEGIN
  SELECT prosrc INTO original_body FROM pg_proc
  WHERE oid = to_regprocedure('public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text)');
  IF original_body IS NULL OR md5(btrim(replace(original_body, E'\r\n', E'\n'), E'\n')) <> '0854a766d1c47ea0de0939878f869d41' THEN
    RAISE EXCEPTION 'pt_upgrade 원본 함수가 변경되었거나 없습니다. 최신 함수 정의를 확인한 뒤 적용하세요.';
  END IF;
END
$verify_original$;

CREATE OR REPLACE FUNCTION public.pt_upgrade(
  p_prev_pt_registration_id uuid,
  p_add_count integer,
  p_new_session_price integer,
  p_paid_cash integer,
  p_paid_card integer,
  p_assigned_trainer_id uuid,
  p_contract_trainer_id uuid,
  p_note text,
  p_contract_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prev pt_registrations%ROWTYPE;
  v_member_id uuid;
  v_new_pt_reg_id uuid;
  v_target_product_id uuid;
  v_prev_total int;
  v_prev_remaining int;
  v_prev_price int;
  v_prev_contract_date date;
  v_weighted_price int;
  v_total_payment int;
  v_upgrade_date date := p_contract_date;
  v_month_start date := date_trunc('month', CURRENT_DATE)::date;
  v_final_contract_trainer_id uuid;
  v_final_assigned_trainer_id uuid;
  v_propagate_trainer boolean;
  v_propagated_pt_reg_count int := 0;
  v_propagated_pay_count int := 0;
BEGIN
  IF p_contract_date IS NULL OR NOT isfinite(p_contract_date) THEN
    RAISE EXCEPTION '업그레이드 날짜를 지정해주세요.';
  END IF;

  IF p_add_count IS NULL OR p_add_count <= 0 THEN
    RAISE EXCEPTION '추가 회수는 1 이상이어야 합니다 (got: %)', p_add_count;
  END IF;
  IF p_new_session_price IS NULL OR p_new_session_price < 0 THEN
    RAISE EXCEPTION '단가는 0 이상이어야 합니다 (got: %)', p_new_session_price;
  END IF;

  SELECT * INTO v_prev FROM pt_registrations WHERE id = p_prev_pt_registration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '원본 PT 등록을 찾을 수 없습니다: %', p_prev_pt_registration_id;
  END IF;

  v_final_contract_trainer_id := COALESCE(p_contract_trainer_id, v_prev.contract_trainer_id);
  v_final_assigned_trainer_id := COALESCE(p_assigned_trainer_id, v_prev.assigned_trainer_id);
  v_total_payment := COALESCE(p_paid_cash, 0) + COALESCE(p_paid_card, 0);
  v_propagate_trainer := (
    p_contract_trainer_id IS NOT NULL
    AND p_contract_trainer_id <> v_prev.contract_trainer_id
  );

  IF v_prev.phone IS NOT NULL AND v_prev.phone <> '' THEN
    SELECT id INTO v_member_id
    FROM members
    WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g')
        = regexp_replace(v_prev.phone, '[^0-9]', '', 'g')
      AND COALESCE(is_active, true) = true
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  INSERT INTO pt_registrations (
    name, phone, pt_count, session_price,
    contract_trainer_id, assigned_trainer_id,
    contract_date, total_payment_cash, total_payment_card,
    is_upgrade, upgraded_from_pt_id, notes,
    sync_status, category, gym_location
  ) VALUES (
    v_prev.name, v_prev.phone, p_add_count, p_new_session_price,
    v_final_contract_trainer_id, v_final_assigned_trainer_id,
    v_upgrade_date, COALESCE(p_paid_cash, 0), COALESCE(p_paid_card, 0),
    true, p_prev_pt_registration_id, p_note,
    'disabled', '업그레이드', COALESCE(v_prev.gym_location, '미사점')
  )
  RETURNING id INTO v_new_pt_reg_id;

  IF v_member_id IS NOT NULL THEN
    -- ★ 회원 갱신: 담당 트레이너 변경 반영 + 수동 상태 잠금 해제
    --   (이후 pt_products UPDATE 의 AFTER 트리거가 member_status 자동 재계산)
    UPDATE members m
       SET trainer_id          = COALESCE(p_assigned_trainer_id, m.trainer_id),
           contract_trainer_id = COALESCE(p_contract_trainer_id, m.contract_trainer_id),
           status_override     = NULL
     WHERE m.id = v_member_id;

    SELECT id, total_sessions, remaining_sessions, price_per_session, contract_date
    INTO v_target_product_id, v_prev_total, v_prev_remaining, v_prev_price, v_prev_contract_date
    FROM pt_products
    WHERE member_id = v_member_id
      AND status = 'active'
      AND COALESCE(is_active, true) = true
    ORDER BY contract_date DESC, created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF v_target_product_id IS NULL THEN
      INSERT INTO pt_products (
        member_id, contract_date, total_sessions, remaining_sessions,
        contract_trainer_id, price_per_session, status, is_active
      ) VALUES (
        v_member_id, v_upgrade_date, p_add_count, p_add_count,
        v_final_contract_trainer_id, p_new_session_price, 'active', true
      )
      RETURNING id INTO v_target_product_id;
      v_prev_total := 0; v_prev_remaining := 0; v_prev_price := NULL;
      v_prev_contract_date := NULL;
    ELSE
      v_weighted_price := ROUND(
        ((v_prev_total::numeric * v_prev_price::numeric) + (p_add_count::numeric * p_new_session_price::numeric))
        / (v_prev_total + p_add_count)::numeric
      )::integer;

      UPDATE pt_products
        SET total_sessions = v_prev_total + p_add_count,
            remaining_sessions = v_prev_remaining + p_add_count,
            price_per_session = v_weighted_price,
            contract_trainer_id = v_final_contract_trainer_id,
            contract_date = v_upgrade_date
      WHERE id = v_target_product_id;
    END IF;

    INSERT INTO payment_records (
      payment_date, member_name, member_id,
      total_sessions, payment_amount,
      trainer_id, trainer_name, pt_product_id
    ) VALUES (
      v_upgrade_date, v_prev.name, v_member_id,
      p_add_count, v_total_payment,
      v_final_contract_trainer_id,
      (SELECT name FROM trainers WHERE id = v_final_contract_trainer_id),
      v_target_product_id
    );

    -- payment_records propagation: 당월 결제만 (작년/전월 매출 보존)
    IF v_propagate_trainer AND v_target_product_id IS NOT NULL THEN
      UPDATE payment_records
        SET trainer_id = v_final_contract_trainer_id,
            trainer_name = (SELECT name FROM trainers WHERE id = v_final_contract_trainer_id)
      WHERE pt_product_id = v_target_product_id
        AND payment_date >= v_month_start
        AND trainer_id IS DISTINCT FROM v_final_contract_trainer_id;
      GET DIAGNOSTICS v_propagated_pay_count = ROW_COUNT;
    END IF;
  END IF;

  -- pt_registrations propagation: lineage chain AND 당월 등록만
  IF v_propagate_trainer THEN
    WITH RECURSIVE upgrade_chain AS (
      SELECT id FROM pt_registrations WHERE id = p_prev_pt_registration_id
      UNION ALL
      SELECT pr.id FROM pt_registrations pr
      JOIN upgrade_chain uc ON pr.upgraded_from_pt_id = uc.id
    )
    UPDATE pt_registrations
      SET contract_trainer_id = v_final_contract_trainer_id
    WHERE id IN (SELECT id FROM upgrade_chain)
      AND id <> v_new_pt_reg_id
      AND contract_date >= v_month_start
      AND contract_trainer_id IS DISTINCT FROM v_final_contract_trainer_id;
    GET DIAGNOSTICS v_propagated_pt_reg_count = ROW_COUNT;
  END IF;

  INSERT INTO pt_upgrade_history (
    member_id, member_phone, member_name,
    prev_pt_registration_id, new_pt_registration_id,
    prev_pt_product_id, new_pt_product_id,
    prev_session_price, new_session_price,
    prev_total_sessions, prev_remaining_sessions, prev_price_per_session,
    prev_contract_date,
    add_count, paid_cash, paid_card,
    prev_contract_trainer_id, new_contract_trainer_id,
    upgraded_by, note
  ) VALUES (
    v_member_id, v_prev.phone, v_prev.name,
    p_prev_pt_registration_id, v_new_pt_reg_id,
    v_target_product_id, v_target_product_id,
    v_prev.session_price, p_new_session_price,
    v_prev_total, v_prev_remaining, v_prev_price,
    v_prev_contract_date,
    p_add_count, COALESCE(p_paid_cash, 0), COALESCE(p_paid_card, 0),
    v_prev.contract_trainer_id, v_final_contract_trainer_id,
    auth.uid(),
    COALESCE(p_note, '') ||
      CASE WHEN v_propagate_trainer
        THEN format(' [트레이너 propagation 당월한정: pt_reg %s건, payment %s건]',
                    v_propagated_pt_reg_count, v_propagated_pay_count)
        ELSE '' END
  );

  RETURN jsonb_build_object(
    'ok', true,
    'new_pt_registration_id', v_new_pt_reg_id,
    'updated_pt_product_id', v_target_product_id,
    'prev_total_sessions', v_prev_total,
    'new_total_sessions', v_prev_total + p_add_count,
    'weighted_session_price', COALESCE(v_weighted_price, p_new_session_price),
    'new_contract_date', v_upgrade_date,
    'member_matched', v_member_id IS NOT NULL,
    'member_id', v_member_id,
    'total_payment', v_total_payment,
    'trainer_propagated', v_propagate_trainer,
    'propagated_pt_reg_count', v_propagated_pt_reg_count,
    'propagated_payment_count', v_propagated_pay_count,
    'propagation_scope', 'current_month_only',
    'month_start', v_month_start
  );
END;
$function$;

-- New PostgreSQL functions may receive default grants. Replace them with the
-- reviewed original function's exact execution grants in this same transaction.
DO $copy_access$
DECLARE
  old_function regprocedure := 'public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text)'::regprocedure;
  new_function regprocedure := 'public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text,date)'::regprocedure;
  permission record;
  recipient text;
  original_owner text;
BEGIN
  SELECT pg_get_userbyid(proowner) INTO original_owner FROM pg_proc WHERE oid = old_function;

  FOR permission IN
    SELECT DISTINCT access.grantee
    FROM pg_proc function_row,
      LATERAL aclexplode(coalesce(function_row.proacl, acldefault('f', function_row.proowner))) access
    WHERE function_row.oid = new_function
  LOOP
    recipient := CASE WHEN permission.grantee = 0 THEN 'PUBLIC'
      ELSE quote_ident(pg_get_userbyid(permission.grantee)) END;
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s', new_function, recipient);
  END LOOP;

  FOR permission IN
    SELECT access.grantee, access.is_grantable
    FROM pg_proc function_row,
      LATERAL aclexplode(coalesce(function_row.proacl, acldefault('f', function_row.proowner))) access
    WHERE function_row.oid = old_function AND access.privilege_type = 'EXECUTE'
  LOOP
    recipient := CASE WHEN permission.grantee = 0 THEN 'PUBLIC'
      ELSE quote_ident(pg_get_userbyid(permission.grantee)) END;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', new_function, recipient,
      CASE WHEN permission.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;

  EXECUTE format('ALTER FUNCTION %s OWNER TO %I', new_function, original_owner);
END
$copy_access$;

NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT to_regprocedure('public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text,date)') IS NOT NULL
  AS date_upgrade_ready;
