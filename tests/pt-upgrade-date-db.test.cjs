const assert = require('node:assert/strict');
const { before, after, beforeEach, afterEach, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const original = fs.readFileSync(path.join(__dirname, 'fixtures/pt-upgrade-original.sql'), 'utf8');
const migrationPath = path.join(root, 'db/202610270001_pt_upgrade_date.sql');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
const regId = '10000000-0000-4000-8000-000000000001';
const memberId = '20000000-0000-4000-8000-000000000001';
const trainerId = '30000000-0000-4000-8000-000000000001';
const productId = '40000000-0000-4000-8000-000000000001';
const schema = `
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
  CREATE TABLE trainers (id uuid PRIMARY KEY, name text);
  CREATE TABLE members (
    id uuid PRIMARY KEY, phone text, is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(), trainer_id uuid, contract_trainer_id uuid,
    status_override text
  );
  CREATE TABLE pt_registrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, phone text,
    pt_count integer, session_price integer, contract_trainer_id uuid,
    assigned_trainer_id uuid, contract_date date, total_payment_cash integer,
    total_payment_card integer, is_upgrade boolean DEFAULT false,
    upgraded_from_pt_id uuid, notes text, sync_status text, category text, gym_location text
  );
  CREATE TABLE pt_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid,
    contract_date date, total_sessions integer, remaining_sessions integer,
    contract_trainer_id uuid, price_per_session integer, status text,
    is_active boolean, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE payment_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_date date,
    member_name text, member_id uuid, total_sessions integer, payment_amount integer,
    trainer_id uuid, trainer_name text, pt_product_id uuid
  );
  CREATE TABLE pt_upgrade_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, member_phone text,
    member_name text, prev_pt_registration_id uuid, new_pt_registration_id uuid,
    prev_pt_product_id uuid, new_pt_product_id uuid, prev_session_price integer,
    new_session_price integer, prev_total_sessions integer, prev_remaining_sessions integer,
    prev_price_per_session integer, prev_contract_date date, add_count integer,
    paid_cash integer, paid_card integer, prev_contract_trainer_id uuid,
    new_contract_trainer_id uuid, upgraded_by uuid, note text,
    created_at timestamptz DEFAULT now()
  );
`;

async function createDatabase(applyMigration = true) {
  const instance = new PGlite();
  await instance.exec(schema);
  await instance.exec(original.trim() + ';');
  await instance.exec(`
    REVOKE ALL ON FUNCTION public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text) TO authenticated;
  `);
  if (applyMigration && migration) await instance.exec(migration);
  return instance;
}

let db;
before(async () => { db = await createDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`BEGIN;
    INSERT INTO trainers VALUES ('${trainerId}', '테스트코치');
    INSERT INTO members(id,phone,trainer_id) VALUES ('${memberId}','010-0000-0000','${trainerId}');
    INSERT INTO pt_registrations(id,name,phone,pt_count,session_price,contract_trainer_id,assigned_trainer_id,contract_date)
      VALUES ('${regId}','테스트회원','010-0000-0000',12,60000,'${trainerId}','${trainerId}','2026-08-12');
    INSERT INTO pt_products(id,member_id,contract_date,total_sessions,remaining_sessions,contract_trainer_id,price_per_session,status,is_active)
      VALUES ('${productId}','${memberId}','2026-08-12',12,9,'${trainerId}',60000,'active',true);
  `);
});
afterEach(async () => { await db.exec('ROLLBACK;'); });

async function upgrade(date) {
  const response = await db.query(`SELECT public.pt_upgrade(
    $1::uuid,6,50000,330000,0,NULL::uuid,NULL::uuid,NULL::text,$2::date
  ) AS result`, [regId, date]);
  return response.rows[0].result;
}

test('chosen date reaches the registration, product, payment, and returned result atomically', async () => {
  const result = await upgrade('2026-09-30');
  assert.equal(result.ok, true);
  assert.equal(result.new_contract_date, '2026-09-30');
  const reg = (await db.query('SELECT contract_date::text AS day FROM pt_registrations WHERE id=$1', [result.new_pt_registration_id])).rows[0];
  const product = (await db.query('SELECT contract_date::text AS day,total_sessions,remaining_sessions,price_per_session FROM pt_products WHERE id=$1', [productId])).rows[0];
  const payment = (await db.query('SELECT payment_date::text AS day,payment_amount,total_sessions FROM payment_records')).rows[0];
  assert.equal(reg.day, '2026-09-30');
  assert.deepEqual(product, { day: '2026-09-30', total_sessions: 18, remaining_sessions: 15, price_per_session: 56667 });
  assert.deepEqual(payment, { day: '2026-09-30', payment_amount: 330000, total_sessions: 6 });
  const old = (await db.query('SELECT contract_date::text AS day,pt_count,session_price FROM pt_registrations WHERE id=$1', [regId])).rows[0];
  assert.deepEqual(old, { day: '2026-08-12', pt_count: 12, session_price: 60000 });
  const audit = (await db.query('SELECT prev_contract_date::text AS day, created_at::date=current_date AS recorded_today FROM pt_upgrade_history')).rows[0];
  assert.deepEqual(audit, { day: '2026-08-12', recorded_today: true });
});

