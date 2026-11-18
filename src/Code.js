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
 * Code.js — web app entry (doGet) and the Sheet menu for the admin.
 * Menu and messages are in Thai (read by IPD staff).
 */

function doGet() {
  return HtmlService.createTemplateFromFile('ui/App')
    .evaluate()
    .setTitle('สต็อกยา IPD')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Used by ui/App.html: <?!= include('ui/Styles') ?> */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Show the web app link (Sheet menu). */
function showWebAppLink() {
  var url = ScriptApp.getService().getUrl();
  var ui = SpreadsheetApp.getUi();
  ui.alert('ลิงก์หน้าเว็บ', url || 'ยังไม่ได้ deploy เป็น web app (Deploy › New deployment › Web app)', ui.ButtonSet.OK);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('IPD')
    .addItem('เปิดหน้าเว็บ (ลิงก์)', 'showWebAppLink')
    .addSeparator()
    .addItem('นำเข้าข้อมูลการใช้ยา (จากแท็บ Import)', 'importUsage')
    .addItem('คำนวณยอดที่ควรมีใหม่', 'recomputePar')
    .addSeparator()
    .addItem('ตั้งค่าแท็บข้อมูล', 'setupSheets')
    .addItem('สร้างบัญชีผู้ดูแลระบบ / ตั้งรหัสใหม่', 'createAdmin')
    .addToUi();
}

/**
 * Create an admin login for the web app, or reset an admin's password (Sheet owner only:
 * the menu runs with the owner's access). Other users are managed in the web app.
 */
function createAdmin() {
  var ui = SpreadsheetApp.getUi();
  function ask(title, prompt) {
    var r = ui.prompt(title, prompt, ui.ButtonSet.OK_CANCEL);
    return r.getSelectedButton() === ui.Button.OK ? r.getResponseText().trim() : null;
  }
  var username = ask('บัญชีผู้ดูแลระบบ', 'ชื่อผู้ใช้ (ภาษาอังกฤษหรือตัวเลข ไม่มีช่องว่าง)');
  if (!username) return;
  var name = ask('บัญชีผู้ดูแลระบบ', 'ชื่อที่แสดง (เช่น ชื่อ-นามสกุล)');
  if (name === null) return;
  var pw = ask('บัญชีผู้ดูแลระบบ', 'รหัสผ่าน อย่างน้อย ' + Auth.MIN_PASSWORD + ' ตัวอักษร (จะเห็นตัวอักษรขณะพิมพ์ ระวังคนข้างๆ)');
  if (!pw) return;
  try {
    var r = Db.withLock(function () {
      Db.ensureSchema();
      var res = Auth.saveUser({ username: username, name: name, role: 'admin', active: true, password: pw });
      Api.setActor('เจ้าของชีต (เมนู)');
      Api.log([[res.created ? 'เพิ่มผู้ใช้' : 'แก้ผู้ใช้', res.user.username, res.changes.join('; ')]]);
      return res;
    });
    ui.alert((r.created ? 'สร้างบัญชี ' : 'ปรับบัญชี ') + r.user.username + ' เป็นผู้ดูแลระบบแล้ว เข้าสู่ระบบในหน้าเว็บได้เลย');
  } catch (e) {
    ui.alert('ไม่สำเร็จ: ' + e.message);
  }
}

/** Create or update the database tabs (Db.ensureSchema). Safe to run again. */
function setupSheets() {
  var r = Db.withLock(function () { return Db.ensureSchema(); });
  var lines = [];
  lines.push(r.created.length ? 'สร้างแท็บใหม่: ' + r.created.join(', ') : 'มีแท็บครบแล้ว');
  Object.keys(r.addedColumns).forEach(function (t) {
    lines.push('เพิ่มคอลัมน์ใน ' + t + ': ' + r.addedColumns[t].join(', '));
  });
  if (r.addedSettings.length) lines.push('เพิ่มค่าตั้งต้นใน Settings: ' + r.addedSettings.join(', '));
  if (r.updatedNotes.length) lines.push('ปรับคำอธิบายใน Settings: ' + r.updatedNotes.join(', '));
  if (r.unusedSettings.length) lines.push('ค่าใน Settings ที่โปรแกรมไม่ใช้แล้ว (ลบแถวได้): ' + r.unusedSettings.join(', '));
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

/** Import the HOSxP export pasted into the Import tab, then recompute. */
function importUsage() {
  var ui = SpreadsheetApp.getUi();
  var r = Db.withLock(function () { return Import.importUsage(); });
  if (!r.ok) {
    ui.alert('นำเข้าไม่สำเร็จ ยังไม่มีการบันทึกข้อมูล', r.errors.join('\n'), ui.ButtonSet.OK);
    return;
  }
  var lines = [
    'นำเข้า ' + r.rows + ' แถว วันที่ ' + r.from + ' ถึง ' + r.to,
    'ข้อมูลการใช้ยา: แทนที่ ' + r.usage.removed + ' แถวเดิม เพิ่ม ' + r.usage.added + ' แถว (รวม ' + r.usage.total + ')',
    'ยาใหม่ ' + r.newDrugs.length + ' รายการ' + (r.newDrugs.length ? ': ' + listSome_(r.newDrugs) : ''),
    'ปรับราคาต่อหน่วย ' + r.priceUpdates + ' รายการ',
    ''
  ].concat(recomputeLines_(r.recompute));
  ui.alert('นำเข้าสำเร็จ', lines.join('\n'), ui.ButtonSet.OK);
}

/** Recompute use_freq, source_calc, stocked and par_calc for every drug. */
function recomputePar() {
  var r = Db.withLock(function () { return Import.recompute(); });
  var ui = SpreadsheetApp.getUi();
  ui.alert('คำนวณใหม่แล้ว', recomputeLines_(r).join('\n'), ui.ButtonSet.OK);
}

function recomputeLines_(r) {
  if (!r.to) return ['ยังไม่มีข้อมูลการใช้ยา'];
  var src = r.source;
  var lines = [
    'ใช้ข้อมูลวันที่ ' + r.from + ' ถึง ' + r.to + ' ยา ' + r.drugs + ' รายการ',
    'เบิกจากคลัง (MAIN) ' + (src.MAIN || 0) + ' · ขอจาก OPD ' + (src.OPD || 0),
    'ต้องนับและเบิก (stocked) ' + r.stocked + ' รายการ'
  ];
  if (r.expensive.length) lines.push('ยาราคาสูง ใช้ไม่บ่อย (ตอนนี้ให้ขอจาก OPD) ถ้าจะสต็อก ให้เภสัชใส่ par_override (ยอดสูงสุด) หรือ source = MAIN: ' + listSome_(r.expensive));
  if (r.overridden.length) lines.push('source ที่เภสัชตั้งไว้ต่างจากเกณฑ์ความถี่การใช้: ' + listSome_(r.overridden));
  if (r.none && r.none.length) lines.push('ไม่ต้องเบิก (source = NONE): ' + listSome_(r.none));
  return lines;
}

function listSome_(names) {
  var n = 10;
  return names.slice(0, n).join(', ') + (names.length > n ? ' … (+' + (names.length - n) + ')' : '');
}
