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
/**
 * Auth.js — the web app's own logins (DESIGN §7).
 *
 * Staff sign in with a username and password kept in the Users tab (salted, hashed; never
 * the password itself). A login returns a random session token that the page sends with
 * every call; sessions live in the script cache for SESSION_SECONDS after the last call.
 * The web app runs as the owner, so the Sheet itself stays private.
 *
 * Roles: 'staff' (all the work) and 'admin' (also user management and the change log).
 *
 * Apps Script services (CacheService, Utilities) are reached through deps_(), which tests
 * replace with setDeps(), so this file also loads in Node.
 */
var Auth = (function () {
  'use strict';

  var ROLES = ['staff', 'admin'];
  var SESSION_SECONDS = 6 * 60 * 60;   // the script cache's maximum
  var MAX_FAILS = 5;                   // wrong passwords in a row before a pause
  var LOCK_SECONDS = 10 * 60;
  var ITERATIONS = 300;
  var MIN_PASSWORD = 6;

  function db_() { return typeof Db !== 'undefined' ? Db : require('./Db.js'); }

  var deps = null;
  /** Tests: {cache:{get,put,remove}, digest:function(string):hex, uuid:function():string, now:function():Date} */
  function setDeps(d) { deps = d; }
  function deps_() {
    if (deps) return deps;
    return {
      cache: CacheService.getScriptCache(),
      digest: function (s) {
        return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
          .map(function (b) { var h = (b & 0xff).toString(16); return h.length < 2 ? '0' + h : h; }).join('');
      },
      uuid: function () { return Utilities.getUuid(); },
      now: function () { return new Date(); }
    };
  }

  function normName(u) { return String(u === null || u === undefined ? '' : u).trim().toLowerCase(); }

  function hash(password, salt) {
    var dg = deps_().digest;
    var h = dg(salt + '\u0001' + password);
    for (var i = 1; i < ITERATIONS; i++) h = dg(h + salt);
    return h;
  }

  function newSalt() { return deps_().uuid().replace(/-/g, ''); }

  function users_(ss) {
    try {
      return db_().readTable('Users', ss).filter(function (u) { return normName(u.username); });
    } catch (e) {
      if (/not found/.test(e.message)) return [];
      throw e;
    }
  }
  function find_(username, ss) {
    var n = normName(username);
    return users_(ss).filter(function (u) { return normName(u.username) === n; })[0] || null;
  }
  function publicUser(u) {
    return { username: normName(u.username), name: String(u.name || '').trim() || normName(u.username),
      role: u.role === 'admin' ? 'admin' : 'staff', active: !!u.active, last_login: u.last_login || '' };
  }

  function checkPassword_(pw) {
    if (String(pw || '').length < MIN_PASSWORD) throw new Error('รหัสผ่านต้องยาวอย่างน้อย ' + MIN_PASSWORD + ' ตัวอักษร');
    if (THAI.test(String(pw))) throw new Error('รหัสผ่านมีตัวอักษรไทย ใช้ได้เฉพาะภาษาอังกฤษ ตัวเลข และเครื่องหมาย (แป้นพิมพ์อาจเป็นภาษาไทยอยู่)');
  }
  function checkUsername_(n) {
    if (!/^[^\s]{2,30}$/.test(n)) throw new Error('ชื่อผู้ใช้ 2–30 ตัวอักษร ไม่มีช่องว่าง');
  }

  /**
   * Sign in. Returns a session token and the user.
   * @return {{token:string, user:{username,name,role}}}
   */
  // Thai letters and digits. A password typed while the keyboard is in Thai mode comes out in
  // Thai ("123456" → "ๅ/-ภถุ"); the login field hides it, so staff can't see why it fails.
  var THAI = /[฀-๿]/;

  /** A failed login: `reason` (Thai) and `who` (a real username, or '') go to the change log. */
  function failure_(message, reason, who) {
    var e = new Error(message);
    e.reason = reason;
    e.who = who || '';
    return e;
  }

  function login(username, password, ss) {
    var dp = deps_(), D = db_();
    var n = normName(username);
    var pw = String(password === null || password === undefined ? '' : password);
    var failKey = 'fail:' + n;
    var fails = +(dp.cache.get(failKey) || 0);
    if (!users_(ss).length) throw new Error('ยังไม่มีผู้ใช้ในระบบ ผู้ดูแลระบบสร้างบัญชีแรกจากเมนู IPD ในชีต');
    var u = n ? find_(n, ss) : null;
    var who = u ? normName(u.username) : '';
    if (fails >= MAX_FAILS) {
      throw failure_('ใส่รหัสผิด ' + MAX_FAILS + ' ครั้งติดกัน ชื่อผู้ใช้นี้ถูกพักไว้ 10 นาที รอแล้วลองใหม่ หรือให้ผู้ดูแลระบบตั้งรหัสผ่านใหม่',
        'ถูกพัก 10 นาที (ใส่รหัสผิด ' + MAX_FAILS + ' ครั้ง)', who);
    }
    if (!u || !u.active || !u.pw_hash || hash(pw, u.pw_salt) !== u.pw_hash) {
      // Thai keyboard: say so, and don't count it toward the pause.
      if (THAI.test(pw)) {
        throw failure_('รหัสผ่านที่พิมพ์เป็นตัวอักษรไทย แป้นพิมพ์น่าจะเป็นภาษาไทยอยู่ ' +
          'เปลี่ยนเป็นภาษาอังกฤษ (กดปุ่ม ~ หรือ Alt+Shift) แล้วพิมพ์รหัสผ่านใหม่', 'พิมพ์รหัสผ่านขณะแป้นพิมพ์เป็นภาษาไทย', who);
      }
      dp.cache.put(failKey, String(fails + 1), LOCK_SECONDS);
      var left = MAX_FAILS - fails - 1;
      throw failure_('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' +
        (left <= 2 ? (left > 0 ? ' (ผิดได้อีก ' + left + ' ครั้ง แล้วจะถูกพัก 10 นาที)' : ' ชื่อผู้ใช้นี้ถูกพักไว้ 10 นาที') : ''),
        !u ? 'ไม่พบชื่อผู้ใช้' : !u.active ? 'บัญชีปิดใช้งาน' : 'รหัสผ่านไม่ถูกต้อง (ครั้งที่ ' + (fails + 1) + ')', who);
    }
    dp.cache.remove(failKey);
    var token = dp.uuid() + dp.uuid();
    var pu = publicUser(u);
    dp.cache.put('sess:' + token, pu.username, SESSION_SECONDS);
    D.updateFields('Users', [{ _row: u._row, last_login: D.fromCell(dp.now(), 'datetime') }], ['last_login'], ss);
    return { token: token, user: { username: pu.username, name: pu.name, role: pu.role } };
  }

  function logout(token) {
    if (token) deps_().cache.remove('sess:' + token);
  }

  /**
   * The signed-in user for a token, or an error starting with 'AUTH:' (the page then shows
   * the login screen). Reads the Users row each time, so a deactivated user or a changed
   * role takes effect at once. `role` 'admin' limits the call to admins.
   */
  function check(token, role, ss) {
    var dp = deps_();
    var name = token ? dp.cache.get('sess:' + token) : null;
    var u = name ? find_(name, ss) : null;
    if (!u || !u.active) throw new Error('AUTH: กรุณาเข้าสู่ระบบ');
    dp.cache.put('sess:' + token, normName(u.username), SESSION_SECONDS); // sliding expiry
    var pu = publicUser(u);
    if (role === 'admin' && pu.role !== 'admin') throw new Error('เฉพาะผู้ดูแลระบบ');
    return { username: pu.username, name: pu.name, role: pu.role };
  }

  function listUsers(ss) {
    return users_(ss).map(publicUser).sort(function (a, b) { return a.username < b.username ? -1 : 1; });
  }

  function activeAdmins_(list) {
    return list.filter(function (u) { return u.active && u.role === 'admin'; }).length;
  }

  /**
   * Create or update a user (admin). `password` is required for a new user and optional
   * otherwise (blank = keep). The last active admin can't be demoted or deactivated.
   * @param {{username:string, name:string, role:string, active:boolean, password?:string}} u
   * @return {{user:Object, created:boolean, changes:string[]}}
   */
  function saveUser(u, ss) {
    var D = db_(), dp = deps_();
    D.ensureColumns('Users', ss);
    var n = normName(u.username);
    checkUsername_(n);
    var role = u.role === 'admin' ? 'admin' : 'staff';
    if (ROLES.indexOf(u.role) < 0) throw new Error('ไม่รู้จักสิทธิ์ ' + u.role);
    var active = u.active !== false;
    var name = String(u.name || '').trim();
    var pw = String(u.password || '');
    var old = find_(n, ss);
    var changes = [];
    if (!old) {
      checkPassword_(pw);
      var salt = newSalt();
      D.appendRows('Users', [{ username: n, name: name, role: role, active: active, pw_salt: salt, pw_hash: hash(pw, salt),
        created_at: D.fromCell(dp.now(), 'datetime') }], ss);
      return { user: publicUser({ username: n, name: name, role: role, active: active }), created: true, changes: ['สร้างผู้ใช้ สิทธิ์ ' + role] };
    }
    var before = publicUser(old);
    var after = { username: n, name: name, role: role, active: active };
    var others = listUsers(ss).filter(function (x) { return x.username !== n; });
    if ((!active || role !== 'admin') && before.active && before.role === 'admin' && activeAdmins_(others) === 0) {
      throw new Error('ต้องมีผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน');
    }
    var fields = ['name', 'role', 'active'];
    if (name !== String(old.name || '').trim()) changes.push('ชื่อ ' + (old.name || '-') + ' → ' + name);
    if (role !== before.role) changes.push('สิทธิ์ ' + before.role + ' → ' + role);
    if (active !== before.active) changes.push(active ? 'เปิดใช้งาน' : 'ปิดใช้งาน');
    var row = { _row: old._row, name: name, role: role, active: active };
    if (pw) {
      checkPassword_(pw);
      row.pw_salt = newSalt();
      row.pw_hash = hash(pw, row.pw_salt);
      fields.push('pw_salt', 'pw_hash');
      changes.push('ตั้งรหัสผ่านใหม่');
      dp.cache.remove('fail:' + n); // a new password also lifts a pause after wrong passwords
    }
    D.updateFields('Users', [row], fields, ss);
    return { user: publicUser(after), created: false, changes: changes };
  }

  /** A user changes their own password. */
  function changePassword(username, oldPw, newPw, ss) {
    var D = db_();
    var u = find_(username, ss);
    if (!u || hash(String(oldPw || ''), u.pw_salt) !== u.pw_hash) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
    checkPassword_(newPw);
    var salt = newSalt();
    D.updateFields('Users', [{ _row: u._row, pw_salt: salt, pw_hash: hash(String(newPw), salt) }], ['pw_salt', 'pw_hash'], ss);
    deps_().cache.remove('fail:' + normName(u.username));
  }

  return {
    ROLES: ROLES, MIN_PASSWORD: MIN_PASSWORD,
    setDeps: setDeps, hash: hash, normName: normName,
    login: login, logout: logout, check: check,
    listUsers: listUsers, saveUser: saveUser, changePassword: changePassword
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Auth;
