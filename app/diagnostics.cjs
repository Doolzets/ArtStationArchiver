const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function redact(value) {
  return String(value ?? '')
    .replace(/(?:https?|file):\/\/[^\s"'<>]+/gi, '[URL removed]')
    .replace(/\b(?:authorization|cookie|set-cookie)\b["']?\s*[:=][^\r\n]*/gi, '[credentials removed]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [removed]')
    .replace(/\b(?:[\w-]*token|password|secret|signature|x-amz-credential|x-amz-signature)\b["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi, '[secret removed]')
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[local path removed]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 1800);
}
class Diagnostics {
  constructor(directory, version, maxBytes = 1024 * 1024) {
    this.directory = path.resolve(directory); this.version = version; this.maxBytes = maxBytes;
    this.session = randomUUID(); this.pending = Promise.resolve(); this.lastError = null;
  }
  file(index = 0) { return path.join(this.directory, index ? `diagnostics.${index}.log` : 'diagnostics.log'); }
  write(level, event, fields = {}) {
    const record = { time: new Date().toISOString(), version: this.version, session: this.session, level, event };
    for (const key of ['stage', 'product', 'productId', 'file', 'fileId', 'release', 'code', 'message', 'state', 'mime', 'received', 'total', 'products', 'files', 'failedFiles', 'failedProducts', 'modalTitle', 'license', 'fileRows', 'expectedFiles', 'downloadButtons', 'filesReady', 'attempt', 'displayedCount']) {
      if (fields[key] != null) record[key] = ['number', 'boolean'].includes(typeof fields[key]) ? fields[key] : redact(fields[key]);
    }
    if (fields.error) { record.message = redact(fields.error.message || fields.error); if (fields.error.code) record.code = redact(fields.error.code); }
    const line = JSON.stringify(record) + '\n';
    this.pending = this.pending.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const size = await fs.stat(this.file()).then(stat => stat.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await fs.rm(this.file(2), { force: true });
        for (const [from, to] of [[1, 2], [0, 1]]) {
          try { await fs.rename(this.file(from), this.file(to)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      await fs.appendFile(this.file(), line, 'utf8'); this.lastError = null;
    }).catch(error => { this.lastError = error; });
    return this.pending;
  }
  async flush() { await this.pending; if (this.lastError) throw new Error('Could not write the diagnostic log: ' + redact(this.lastError.message)); }
  async clear() {
    this.pending = this.pending.then(async () => {
      for (const index of [0, 1, 2]) await fs.rm(this.file(index), { force: true });
      this.lastError = null;
    });
    try { await this.pending; } catch (error) { this.pending = Promise.resolve(); throw error; }
  }
}
module.exports = { Diagnostics, redact };
