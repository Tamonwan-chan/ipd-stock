/**
 * Code.js — Sheet menu for the admin. Web app routing (doGet) comes later.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('IPD')
    .addItem('ตั้งค่าแท็บข้อมูล', 'setupSheets')
    .addToUi();
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
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}
