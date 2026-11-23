// One user action owns authentication, catalog discovery and file downloads.
class Synchronizer {
  constructor(tasks) { this.tasks = tasks; this.running = false; this.paused = false; this.stage = 'idle'; }
  async start(showSignIn = false, productId = null) {
    if (this.running) {
      if (this.paused && this.stage === 'files') {
        this.paused = false;
        this.tasks.publish({ busy: true, phase: 'downloading', message: 'Continuing downloads...' });
        await this.tasks.resumeFiles();
      }
      return;
    }
    this.running = true; this.paused = false; this.stage = 'auth';
    this.tasks.log?.('info', 'sync.started', { stage: productId ? 'single-product' : 'library', productId });
    this.tasks.publish({ busy: true, phase: 'connecting', message: 'Connecting to ArtStation...', speed: 0 });
    try {
      await this.tasks.authenticate(() => this.paused, showSignIn);
      if (this.paused) return;
      this.stage = 'catalog';
      const selectedId = productId ? await this.tasks.product(productId) : await this.tasks.catalog();
      if (this.paused) return;
      this.stage = 'files';
      await this.tasks.files(productId ? [selectedId || productId] : null, !!productId);
    } catch (error) {
      this.tasks.log?.(this.paused ? 'info' : 'error', 'sync.stopped', { stage: this.stage, error });
      if (!this.paused) this.tasks.publish({ phase: 'error', message: error.message, speed: 0 });
    } finally {
      this.tasks.log?.('info', 'sync.finished', { state: this.paused ? 'paused' : 'finished' });
      this.running = false; this.stage = 'idle';
      this.tasks.publish({ busy: false, ...(this.paused ? { phase: 'paused', speed: 0, message: 'Paused. Synchronize library to continue.' } : {}) });
    }
  }
  pause() {
    if (!this.running) return;
    this.paused = true;
    this.tasks.pause();
    this.tasks.publish({ phase: this.stage === 'files' ? 'paused' : 'pausing', speed: 0,
      message: this.stage === 'files' ? 'Paused. Synchronize library to continue.' : 'Finishing the current request before pausing...' });
  }
}
module.exports = { Synchronizer };
