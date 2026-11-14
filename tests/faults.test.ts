import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite.js';
import { Store } from '../src/worker/store.js';
import { snapshot, clean } from './fixtures.js';
import { seal, randomSecret } from '../src/core/crypto.js';

function fault(db: D1Database, target: string, after: boolean): D1Database {
  let armed = true;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(object, key) {
    if (key === 'bind') return (...args: Parameters<D1PreparedStatement['bind']>) => wrap(object.bind(...args), sql);
    if (key === 'run') return async () => {
      const fail = armed && sql.includes(target); if (fail) armed = false;
      if (fail && !after) throw new Error('Injected D1 unavailable before commit');
      const result = await object.run(); if (fail) throw new Error('Injected D1 response lost after commit'); return result;
    };
    const value: unknown = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
  } });
  return new Proxy(db, { get(object, key) { if (key === 'prepare') return (sql: string) => wrap(object.prepare(sql), sql); const value: unknown = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value; } });
}
await test('D1 failures before/after durable receipt and request admission preserve replayability without double admission', async () => {
  for (const after of [false, true]) {
    const { db, sqlite } = database(), store = new Store(db), request = snapshot();
    try {
      await assert.rejects(new Store(fault(db, 'INSERT OR IGNORE INTO deliveries', after)).delivery('event', 'digest', 'ping', '{}'));
      const inserted = await store.delivery('event', 'digest', 'ping', '{}'); assert.equal(inserted, !after); assert.ok(await store.claimDelivery('event'));
      await assert.rejects(new Store(fault(db, 'INSERT OR IGNORE INTO requests', after)).create(request));
      await store.create(request); assert.equal(sqlite.prepare('SELECT count(*) AS total FROM requests').get()!.total, 1);
    } finally { sqlite.close(); }
  }
});
await test('D1 prepare/result response loss admits the same run and exact result while rejecting replacements', async () => {
  for (const after of [false, true]) {
    const { db, sqlite } = database(), store = new Store(db), request = snapshot();
    try {
      await store.create(request);
      await assert.rejects(new Store(fault(db, "SET state='running'", after)).prepare(request.id, '1'));
      assert.equal(await store.prepare(request.id, '1'), true); assert.equal(await store.prepare(request.id, '2'), false);
      await assert.rejects(new Store(fault(db, "SET state='reviewed'", after)).result(request.id, clean(), true, '1'));
      await store.result(request.id, clean(), true, '1'); assert.equal((await store.get(request.id)).row.state, 'reviewed');
      await assert.rejects(store.result(request.id, { ...clean(), complete: false }, false, '1'));
    } finally { sqlite.close(); }
  }
});
await test('D1 rotating-token persistence faults never allow stale or foreign installation overwrites', async () => {
  for (const after of [false, true]) {
    const { db, sqlite } = database(), store = new Store(db), request = snapshot();
    const key = randomSecret(), first = await seal({ refresh_token: 'fixture-old' }, key, 'binding'), next = await seal({ refresh_token: 'fixture-new' }, key, 'binding');
    try {
      await store.saveSession(2, 5, first, 1); await store.acquire(request);
      await assert.rejects(new Store(fault(db, 'SET envelope=?,version=version+1', after)).rotate(request, 1, next));
      assert.equal((await store.session(2, 5, 1))!.version, after ? 2 : 1);
      if (after) await assert.rejects(store.rotate(request, 1, first));
      await assert.rejects(store.rotate({ ...request, installationId: 9 }, 1, first));
      await store.release(request); await store.acquire({ ...request, id: crypto.randomUUID() });
    } finally { sqlite.close(); }
  }
});
await test('D1 publication claim/checkpoint/completion faults recover by lease and cannot reopen successful publication', async () => {
  for (const after of [false, true]) {
    const { db, sqlite } = database(), store = new Store(db), request = snapshot();
    try {
      await store.create(request); await store.prepare(request.id, '1'); await store.result(request.id, clean(), true, '1');
      await assert.rejects(new Store(fault(db, "SET state='publishing'", after)).claimPublication(request.id, '1'));
      sqlite.prepare('UPDATE requests SET publish_until=0').run(); const lease = await store.claimPublication(request.id, '1');
      await assert.rejects(new Store(fault(db, 'SET review_id=?,review_phase=?', after)).checkpoint(request.id, lease, 99, 'pending'));
      await store.checkpoint(request.id, lease, 99, 'submitted', 'not_requested');
      await assert.rejects(new Store(fault(db, "SET state='published'", after)).published(request.id, 99, lease));
      if (!after) await store.published(request.id, 99, lease);
      await store.publicationFailed(request.id, lease, false); assert.equal((await store.get(request.id)).row.state, 'published');
    } finally { sqlite.close(); }
  }
});
