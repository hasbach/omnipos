// New-online-order notifications (003 Slice 2, research R21): which socket events notify, and the per-register mute,
// which silences the tone only (quickstart-s2 §4.2: a muted register still shows the toast).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_MUTE_KEY, readOrderMute, writeOrderMute, orderNotification } from '../src/lib/orderNotifications';

test('new submitted orders toast for users who may view orders; mute silences only the tone', () => {
  const e = { type: 'ORDERS_UPDATED', newSubmitted: 2, changed: 1 };
  assert.deepEqual(orderNotification(e, true, false), { toast: true, tone: true, count: 2 });
  assert.deepEqual(orderNotification(e, true, true), { toast: true, tone: false, count: 2 });
  assert.equal(orderNotification(e, false, false).toast, false, 'no orders.view');
  const bad = [null, {}, { type: 'OTHER', newSubmitted: 1 },
    ...[0, -1, NaN, Infinity, '2', undefined].map((newSubmitted) => ({ type: 'ORDERS_UPDATED', newSubmitted }))];
  for (const value of bad) assert.equal(orderNotification(value, true, false).toast, false, JSON.stringify(value));
});

test('mute flag: exact "1", round trips', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  assert.equal(readOrderMute(storage), false);
  assert.equal(writeOrderMute(storage, true), true);
  assert.equal(values.get(ORDER_MUTE_KEY), '1');
  assert.equal(readOrderMute(storage), true);
  writeOrderMute(storage, false);
  assert.equal(readOrderMute(storage), false);
  for (const value of ['true', 'yes', '', '01']) {
    values.set(ORDER_MUTE_KEY, value);
    assert.equal(readOrderMute(storage), false, value);
  }
});

test('unavailable storage does not throw', () => {
  assert.equal(readOrderMute({ getItem() { throw new Error('blocked'); } }), false);
  assert.equal(writeOrderMute({ setItem() { throw new Error('blocked'); } }, true), false);
});
