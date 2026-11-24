/*
 * สต็อกยา IPD
 * ลิขสิทธิ์ © 2569 (2026) ภญ.ธมลวรรณ จันทร์แก้ว สงวนลิขสิทธิ์
 * Copyright © 2026 Tamonwan Chankaew. All rights reserved.
 * Designed & Developed by ภญ.ธมลวรรณ จันทร์แก้ว
 * ห้ามคัดลอก ดัดแปลง หรือนำไปใช้โดยไม่ได้รับอนุญาต ดูเงื่อนไขในไฟล์ LICENSE
 * No use, copying or modification without written permission. See LICENSE.
 * Contact: tamonwanchankaew@gmail.com
 * กลุ่มงานเภสัชกรรม โรงพยาบาลสันกำแพง จังหวัดเชียงใหม่
 */
// Tests for src/Auth.js (web app logins) against an in-memory spreadsheet and cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Db = require('../src/Db.js');
const Auth = require('../src/Auth.js');
const { FakeSpreadsheet } = require('./fake-spreadsheet.js');

function fakeDeps() {
  const store = new Map();
  return {
    store,
    cache: {
      get: k => (store.has(k) ? store.get(k) : null),
      put: (k, v) => { store.set(k, String(v)); },
      remove: k => { store.delete(k); },
    },
    digest: s => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
    uuid: () => crypto.randomUUID(),
    now: () => new Date(2026, 10, 18, 9, 30),
  };
}

function setup() {
  const deps = fakeDeps();
  Auth.setDeps(deps);
  const ss = new FakeSpreadsheet();
  Db.ensureSchema(ss);
  Auth.saveUser({ username: 'Boss', name: 'Admin Person', role: 'admin', active: true, password: 'secret1' }, ss);
  return { ss, deps };
}

test('login: right password gives a session; the password itself is never stored', () => {
  const { ss } = setup();
  const r = Auth.login(' boss ', 'secret1', ss);
  assert.deepEqual(r.user, { username: 'boss', name: 'Admin Person', role: 'admin' });
  assert.ok(r.token.length > 30);
  assert.deepEqual(Auth.check(r.token, 'admin', ss), r.user);
  const row = Db.readTable('Users', ss)[0];
  assert.notEqual(row.pw_hash, 'secret1');
  assert.ok(!JSON.stringify(row).includes('secret1'));
  assert.ok(row.last_login);
});

test('login: wrong password, unknown user, and a pause after 5 failures', () => {
  const { ss } = setup();
  assert.throws(() => Auth.login('boss', 'nope', ss), /ไม่ถูกต้อง/);
  assert.throws(() => Auth.login('nobody', 'secret1', ss), /ไม่ถูกต้อง/);
  assert.throws(() => Auth.login('boss', 'x', ss), /ไม่ถูกต้อง$/); // 2nd wrong
  assert.throws(() => Auth.login('boss', 'x', ss), /ผิดได้อีก 2 ครั้ง/);
  assert.throws(() => Auth.login('boss', 'x', ss), /ผิดได้อีก 1 ครั้ง/); // 4th wrong
  assert.throws(() => Auth.login('boss', 'x', ss), /ถูกพักไว้ 10 นาที/); // 5th wrong
  assert.throws(() => Auth.login('boss', 'secret1', ss), /ถูกพักไว้ 10 นาที/); // right password, still paused
  // an admin setting a new password lifts the pause
  Auth.saveUser({ username: 'boss', name: 'Admin Person', role: 'admin', active: true, password: 'secret2' }, ss);
  assert.ok(Auth.login('boss', 'secret2', ss).token);
});

test('login: failures carry a reason for the change log, never the password', () => {
  const { ss } = setup();
  const err = fn => { try { fn(); } catch (e) { return e; } assert.fail('no error'); };
  assert.deepEqual([err(() => Auth.login('boss', 'nope', ss))].map(e => [e.reason, e.who])[0], ['รหัสผ่านไม่ถูกต้อง (ครั้งที่ 1)', 'boss']);
  assert.deepEqual([err(() => Auth.login('secret1', 'x', ss))].map(e => [e.reason, e.who])[0], ['ไม่พบชื่อผู้ใช้', '']);
});

