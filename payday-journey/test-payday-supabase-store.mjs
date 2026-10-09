// supabaseStore against a RECORDING FAKE client: checks the tables, filters and error handling each
// method uses. It is NOT a test against a live Supabase project; the SQL itself is covered by
// migrations 003/004 run on a scratch Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseStore } from './index.js';

function fake(respond) {
  const log = [];
  const client = {
    schema: (s) => ({
      rpc: (fn, args) => {
        const ops = [['rpc', fn, args]];
        log.push({ schema: s, table: `rpc:${fn}`, ops });
        return { then: (res, rej) => Promise.resolve(respond(`rpc:${fn}`, ops)).then(res, rej) };
      },
      from: (table) => {
        const ops = [];
        const entry = { schema: s, table, ops };
        log.push(entry);
        const q = new Proxy({}, {
          get: (_, m) => {
            if (m === 'then') return (res, rej) => Promise.resolve(respond(table, ops)).then(res, rej);
            return (...a) => { ops.push([m, ...a]); return q; };
          },
        });
        return q;
      },
    }),
  };
  return { log, client };
}
const ok = (data = null, extra = {}) => ({ data, error: null, ...extra });
const names = (entry) => entry.ops.map((o) => o[0]);

test('every call targets the payday schema', async () => {
  const { log, client } = fake(() => ok([]));
  const s = supabaseStore(client);
  await s.hasOpenLoan('c1');
  await s.listOpenLoans();
  await s.getSchedule('l1');
  assert.ok(log.every((e) => e.schema === 'payday'));
});

test('open-loan queries use the same statuses as the database index', async () => {
  const { log, client } = fake(() => ok([{ id: 'l1' }]));
  const s = supabaseStore(client);
  assert.equal(await s.hasOpenLoan('c1'), true);
  assert.deepEqual(log[0].ops.find((o) => o[0] === 'in'), ['in', 'status', ['active', 'overdue']]);
  await s.listOpenLoans();
  assert.deepEqual(log[1].ops.find((o) => o[0] === 'not'), ['not', 'disbursed_at', 'is', null]);
});

test('co-lending shares: effective-date window and numeric percentages', async () => {
  const { log, client } = fake(() => ok([{ lender_id: 'a', share_pct: '80.00' }, { lender_id: 'b', share_pct: '20.00' }]));
  const shares = await supabaseStore(client).getColendingShares('p1', '2026-01-01');
  assert.deepEqual(shares, [{ lender_id: 'a', share_pct: 80 }, { lender_id: 'b', share_pct: 20 }]);
  const ops = log[0].ops;
  assert.deepEqual(ops.find((o) => o[0] === 'lte'), ['lte', 'effective_from', '2026-01-01']);
  assert.deepEqual(ops.find((o) => o[0] === 'or'), ['or', 'effective_to.is.null,effective_to.gte.2026-01-01']);
});

test('countLoans counts disbursed loans only', async () => {
  const { log, client } = fake(() => ({ data: null, error: null, count: 3 }));
  assert.equal(await supabaseStore(client).countLoans('c1'), 3);
  assert.ok(log[0].ops.some((o) => o[0] === 'not' && o[1] === 'disbursed_at'));
});

test('limits and ledger balance', async () => {
  const { log, client } = fake((table) => (table === 'loan_ledger_balance' ? ok({ balance: '10800.00' }) : ok({ limit_amount: 15000 })));
  const s = supabaseStore(client);
  assert.equal(await s.getLedgerBalance('l1'), 10800);
  assert.equal((await s.getCurrentLimit('c1')).limit_amount, 15000);
  assert.deepEqual(log[1].ops.find((o) => o[0] === 'order'), ['order', 'effective_from', { ascending: false }]);
});

test('webhook events: a unique violation falls back to reading whether it was processed', async () => {
  let call = 0;
  const { client } = fake((table) => {
    call += 1;
    if (call === 1) return { data: null, error: { code: '23505', message: 'duplicate' } };
    return ok({ processed_at: '2026-01-01T00:00:00Z' });
  });
  const r = await supabaseStore(client).recordVendorEvent({ provider: 'acme', event_id: 'e1', payload: {} });
  assert.deepEqual(r, { isNew: false, processed: true });

  const { client: c2 } = fake(() => ok(null));
  assert.deepEqual(await supabaseStore(c2).recordVendorEvent({ provider: 'acme', event_id: 'e2', payload: {} }), { isNew: true, processed: false });

  const { client: c3 } = fake(() => ({ data: null, error: { code: '42501', message: 'rls denied' } }));
  await assert.rejects(() => supabaseStore(c3).recordVendorEvent({ provider: 'acme', event_id: 'e3', payload: {} }), /rls denied/);
});

