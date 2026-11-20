// 将来の拡張に向けた口（spec 5.11）。本版では中身を実装しない
import type { Angles } from '../metrics/angles';
import type { FusedFrame } from '../fusion/fuser';

export interface FeedbackMessage {
  text: string;
  priority?: number;
}

/** 毎フレームの指標を受け取り、発話するメッセージを返す */
export interface FeedbackEngine {
  readonly name: string;
  reset(): void;
  update(t: number, angles: Angles, fused: FusedFrame): FeedbackMessage[];
}

/** 何もしない仮の実装 */
export class NullFeedbackEngine implements FeedbackEngine {
  readonly name = 'null';
  reset(): void {}
  update(): FeedbackMessage[] {
    return [];
  }
}

/** Web Speech API（speechSynthesis）のラッパー。出力はBluetoothイヤホンを想定する */
export class Speaker {
  private unlocked = false;

  get available(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  /** iOSの制限に対応するため、「測定開始」のタップ時に無音の発話で音声を有効化しておく */
  unlock(): void {
    if (!this.available || this.unlocked) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
      this.unlocked = true;
    } catch {
      /* noop */
    }
  }

  speak(text: string, lang = 'ja-JP'): void {
    if (!this.available) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    speechSynthesis.speak(u);
  }

  cancel(): void {
    if (this.available) speechSynthesis.cancel();
  }
}
