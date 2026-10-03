/**
 * 入出房记录状态管理（Zustand）
 * 出入房时刻只认工序管理员手填：同一胎体每天仅一条。
 * 与记录仪读数完全分账：本 store 只读写 stays 表，记录仪导入不会影响这些记录。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Stay, StayDraft } from '@/types/stay';
import { syncEnvToCoats, type EnvSyncResult } from './roomSync';

export class StayDuplicateError extends Error {}

interface StayStoreState {
  stays: Stay[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadStays: () => Promise<void>;
  staysOfBody: (bodyId: string) => Stay[];
  findStay: (bodyId: string, date: string) => Stay | undefined;
  createStay: (draft: StayDraft) => Promise<{ stay: Stay; sync: EnvSyncResult }>;
  updateStay: (id: string, patch: Partial<Stay>) => Promise<EnvSyncResult>;
  removeStay: (id: string) => Promise<EnvSyncResult>;
  /** 缺读数时管理员核实：挂「已确认」 */
  confirmStay: (id: string) => Promise<EnvSyncResult>;
}

export const useStayStore = create<StayStoreState>((set, get) => ({
  stays: [],
  loading: false,
  ready: false,
  error: '',

  async loadStays() {
    set({ loading: true });
    try {
      const stays = await db.stays.toArray();
      stays.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      set({ stays, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '入出房记录读取失败' });
    }
  },

  staysOfBody(bodyId) {
    return get()
      .stays.filter((stay) => stay.bodyId === bodyId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },

  findStay(bodyId, date) {
    return get().stays.find((stay) => stay.bodyId === bodyId && stay.date === date);
  },

  async createStay(draft) {
    // 每天手填一条：同胎体同日重复直接拒绝，避免对账出现歧义
    const duplicated = get().stays.some((stay) => stay.bodyId === draft.bodyId && stay.date === draft.date);
    if (duplicated) {
      throw new StayDuplicateError('该胎体当天已有一条入出房记录，请直接编辑原记录');
    }
    const now = Date.now();
    const stay: Stay = { ...draft, id: createId('stay'), createdAt: now, updatedAt: now };
    await db.stays.put(stay);
    await get().loadStays();
    const sync = await syncEnvToCoats();
    return { stay, sync };
  },

  async updateStay(id, patch) {
    const existing = get().stays.find((stay) => stay.id === id);
    if (existing) {
      const nextBodyId = patch.bodyId ?? existing.bodyId;
      const nextDate = patch.date ?? existing.date;
      const conflict = get().stays.some(
        (stay) => stay.id !== id && stay.bodyId === nextBodyId && stay.date === nextDate,
      );
      if (conflict) throw new StayDuplicateError('该胎体当天已存在另一条入出房记录');
    }
    await db.stays.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadStays();
    return syncEnvToCoats();
  },

  async removeStay(id) {
    await db.stays.delete(id);
    await get().loadStays();
    return syncEnvToCoats();
  },

  async confirmStay(id) {
    await db.stays.update(id, { confirmed: true, updatedAt: Date.now() });
    await get().loadStays();
    return syncEnvToCoats();
  },
}));