test('errors keep the Postgres code so callers can tell a duplicate from an outage', async () => {
  const { client } = fake(() => ({ data: null, error: { code: '23505', message: 'duplicate key value' } }));
  await assert.rejects(() => supabaseStore(client).insertLoan({}), (e) => e.code === '23505' && /payday\.loan insert/.test(e.message));
});

test('customer upsert is keyed on mobile', async () => {
  const { log, client } = fake(() => ok({ id: 'c1' }));
  await supabaseStore(client).upsertCustomer({ mobile: '9999999991' });
  assert.deepEqual(log[0].ops.find((o) => o[0] === 'upsert'), ['upsert', { mobile: '9999999991' }, { onConflict: 'mobile' }]);
});

test('pending payouts query: status pending and older than the cutoff', async () => {
  const { log, client } = fake(() => ok([{ id: 'd1' }]));
  const rows = await supabaseStore(client).listPendingDisbursements('2026-01-01T00:00:00.000Z');
  assert.deepEqual(rows, [{ id: 'd1' }]);
  assert.deepEqual(log[0].ops.find((o) => o[0] === 'eq'), ['eq', 'status', 'pending']);
  assert.deepEqual(log[0].ops.find((o) => o[0] === 'lt'), ['lt', 'created_at', '2026-01-01T00:00:00.000Z']);
});

test('new control tables: clients, audit, consent, policies, outbox use the right tables and filters', async () => {
  const { log, client } = fake((table) => {
    if (table === 'consent') return ok([{ purpose: 'kyc' }, { purpose: 'kyc' }, { purpose: 'terms' }]);
    if (table === 'rpc:activate_credit_policy') return ok({ id: 'p1', status: 'active' });
    return ok([{ id: 'x' }]);
  });
  const s = supabaseStore(client);
  const op = (i, name) => log[i].ops.find((o) => o[0] === name);

  await s.findApiClientByKeyHash('abc');
  assert.deepEqual([log[0].table, op(0, 'eq')], ['api_client', ['eq', 'key_hash', 'abc']]);

  await s.listApiClients();
  assert.equal(log[1].table, 'api_client');
  assert.equal(String(op(1, 'select')[1]).includes('key_hash'), false, 'listing clients never reads the key hash');

  await s.insertAudit({ action: 'x' });
  assert.deepEqual([log[2].table, op(2, 'insert')[0]], ['audit_log', 'insert']);

  const consents = await s.getActiveConsents('c1');
  assert.deepEqual(consents.map((c) => c.purpose), ['kyc', 'terms'], 'one entry per purpose');
  assert.deepEqual(op(3, 'is'), ['is', 'revoked_at', null]);

  assert.equal(await s.revokeConsent('c1', 'kyc', '2026-01-01T00:00:00Z'), 3, 'reports how many rows the database revoked');
  assert.deepEqual(op(4, 'update')[1], { revoked_at: '2026-01-01T00:00:00Z' });
  assert.deepEqual(log[4].ops.filter((o) => o[0] === 'eq').map((o) => o[2]), ['c1', 'kyc']);
  assert.deepEqual(op(4, 'is'), ['is', 'revoked_at', null], 'only rows not already revoked');

  await s.getActivePolicy();
  assert.deepEqual([log[5].table, op(5, 'eq')], ['credit_policy', ['eq', 'status', 'active']]);
  await s.listPolicies();
  assert.equal(String(op(6, 'select')[1]).includes('config'), false, 'the list does not drag every full policy along');

  const act = await s.activatePolicy('p1', 'ravi');
  assert.deepEqual([log[7].table, op(7, 'rpc')], ['rpc:activate_credit_policy', ['rpc', 'activate_credit_policy', { p_id: 'p1', p_by: 'ravi' }]]);
  assert.equal(act.status, 'active', 'activation goes through the atomic database function');

  await s.listDuePartnerEvents('2026-01-01T00:00:00Z', 10);
  assert.deepEqual(op(8, 'eq'), ['eq', 'status', 'pending']);
  assert.deepEqual(op(8, 'lte'), ['lte', 'next_attempt_at', '2026-01-01T00:00:00Z']);
  assert.deepEqual(op(8, 'limit'), ['limit', 10]);

  await s.getCustomerByMobile('9000000001');
  assert.deepEqual([log[9].table, op(9, 'eq')], ['customer', ['eq', 'mobile', '9000000001']]);
});
