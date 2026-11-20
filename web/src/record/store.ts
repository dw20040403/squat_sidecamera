// IndexedDBへの保存（spec 5.8）。フレームはまとめて書き込み、映像はBlobで保存する
import type { AbortInfo, Session, SessionFrame } from './session';

const DB_NAME = 'squat';
const DB_VERSION = 1;

export interface SessionMeta {
  id: string;
  startedAt: number;
  endedAt: number | null;
  aborted: AbortInfo | null;
  frameCount: number;
  hasVideo: boolean;
  source: Session['source'];
  subjectId?: string;
  trialLabel?: string;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = factory.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('headers')) db.createObjectStore('headers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('frames'))
          db.createObjectStore('frames', { keyPath: ['id', 'chunk'] });
        if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

/** 測定中のセッションを少しずつ書き込む */
export class SessionWriter {
  private buffer: SessionFrame[] = [];
  private chunk = 0;
  private count = 0;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private db: IDBDatabase,
    readonly header: Omit<Session, 'frames'>,
    private flushCount: number,
  ) {}

  static async begin(header: Omit<Session, 'frames'>, flushCount = 50): Promise<SessionWriter> {
    const db = await openDb();
    const w = new SessionWriter(db, header, flushCount);
    const tx = db.transaction(['sessions', 'headers'], 'readwrite');
    tx.objectStore('headers').put(header);
    tx.objectStore('sessions').put(w.meta(false));
    await done(tx);
    return w;
  }

  private meta(hasVideo: boolean): SessionMeta {
    return {
      id: this.header.id,
      startedAt: this.header.startedAt,
      endedAt: this.header.endedAt,
      aborted: this.header.aborted,
      frameCount: this.count,
      hasVideo,
      source: this.header.source,
      subjectId: this.header.subject?.id,
      trialLabel: this.header.trial?.label,
    };
  }

  add(f: SessionFrame): void {
    this.buffer.push(f);
    this.count++;
    if (this.buffer.length >= this.flushCount) this.flush();
  }

  flush(): Promise<void> {
    if (!this.buffer.length) return this.writing;
    const frames = this.buffer;
    this.buffer = [];
    const chunk = this.chunk++;
    this.writing = this.writing.then(async () => {
      const tx = this.db.transaction(['frames', 'sessions'], 'readwrite');
      tx.objectStore('frames').put({ id: this.header.id, chunk, frames });
      tx.objectStore('sessions').put(this.meta(false));
      await done(tx);
    });
    return this.writing;
  }

  get frameCount(): number {
    return this.count;
  }

  /** 終了する。映像があれば一緒に保存する */
  async finish(
    endedAt: number,
    aborted: AbortInfo | null,
    video: Blob | null,
    extra: Partial<Session> = {},
  ): Promise<void> {
    await this.flush();
    Object.assign(this.header, extra, { endedAt, aborted });
    const tx = this.db.transaction(['sessions', 'headers', 'videos'], 'readwrite');
    tx.objectStore('headers').put(this.header);
    if (video) tx.objectStore('videos').put({ id: this.header.id, blob: video, mimeType: video.type });
    tx.objectStore('sessions').put(this.meta(!!video));
    await done(tx);
  }
}

export async function listSessions(): Promise<SessionMeta[]> {
  const db = await openDb();
  const all = await req(
    db.transaction('sessions').objectStore('sessions').getAll() as IDBRequest<SessionMeta[]>,
  );
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function loadSession(id: string): Promise<Session | null> {
  const db = await openDb();
  const tx = db.transaction(['headers', 'frames'], 'readonly');
  const header = await req(
    tx.objectStore('headers').get(id) as IDBRequest<Omit<Session, 'frames'> | undefined>,
  );
  if (!header) return null;
  const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  const chunks = await req(
    tx.objectStore('frames').getAll(range) as IDBRequest<{ chunk: number; frames: SessionFrame[] }[]>,
  );
  chunks.sort((a, b) => a.chunk - b.chunk);
  return { ...header, frames: chunks.flatMap((c) => c.frames) } as Session;
}

export async function loadVideo(id: string): Promise<Blob | null> {
  const db = await openDb();
  const r = await req(
    db.transaction('videos').objectStore('videos').get(id) as IDBRequest<{ blob: Blob } | undefined>,
  );
  return r?.blob ?? null;
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'headers', 'frames', 'videos'], 'readwrite');
  tx.objectStore('sessions').delete(id);
  tx.objectStore('headers').delete(id);
  tx.objectStore('videos').delete(id);
  tx.objectStore('frames').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  await done(tx);
}

/** オフライン処理の結果などを丸ごと保存する */
export async function saveSession(s: Session, video: Blob | null = null): Promise<void> {
  const { frames, ...header } = s;
  const w = await SessionWriter.begin(header, 500);
  for (const f of frames) w.add(f);
  await w.finish(s.endedAt ?? (frames.length ? frames[frames.length - 1].t : s.startedAt), s.aborted, video);
}

/** 保存容量の確認と、自動削除されにくくする要求 */
export async function storageStatus(): Promise<{
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}> {
  const st = navigator.storage;
  if (!st) return { usage: null, quota: null, persisted: null };
  const est = st.estimate ? await st.estimate().catch(() => null) : null;
  let persisted: boolean | null;
  try {
    persisted = st.persisted ? await st.persisted() : null;
    if (persisted === false && st.persist) persisted = await st.persist();
  } catch {
    persisted = null;
  }
  return { usage: est?.usage ?? null, quota: est?.quota ?? null, persisted };
}
