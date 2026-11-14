import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite.js';
import { Store } from '../src/worker/store.js';
import { snapshot, clean } from './fixtures.js';
import { randomSecret, seal } from '../src/core/crypto.js';
await test('delivery id and signed-body digest independently prevent webhook replay', async () => {
  const { db, sqlite } = database(); const store = new Store(db);
  try { assert.equal(await store.delivery('delivery-1', 'hash-1'), true); assert.equal(await store.delivery('delivery-1', 'hash-2'), false); assert.equal(await store.delivery('delivery-2', 'hash-1'), false); }
  finally { sqlite.close(); }
});
await test('request transitions bind exactly one run and preserve publication state', async () => {
  const { db, sqlite } = database(); const store = new Store(db), request = snapshot();
  try {
    await store.create(request); assert.equal(await store.transition(request.id, 'created', 'dispatched'), true);
    const starts = await Promise.all([store.transition(request.id, 'dispatched', 'running', '1'), store.transition(request.id, 'dispatched', 'running', '2')]);
    assert.equal(starts.filter(Boolean).length, 1);
    const admittedRun = starts[0] ? '1' : '2', rejectedRun = starts[0] ? '2' : '1';
    await assert.rejects(store.result(request.id, clean(), true, rejectedRun));
    await store.result(request.id, clean(), true, admittedRun); await store.result(request.id, clean(), true, admittedRun);
    await assert.rejects(store.result(request.id, { ...clean(), summary: 'A different result must not replace the first one.' }, true, admittedRun));
    assert.equal(await store.transition(request.id, 'reviewed', 'publishing', rejectedRun), false);
    await assert.rejects(store.claimPublication(request.id, rejectedRun));
    const lease = await store.claimPublication(request.id, admittedRun); assert.equal((await store.get(request.id)).row.state, 'publishing');
    await assert.rejects(store.published(request.id, 99, 'wrong-owner'));
    await store.published(request.id, 99, lease); assert.equal((await store.get(request.id)).row.review_id, 99);
  } finally { sqlite.close(); }
});
await test('cross-run refresh lock plus version CAS protects rotating tokens', async () => {
  const { db, sqlite } = database(); const store = new Store(db), request = snapshot();
  const initial = await seal({ refresh_token: 'fixture-initial' }, randomSecret(), 'binding');
  try {
    await store.saveSession(request.repositoryId, request.actorId, initial, request.installationId);
    const other = { ...request, id: 'another-request' };
    const acquired = await Promise.allSettled([store.acquire(request), store.acquire(other)]);
    assert.equal(acquired.filter(x => x.status === 'fulfilled').length, 1);
    const owner = acquired[0]!.status === 'fulfilled' ? request : other, rejected = owner === request ? other : request;
    await assert.rejects(store.rotate(rejected, 1, initial));
    await store.rotate(owner, 1, initial); assert.equal((await store.session(request.repositoryId, request.actorId, request.installationId))?.version, 2);
    await assert.rejects(store.rotate(owner, 1, initial));
    await assert.rejects(store.saveSession(request.repositoryId, request.actorId, initial, request.installationId));
    await assert.rejects(store.acquire({ ...request, repositoryId: 99 }));
    assert.equal(await store.session(request.repositoryId, 99, request.installationId), null);
    await store.release(owner); await store.acquire(rejected); await store.release(rejected);
    await store.removeInstallation(request.installationId); assert.equal(await store.session(request.repositoryId, request.actorId, request.installationId), null);
  } finally { sqlite.close(); }
});


await test('cleanup releases only terminal or expired session leases, preserving active other-installation refresh owners', async () => {
  const { db, sqlite } = database(), store = new Store(db), request = snapshot(), other = { ...snapshot(), id: crypto.randomUUID(), installationId: 9 };
  const envelope = await seal({ refresh_token: 'fixture' }, randomSecret(), 'binding');
  try {
    await store.create(request); await store.create(other);
    await store.saveSession(2, 5, envelope, 1); await store.saveSession(2, 5, envelope, 9); await store.acquire(request); await store.acquire(other);
    await store.cleanup(); await assert.rejects(store.acquire({ ...request, id: crypto.randomUUID() }));
    await store.transition(request.id, 'created', 'failed'); await store.cleanup();
    await store.acquire({ ...request, id: crypto.randomUUID() }); await assert.rejects(store.acquire({ ...other, id: crypto.randomUUID() }));
  } finally { sqlite.close(); }
});
