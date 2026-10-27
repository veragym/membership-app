const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const registration = {
  id: '11111111-1111-4111-8111-111111111111', name: '테스트회원', phone: '',
  contract_date: '2026-10-12', pt_count: 12, session_price: 60000,
  contract_amount: 720000, sync_status: 'synced',
};

async function openUpgrade(t, rpcResponse = { data: { ok: true, member_matched: true }, error: null }) {
  const dom = new JSDOM('<!doctype html><div id="tab-pt"></div>', {
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [], messages = [];
  window.supabase = {
    from(table) {
      const query = {
        select() { return this; }, neq() { return this; }, order() { return this; },
        then(resolve, reject) {
          return Promise.resolve({ data: table === 'trainers'
            ? [{ id: 'trainer-1', name: '테스트코치', is_active: true }]
            : [registration], error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) { calls.push({ name, args }); return rpcResponse; },
  };
  window.Toast = Object.fromEntries(['success', 'warning', 'error'].map(level => [level, text => messages.push({ level, text })]));
  window.ColumnFilter = { apply: (_, rows) => rows, activeCount: () => 0, attach() {} };
  for (const file of ['js/utils.js', 'js/components/modal.js', 'js/tabs/pt.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), dom.getInternalVMContext(), { filename: file });
  }
  await window.eval('PtTab.init()');
  window.document.querySelector('.btn-upgrade').click();
  const form = window.document.querySelector('#pt-upgrade-form');
  assert.ok(form, 'the saved PT row opens its upgrade form');
  form.elements.add_count.value = '6';
  form.elements.paid_cash.value = '330000';
  form.elements.paid_card.value = '0';
  return { window, form, calls, messages };
}

async function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
}

test('upgrade form offers a required date defaulting to the local day', async t => {
  const { window, form } = await openUpgrade(t);
  const date = form.querySelector('input[name="contract_date"]');
  assert.ok(date, 'upgrade date input is available');
  assert.equal(date.type, 'date');
  assert.equal(date.required, true);
  assert.equal(date.value, window.eval('todayISO()'));
  assert.equal(form.querySelector(`label[for="${date.id}"]`).textContent.trim(), '업그레이드 날짜 *');
});

test('selected date is sent with unchanged count, payment, and trainer options', async t => {
  const { window, form, calls } = await openUpgrade(t);
  const date = form.querySelector('input[name="contract_date"]');
  assert.ok(date, 'upgrade date input is available');
  date.value = '2026-09-30';
  await submit(window, form);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ name: 'pt_upgrade', args: {
    p_prev_pt_registration_id: registration.id, p_add_count: 6,
    p_new_session_price: 50000, p_paid_cash: 330000, p_paid_card: 0,
    p_assigned_trainer_id: null, p_contract_trainer_id: null, p_note: null,
    p_contract_date: '2026-09-30',
  } }]);
});

test('an empty date is rejected without calling the upgrade command', async t => {
  const { window, form, calls, messages } = await openUpgrade(t);
  const date = form.querySelector('input[name="contract_date"]');
  assert.ok(date, 'upgrade date input is available');
  date.value = '';
  await submit(window, form);
  assert.equal(calls.length, 0);
  assert.ok(messages.some(item => item.level === 'warning' && item.text.includes('날짜')));
});

test('a server without date support preserves the selected date and never retries with today', async t => {
  const { window, form, calls, messages } = await openUpgrade(t, {
    data: null, error: { code: 'PGRST202', message: 'Function not found in schema cache' },
  });
  const date = form.querySelector('input[name="contract_date"]');
  assert.ok(date, 'upgrade date input is available');
  date.value = '2026-09-30';
  await submit(window, form);
  assert.equal(calls.length, 1);
  assert.equal(date.value, '2026-09-30');
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
  assert.ok(messages.some(item => item.level === 'error' && item.text.includes('날짜 지정 저장')));
});
