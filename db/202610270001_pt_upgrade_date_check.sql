-- Read-only post-deployment check. Does not call pt_upgrade or create member data.
SELECT
  p.oid::regprocedure::text AS signature,
  pg_get_function_arguments(p.oid) AS arguments,
  pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS security_definer,
  p.proacl::text AS execution_grants,
  position('v_upgrade_date date := p_contract_date;' IN p.prosrc) > 0 AS accepts_selected_date
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'pt_upgrade'
ORDER BY p.pronargs;
