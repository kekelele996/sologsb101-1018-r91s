/**
 * 荫房对账：记录仪读数（RoomReading）与管理员出入房时刻（RoomStay）
 * 按「胎体编号 + 日期」配对。
 * - 两侧齐了：认下荫干窗口（matched），越界读数才触发道次待复检 / 打磨退回。
 * - 只有一侧：时段先挂「待确认」（pending），标明缺侧，等对方补齐，暂不回写道次。
 */
import type { ReconcileMissingSide, RoomReading, RoomStay, RoomVerdict } from '@/types/room';

export interface ReconciledWindow {
  /** 对账键：`${bodyId}__${date}` */
  key: string;
  bodyId: string;
  date: string;
  /** 该胎体当天的全部记录仪读数（通常一条，记录仪一天多条时合并判读） */
  readings: RoomReading[];
  /** 管理员手填的当天出入房时刻（每天一条，未补为 null） */
  stay: RoomStay | null;
  /** 已认下 / 待确认 */
  status: 'matched' | 'pending';
  /** 待确认时缺的是哪一侧 */
  missing: ReconcileMissingSide | null;
  /** 当天读数的综合判定（无读数时为 null）；取最不利的一档 */
  verdict: RoomVerdict | null;
  /** 已认下窗口且读数越界（只有认下的窗口才允许触发回写） */
  breached: boolean;
}

export function reconcileKey(bodyId: string, date: string): string {
  return `${bodyId}__${date}`;
}

/** 多笔读数合并判读：偏湿与偏干同时出现时按较不利的偏湿处理，有越界即非适宜 */
export function worstVerdict(readings: ReadonlyArray<Pick<RoomReading, 'verdict'>>): RoomVerdict | null {
  if (readings.length === 0) return null;
  if (readings.some((item) => item.verdict === 'wet')) return 'wet';
  if (readings.some((item) => item.verdict === 'dry')) return 'dry';
  return 'suitable';
}

/** 按胎体编号 + 日期把两侧记录配对成对账窗口，结果按日期倒序、胎体编号排序 */
export function reconcileRoomWindows(readings: RoomReading[], stays: RoomStay[]): ReconciledWindow[] {
  const groups = new Map<string, { bodyId: string; date: string; readings: RoomReading[]; stay: RoomStay | null }>();

  const ensure = (bodyId: string, date: string) => {
    const key = reconcileKey(bodyId, date);
    let group = groups.get(key);
    if (!group) {
      group = { bodyId, date, readings: [], stay: null };
      groups.set(key, group);
    }
    return group;
  };

  readings.forEach((reading) => {
    ensure(reading.bodyId, reading.date).readings.push(reading);
  });
  stays.forEach((stay) => {
    ensure(stay.bodyId, stay.date).stay = stay;
  });

  return [...groups.entries()]
    .map(([key, group]) => {
      const verdict = worstVerdict(group.readings);
      const hasReading = group.readings.length > 0;
      const hasStay = group.stay !== null;
      const status = hasReading && hasStay ? 'matched' : 'pending';
      const missing: ReconcileMissingSide | null =
        status === 'pending' ? (hasReading ? 'stay' : 'reading') : null;
      return {
        key,
        bodyId: group.bodyId,
        date: group.date,
        readings: [...group.readings].sort((a, b) => a.createdAt - b.createdAt),
        stay: group.stay,
        status,
        missing,
        verdict,
        breached: status === 'matched' && verdict !== null && verdict !== 'suitable',
      } satisfies ReconciledWindow;
    })
    .sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.bodyId.localeCompare(b.bodyId),
    );
}

/** 单个胎体的对账窗口（保持日期倒序） */
export function reconcileWindowsOfBody(
  readings: RoomReading[],
  stays: RoomStay[],
  bodyId: string,
): ReconciledWindow[] {
  return reconcileRoomWindows(
    readings.filter((reading) => reading.bodyId === bodyId),
    stays.filter((stay) => stay.bodyId === bodyId),
  );
}

/** 该胎体已认下的越界窗口（触发待复检 / 打磨退回的依据） */
export function breachedWindowsOfBody(
  readings: RoomReading[],
  stays: RoomStay[],
  bodyId: string,
): ReconciledWindow[] {
  return reconcileWindowsOfBody(readings, stays, bodyId).filter((window) => window.breached);
}
