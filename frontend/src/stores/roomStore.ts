/**
 * 荫房记录状态管理（Zustand）
 * 两份数据分开维护：
 * - readings：值班员记录仪读数，温湿度认记录仪；读取失败按有限次数重试，失败也不清空已有数据。
 * - stays：工序管理员手填的出入房时刻，入房出房时刻认管理员，每个胎体每天一条。
 * 两侧按胎体编号 + 日期对账；只有认下（matched）的越界窗口才回写关联道次：
 * 未做完的道次挂待复检、打磨退回。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import { readWithRetry } from '@/utils/retry';
import { judgeVerdict } from '@/utils/humidity';
import {
  reconcileRoomWindows,
  reconcileWindowsOfBody,
  type ReconciledWindow,
} from '@/utils/reconcile';
import type { RoomReading, RoomReadingDraft, RoomStay, RoomStayDraft, RoomVerdict } from '@/types/room';
import { useCoatStore } from './coatStore';

interface RoomStoreState {
  /** 记录仪读数 */
  readings: RoomReading[];
  /** 管理员出入房时刻 */
  stays: RoomStay[];
  readingsLoading: boolean;
  staysLoading: boolean;
  ready: boolean;
  /** 记录仪读数读取错误（值班员可点重试）；为空表示正常 */
  readingsError: string;
  /** 管理员时刻读取错误 */
  staysError: string;
  /** 同时载入两份（读数走重试，失败互不影响） */
  loadRooms: () => Promise<void>;
  /** 值班员重试读取记录仪读数 */
  retryLoadReadings: () => Promise<boolean>;
  loadStays: () => Promise<void>;
  readingsOfBody: (bodyId: string) => RoomReading[];
  staysOfBody: (bodyId: string) => RoomStay[];
  /** 全部对账窗口 */
  windows: () => ReconciledWindow[];
  windowsOfBody: (bodyId: string) => ReconciledWindow[];
  pendingCount: () => number;
  /** 已认下窗口的越界条数（待确认时段不计） */
  breachedCount: () => number;
  verdictCount: () => Record<RoomVerdict, number>;
  createReading: (draft: RoomReadingDraft) => Promise<RoomReading>;
  updateReading: (id: string, patch: Partial<RoomReadingDraft>) => Promise<void>;
  removeReading: (id: string) => Promise<void>;
  /** 管理员保存出入房时刻：同胎体同日期只保留一条（更新而非新增） */
  upsertStay: (draft: RoomStayDraft, existingId?: string) => Promise<RoomStay>;
  removeStay: (id: string) => Promise<void>;
  /** 两侧任一变化后，按对账结果回写该胎体道次 */
  recalcBodyBreach: (bodyId: string) => Promise<void>;
}