test('creating a product when no active product exists uses the chosen date', async () => {
  await db.exec('DELETE FROM pt_products;');
  await upgrade('2026-09-30');
  assert.equal((await db.query('SELECT contract_date::text AS day FROM pt_products')).rows[0].day, '2026-09-30');
});

test('an unmatched member still records the selected registration date', async () => {
  await db.exec('DELETE FROM members;');
  const result = await upgrade('2026-09-30');
  assert.equal(result.member_matched, false);
  assert.equal((await db.query('SELECT contract_date::text AS day FROM pt_registrations WHERE is_upgrade')).rows[0].day, '2026-09-30');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_records')).rows[0].n, 0);
});

test('the original eight-argument call keeps its existing current-date behavior', async () => {
  const result = (await db.query(`SELECT public.pt_upgrade($1::uuid,6,50000,330000,0,NULL::uuid,NULL::uuid,NULL::text) AS result`, [regId])).rows[0].result;
  const today = (await db.query('SELECT current_date::text AS day')).rows[0].day;
  assert.equal(result.new_contract_date, today);
});

test('a missing selected date is rejected instead of silently using today', async () => {
  await assert.rejects(upgrade(null), /업그레이드 날짜/);
});

test('a later payment error rolls back the new registration and product changes', async () => {
  await db.exec('ALTER TABLE payment_records ADD CONSTRAINT reject_test_payment CHECK (payment_amount < 0); SAVEPOINT upgrade_attempt;');
  await assert.rejects(upgrade('2026-09-30'), /reject_test_payment/);
  await db.exec('ROLLBACK TO SAVEPOINT upgrade_attempt;');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pt_registrations')).rows[0].n, 1);
  assert.equal((await db.query('SELECT total_sessions FROM pt_products')).rows[0].total_sessions, 12);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pt_upgrade_history')).rows[0].n, 0);
});

test('the dated overload preserves existing function ownership and execution permissions', async () => {
  const row = (await db.query(`SELECT
    has_function_privilege('authenticated','public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text,date)','EXECUTE') AS staff,
    has_function_privilege('anon','public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text,date)','EXECUTE') AS anonymous,
    (SELECT proowner FROM pg_proc WHERE oid='public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text)'::regprocedure)
      = (SELECT proowner FROM pg_proc WHERE oid='public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text,date)'::regprocedure) AS same_owner
  `)).rows[0];
  assert.deepEqual(row, { staff: true, anonymous: false, same_owner: true });
  await db.exec('SET LOCAL ROLE authenticated;');
  assert.equal((await upgrade('2026-09-30')).ok, true);
});

test('migration refuses to overwrite a changed original function', async () => {
  assert.ok(migration, 'the reviewed migration is available');
  const other = await createDatabase(false);
  try {
    await other.exec(original.replace('v_today date := CURRENT_DATE;', 'v_today date := CURRENT_DATE - 1;').trim() + ';');
    await assert.rejects(other.exec(migration), /원본.*변경/);
    await other.exec('ROLLBACK;');
    assert.equal((await other.query("SELECT to_regprocedure('public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text,date)')::text AS signature")).rows[0].signature, null);
  } finally { await other.close(); }
});

test('reapplying the migration keeps the original body and a distinct owner intact', async () => {
  assert.ok(migration, 'the reviewed migration is available');
  const other = await createDatabase(false);
  try {
    await other.exec(`CREATE ROLE upgrade_owner;
      ALTER FUNCTION public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text) OWNER TO upgrade_owner;`);
    const before = (await other.query("SELECT prosrc FROM pg_proc WHERE oid='public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text)'::regprocedure")).rows[0].prosrc;
    await other.exec(migration);
    await other.exec(migration);
    const after = (await other.query("SELECT prosrc FROM pg_proc WHERE oid='public.pt_upgrade(uuid,integer,integer,integer,integer,uuid,uuid,text)'::regprocedure")).rows[0].prosrc;
    assert.equal(after, before);
    const functions = (await other.query(`SELECT pg_get_userbyid(proowner) AS owner,
      (SELECT string_agg(access.grantee::text || ':' || access.is_grantable::text, ',' ORDER BY access.grantee)
       FROM aclexplode(coalesce(proacl, acldefault('f',proowner))) access WHERE privilege_type='EXECUTE') AS permissions
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='pt_upgrade' ORDER BY pronargs`)).rows;
    assert.equal(functions.length, 2);
    assert.equal(functions[0].owner, 'upgrade_owner');
    assert.deepEqual(functions[1], functions[0]);
  } finally { await other.close(); }
});
