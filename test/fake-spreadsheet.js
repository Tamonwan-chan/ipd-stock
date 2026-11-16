// In-memory stand-in for the part of SpreadsheetApp that src/Db.js uses.
// Like Google Sheets, a 'YYYY-MM-DD' string written to a cell that isn't formatted as
// plain text ('@') turns into a Date, so tests catch columns that lose their text format.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error(`bad range ${row},${col},${numRows},${numCols}`);
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.grid[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v instanceof Date ? new Date(v) : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows || values.some(r => r.length !== this.numCols)) {
      throw new Error(`setValues: ${values.length}x${values[0] && values[0].length} into ${this.numRows}x${this.numCols}`);
    }
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.set(this.row + r, this.col + c, '');
    return this;
  }
  setNumberFormat(fmt) {
    for (let c = 0; c < this.numCols; c++) this.sheet.formats[this.col + c] = fmt;
    return this;
  }
}

class FakeSheet {
  constructor(name) { this.name = name; this.grid = []; this.formats = {}; this.frozenRows = 0; }
  getName() { return this.name; }
  set(row, col, v) {
    if (typeof v === 'string' && this.formats[col] !== '@' && row > 1) {
      const m = ISO.exec(v);
      if (m) v = new Date(+m[1], +m[2] - 1, +m[3]);
    }
    while (this.grid.length < row) this.grid.push([]);
    this.grid[row - 1][col - 1] = v;
  }
  getLastRow() {
    for (let r = this.grid.length; r > 0; r--) if (this.grid[r - 1].some(v => v !== '' && v !== undefined)) return r;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.grid.forEach(row => row.forEach((v, c) => { if (v !== '' && v !== undefined && c + 1 > max) max = c + 1; }));
    return max;
  }
  getMaxRows() { return Math.max(1000, this.grid.length); }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  setFrozenRows(n) { this.frozenRows = n; }
  /** Test helper: the sheet's contents as plain arrays, trimmed to the used area. */
  dump() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)).getValues(); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`sheet exists: ${name}`);
    const s = new FakeSheet(name);
    this.sheets.push(s);
    return s;
  }
  getSheets() { return this.sheets.slice(); }
}

module.exports = { FakeSpreadsheet, FakeSheet };