const byDateDesc = <T extends { date: string }>(list: T[]): T[] =>
  [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

export const useRoomStore = create<RoomStoreState>((set, get) => ({
  readings: [],
  stays: [],
  readingsLoading: false,
  staysLoading: false,
  ready: false,
  readingsError: '',
  staysError: '',

  async loadRooms() {
    set({ readingsLoading: true, staysLoading: true });
    // 两侧独立读取：记录仪读数读不出时重试，且不影响管理员那份
    const [readingsResult, staysResult] = await Promise.allSettled([
      readWithRetry(() => db.roomReadings.toArray()),
      db.roomStays.toArray(),
    ]);

    if (readingsResult.status === 'fulfilled') {
      set({ readings: byDateDesc(readingsResult.value), readingsError: '' });
    } else {
      // 读不出：保留已在内存的读数，等值班员重试，绝不拿空数据顶掉
      set({
        readingsError: readingsResult.reason instanceof Error ? readingsResult.reason.message : '记录仪读数读取失败',
      });
    }

    if (staysResult.status === 'fulfilled') {
      set({ stays: byDateDesc(staysResult.value), staysError: '' });
    } else {
      set({
        staysError: staysResult.reason instanceof Error ? staysResult.reason.message : '出入房时刻读取失败',
      });
    }

    set({ readingsLoading: false, staysLoading: false, ready: true });
  },

  async retryLoadReadings() {
    set({ readingsLoading: true });
    try {
      const readings = await readWithRetry(() => db.roomReadings.toArray());
      set({ readings: byDateDesc(readings), readingsError: '', readingsLoading: false });
      return true;
    } catch (error) {
      set({
        readingsLoading: false,
        readingsError: error instanceof Error ? error.message : '记录仪读数读取失败，请重试',
      });
      return false;
    }
  },

  async loadStays() {
    set({ staysLoading: true });
    try {
      const stays = await db.roomStays.toArray();
      set({ stays: byDateDesc(stays), staysError: '', staysLoading: false, ready: true });
    } catch (error) {
      set({ staysLoading: false, staysError: error instanceof Error ? error.message : '出入房时刻读取失败' });
    }
  },

  readingsOfBody(bodyId) {
    return byDateDesc(get().readings.filter((reading) => reading.bodyId === bodyId));
  },

  staysOfBody(bodyId) {
    return byDateDesc(get().stays.filter((stay) => stay.bodyId === bodyId));
  },

  windows() {
    return reconcileRoomWindows(get().readings, get().stays);
  },

  windowsOfBody(bodyId) {
    return reconcileWindowsOfBody(get().readings, get().stays, bodyId);
  },

  pendingCount() {
    return get().windows().filter((window) => window.status === 'pending').length;
  },

  breachedCount() {
    return get().windows().filter((window) => window.breached).length;
  },

  verdictCount() {
    const result: Record<RoomVerdict, number> = { suitable: 0, dry: 0, wet: 0 };
    // 综合判定只统计已认下窗口（读数与时刻两侧齐全）
    get()
      .windows()
      .filter((window) => window.status === 'matched')
      .forEach((window) => {
        if (window.verdict) result[window.verdict] += 1;
      });
    return result;
  },

  async createReading(draft) {
    const now = Date.now();
    // 温湿度判定只认记录仪读数
    const verdict = judgeVerdict(draft.tempC, draft.humidityPct);
    const row: RoomReading = {
      ...draft,
      verdict,
      id: createId('reading'),
      createdAt: now,
      updatedAt: now,
    };
    await db.roomReadings.put(row);
    await get().loadRooms();
    await get().recalcBodyBreach(row.bodyId);
    return row;
  },

  async updateReading(id, patch) {
    const existing = get().readings.find((reading) => reading.id === id);
    if (!existing) return;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    await db.roomReadings.update(id, {
      ...patch,
      tempC,
      humidityPct,
      verdict,
      updatedAt: Date.now(),
    } as never);
    await get().loadRooms();
    await get().recalcBodyBreach(existing.bodyId);
    // 改关联胎体 / 日期后新胎体的越界状态也需回写
    if (patch.bodyId && patch.bodyId !== existing.bodyId) {
      await get().recalcBodyBreach(patch.bodyId);
    }
  },

  async removeReading(id) {
    const existing = get().readings.find((reading) => reading.id === id);
    await db.roomReadings.delete(id);
    await get().loadRooms();
    if (existing) await get().recalcBodyBreach(existing.bodyId);
  },

  async upsertStay(draft, existingId) {
    const now = Date.now();
    const duplicate = get().stays.find(
      (stay) =>
        stay.bodyId === draft.bodyId &&
        stay.date === draft.date &&
        (existingId === undefined || stay.id !== existingId),
    );
    if (duplicate) {
      // 管理员那份每天一条：重复保存只更新时刻，不新增、不顶掉其他日期
      await db.roomStays.update(duplicate.id, {
        inAt: draft.inAt,
        outAt: draft.outAt,
        manager: draft.manager,
        source: draft.source,
        updatedAt: now,
      } as never);
      await get().loadRooms();
      await get().recalcBodyBreach(duplicate.bodyId);
      return { ...duplicate, inAt: draft.inAt, outAt: draft.outAt, manager: draft.manager, updatedAt: now };
    }

    if (existingId) {
      const existing = get().stays.find((stay) => stay.id === existingId);
      await db.roomStays.update(existingId, { ...draft, updatedAt: now } as never);
      await get().loadRooms();
      await get().recalcBodyBreach(draft.bodyId);
      if (existing && (existing.bodyId !== draft.bodyId || existing.date !== draft.date)) {
        await get().recalcBodyBreach(existing.bodyId);
      }
      return { ...(existing as RoomStay), ...draft, id: existingId, createdAt: existing?.createdAt ?? now, updatedAt: now };
    }

    const row: RoomStay = { ...draft, id: createId('stay'), createdAt: now, updatedAt: now };
    await db.roomStays.put(row);
    await get().loadRooms();
    await get().recalcBodyBreach(row.bodyId);
    return row;
  },

  async removeStay(id) {
    const existing = get().stays.find((stay) => stay.id === id);
    await db.roomStays.delete(id);
    await get().loadRooms();
    if (existing) await get().recalcBodyBreach(existing.bodyId);
  },

  async recalcBodyBreach(bodyId) {
    const breached = get().windowsOfBody(bodyId).some((window) => window.breached);
    await useCoatStore.getState().applyRoomBreach(bodyId, breached);
  },
}));
