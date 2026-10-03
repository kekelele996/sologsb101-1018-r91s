/**
 * 荫房对账：把记录仪温湿度读数（Reading）与管理员入出房记录（Stay）
 * 按「胎体 + 日期」配对。
 * - matched：两边齐，构成认下的荫干窗口；仅落在入出房时段内的读数参与窗口判定
 * - readingOnly：有读数、缺入出房记录，时段先挂着等确认（确认后读数全部计为窗口读数）
 * - stayOnly：有入出房记录、缺读数，挂着等确认
 * 认下窗口内出现越界读数，即 over=true，由 syncEnvToCoats 回写道次。
 */
import type { EnvVerdict, Reading } from '@/types/reading';
import type { Stay } from '@/types/stay';
import { roomStayHours } from './humidity';

export type ReconcileStatus = 'matched' | 'readingOnly' | 'stayOnly';

export interface ReconcileWindow {
  bodyId: string;
  date: string;
  status: ReconcileStatus;
  /** 是否为已认下窗口（两边齐，或单边经人工确认） */
  acknowledged: boolean;
  stay: Stay | null;
  readings: Reading[];
  /** 落在入出房时段内的读数；单边确认时取当天全部读数 */
  windowReadings: Reading[];
  /** 窗口综合判定：取窗口内最不利的读数 */
  verdict: EnvVerdict | null;
  /** 最不利判定对应的代表性读数 id（窗口文案取其温湿度） */
  verdictReadingId: string | null;
  /** 认下窗口内是否出现越界读数 */
  over: boolean;
  stayHours: number;
}

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  matched: '两边齐',
  readingOnly: '缺入出房',
  stayOnly: '缺读数',
};

export const RECONCILE_STATUS_COLOR: Record<ReconcileStatus, string> = {
  matched: '#2f6f4f',
  readingOnly: '#c9963c',
  stayOnly: '#3a6ea5',
};

/** HH:mm → 分钟数 */
function toMinutes(hhmm: string): number | null {
  const parts = hhmm.split(':');
  if (parts.length !== 2) return null;
  const h = Number.parseInt(parts[0] ?? '', 10);
  const m = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** 采样时刻是否落在入出房时段内（支持跨夜） */
export function isWithinStay(sampledAt: string, inAt: string, outAt: string): boolean {
  const sample = toMinutes(sampledAt);
  const start = toMinutes(inAt);
  const end = toMinutes(outAt);
  if (sample === null || start === null || end === null) {
    // 采样时刻缺失（旧记录升级补登）时按落在窗口内处理
    return sampledAt.trim().length === 0;
  }
  if (end >= start) return sample >= start && sample <= end;
  return sample >= start || sample <= end; // 跨夜
}

/** 多条件取最不利判定：wet > dry > suitable */
export function worstVerdict(readings: Reading[]): EnvVerdict | null {
  if (readings.length === 0) return null;
  if (readings.some((row) => row.verdict === 'wet')) return 'wet';
  if (readings.some((row) => row.verdict === 'dry')) return 'dry';
  return 'suitable';
}

/** 最不利判定的代表性读数（越界优先于适宜），用于窗口温湿度文案 */
export function worstReading(readings: Reading[]): Reading | null {
  if (readings.length === 0) return null;
  return (
    readings.find((row) => row.verdict === 'wet') ??
    readings.find((row) => row.verdict === 'dry') ??
    readings.find((row) => row.verdict === 'suitable') ??
    null
  );
}

/**
 * 生成按日期倒序的对账窗口列表。
 */
export function reconcile(readings: Reading[], stays: Stay[]): ReconcileWindow[] {
  const keyOf = (bodyId: string, date: string): string => `${bodyId}__${date}`;
  const readingMap = new Map<string, Reading[]>();
  const stayMap = new Map<string, Stay>();

  readings.forEach((row) => {
    const key = keyOf(row.bodyId, row.date);
    const list = readingMap.get(key) ?? [];
    list.push(row);
    readingMap.set(key, list);
  });
  stays.forEach((stay) => {
    // 管理员每天手填一条；若历史脏数据产生多条，取更新时间最新的一条
    const previous = stayMap.get(keyOf(stay.bodyId, stay.date));
    if (!previous || stay.updatedAt >= previous.updatedAt) {
      stayMap.set(keyOf(stay.bodyId, stay.date), stay);
    }
  });

  const keys = new Set<string>([...readingMap.keys(), ...stayMap.keys()]);
  const windows: ReconcileWindow[] = [];

  keys.forEach((key) => {
    const [bodyId, date] = key.split('__') as [string, string];
    const dayReadings = (readingMap.get(key) ?? []).slice().sort((a, b) =>
      a.sampledAt.localeCompare(b.sampledAt),
    );
    const stay = stayMap.get(key) ?? null;

    let status: ReconcileStatus;
    let acknowledged: boolean;
    let windowReadings: Reading[];

    if (stay) {
      status = dayReadings.length > 0 ? 'matched' : 'stayOnly';
      if (dayReadings.length > 0) {
        acknowledged = true;
        windowReadings = dayReadings.filter((row) => isWithinStay(row.sampledAt, stay.inAt, stay.outAt));
      } else {
        // 缺读数：管理员核实后认下（无读数即无越界，仅用于时长统计）
        acknowledged = stay.confirmed;
        windowReadings = [];
      }
    } else {
      status = 'readingOnly';
      // 缺入出房：值班员核实当天读数后认下，全部读数计为窗口读数
      acknowledged = dayReadings.length > 0 && dayReadings.every((row) => row.confirmed);
      windowReadings = acknowledged ? dayReadings : [];
    }

    const verdict = worstVerdict(windowReadings);
    const verdictReading = worstReading(windowReadings);
    windows.push({
      bodyId,
      date,
      status,
      acknowledged,
      stay,
      readings: dayReadings,
      windowReadings,
      verdict,
      verdictReadingId: verdictReading?.id ?? null,
      over: acknowledged && verdict !== null && verdict !== 'suitable',
      stayHours: stay ? roomStayHours(stay.inAt, stay.outAt) : 0,
    });
  });

  return windows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.bodyId.localeCompare(b.bodyId)));
}

/** 待确认（漏边且未核实）窗口数 */
export function countPending(windows: ReconcileWindow[]): number {
  return windows.filter((window) => !window.acknowledged).length;
}

/** 认下窗口内出现越界的窗口数 */
export function countOverWindows(windows: ReconcileWindow[]): number {
  return windows.filter((window) => window.over).length;
}
