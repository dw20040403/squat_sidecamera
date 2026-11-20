// MediaRecorderで録画する（SafariはMP4。対応していなければWebM）
import { nowMs } from '../util/clock';

export function pickMimeType(): string {
  const cands = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const c of cands)
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

export class VideoRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** 録画開始時刻（自分の時計） */
  startedAtLocal = 0;
  mimeType = '';

  get recording(): boolean {
    return !!this.rec && this.rec.state === 'recording';
  }

  start(stream: MediaStream, bitsPerSecond = 6_000_000): void {
    if (this.recording) return;
    const mimeType = pickMimeType();
    this.rec = new MediaRecorder(
      stream,
      mimeType ? { mimeType, videoBitsPerSecond: bitsPerSecond } : undefined,
    );
    this.mimeType = this.rec.mimeType || mimeType || 'video/mp4';
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(1000);
    this.startedAtLocal = nowMs();
  }

  stop(): Promise<Blob | null> {
    const rec = this.rec;
    if (!rec) return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.chunks = [];
        this.rec = null;
        resolve(blob.size ? blob : null);
      };
      if (rec.state !== 'inactive') rec.stop();
      else rec.onstop?.(new Event('stop'));
    });
  }
}