test('login: a password typed with the Thai keyboard is explained and not counted toward the pause', () => {
  const { ss } = setup();
  Auth.saveUser({ username: 'nurse', name: 'Staff One', role: 'staff', active: true, password: '123456' }, ss);
  for (let i = 0; i < 6; i++) assert.throws(() => Auth.login('nurse', 'ๅ/-ภถุ', ss), /ตัวอักษรไทย/); // "123456" in Thai mode
  assert.ok(Auth.login('nurse', '123456', ss).token);
  // new passwords can't contain Thai (set while the keyboard was in Thai mode by mistake)
  assert.throws(() => Auth.saveUser({ username: 'nurse2', role: 'staff', password: 'ๅ/-ภถุ' }, ss), /ตัวอักษรไทย/);
  assert.throws(() => Auth.changePassword('nurse', '123456', 'ๅ/-ภถุ', ss), /ตัวอักษรไทย/);
});

test('login: no users yet tells how to create the first admin', () => {
  Auth.setDeps(fakeDeps());
  const ss = new FakeSpreadsheet();
  Db.ensureSchema(ss);
  assert.throws(() => Auth.login('a', 'b', ss), /เมนู IPD/);
});

test('check: no or unknown token, logout, staff calling an admin function', () => {
  const { ss } = setup();
  assert.throws(() => Auth.check('', null, ss), /^Error: AUTH/);
  assert.throws(() => Auth.check('made-up', null, ss), /^Error: AUTH/);
  Auth.saveUser({ username: 'nurse', name: 'Staff One', role: 'staff', active: true, password: 'abcdef' }, ss);
  const t = Auth.login('nurse', 'abcdef', ss).token;
  assert.equal(Auth.check(t, null, ss).role, 'staff');
  assert.throws(() => Auth.check(t, 'admin', ss), /เฉพาะผู้ดูแลระบบ/);
  Auth.logout(t);
  assert.throws(() => Auth.check(t, null, ss), /AUTH/);
});

test('saveUser: deactivating ends sessions at once; password rules; last admin is kept', () => {
  const { ss } = setup();
  Auth.saveUser({ username: 'nurse', name: 'Staff One', role: 'staff', active: true, password: 'abcdef' }, ss);
  const t = Auth.login('nurse', 'abcdef', ss).token;
  const r = Auth.saveUser({ username: 'nurse', name: 'Staff One', role: 'staff', active: false }, ss);
  assert.deepEqual(r.changes, ['ปิดใช้งาน']);
  assert.throws(() => Auth.check(t, null, ss), /AUTH/);
  assert.throws(() => Auth.login('nurse', 'abcdef', ss), /ไม่ถูกต้อง/);
  assert.throws(() => Auth.saveUser({ username: 'new1', name: '', role: 'staff', active: true, password: '123' }, ss), /อย่างน้อย 6/);
  assert.throws(() => Auth.saveUser({ username: 'has space', role: 'staff', password: 'abcdef' }, ss), /ไม่มีช่องว่าง/);
  assert.throws(() => Auth.saveUser({ username: 'boss', name: 'Admin Person', role: 'staff', active: true }, ss), /อย่างน้อย 1 คน/);
  // a blank password keeps the old one; a new one replaces it
  Auth.saveUser({ username: 'nurse', name: 'Staff 1', role: 'staff', active: true }, ss);
  assert.equal(Auth.login('nurse', 'abcdef', ss).user.name, 'Staff 1');
  Auth.saveUser({ username: 'nurse', name: 'Staff 1', role: 'staff', active: true, password: 'newpass' }, ss);
  assert.throws(() => Auth.login('nurse', 'abcdef', ss), /ไม่ถูกต้อง/);
  assert.equal(Auth.listUsers(ss).length, 2);
  assert.ok(!('pw_hash' in Auth.listUsers(ss)[0]));
});

test('changePassword: needs the old password', () => {
  const { ss } = setup();
  assert.throws(() => Auth.changePassword('boss', 'wrong', 'another1', ss), /รหัสผ่านเดิม/);
  Auth.changePassword('boss', 'secret1', 'another1', ss);
  assert.ok(Auth.login('boss', 'another1', ss).token);
});
