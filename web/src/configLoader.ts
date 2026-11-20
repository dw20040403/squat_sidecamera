// 設定ファイルの読み込み（サーバーの /config/ から）
import type { BoardConfig, LayoutConfig, Params } from './params';
import type { Intrinsics } from './fusion/camera';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} を読み込めませんでした（${res.status}）`);
  return (await res.json()) as T;
}

export interface AppConfig {
  params: Params;
  layout: LayoutConfig;
  board: BoardConfig;
}

export async function loadConfig(): Promise<AppConfig> {
  const [params, layout, board] = await Promise.all([
    getJson<Params>('/config/params.json'),
    getJson<LayoutConfig>('/config/layout.json'),
    getJson<BoardConfig>('/config/board.json'),
  ]);
  return { params, layout, board };
}

export interface IntrinsicsListItem {
  file: string;
  deviceName: string;
  imageSize?: [number, number];
  approximate?: boolean;
  rms?: number;
}

export async function listIntrinsics(): Promise<IntrinsicsListItem[]> {
  try {
    return await getJson<IntrinsicsListItem[]>('/api/intrinsics');
  } catch {
    return [];
  }
}

export async function loadIntrinsics(deviceName: string): Promise<Intrinsics | null> {
  const list = await listIntrinsics();
  const item = list.find((x) => x.deviceName === deviceName);
  const file = item ? item.file : `${deviceName}.json`;
  try {
    return await getJson<Intrinsics>(`/config/intrinsics/${encodeURIComponent(file)}`);
  } catch {
    return null;
  }
}
