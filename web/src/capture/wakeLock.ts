// Screen Wake Lock（測定中に画面がスリープしないように）
export class WakeLock {
  private lock: { release(): Promise<void> } | null = null;
  private wanted = false;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') void this.acquire();
    });
  }

  async acquire(): Promise<boolean> {
    this.wanted = true;
    const wl = (
      navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }
    ).wakeLock;
    if (!wl) return false;
    try {
      this.lock = await wl.request('screen');
      return true;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    try {
      await this.lock?.release();
    } catch {
      /* noop */
    }
    this.lock = null;
  }
}
