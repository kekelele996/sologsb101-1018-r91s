/**
 * 记录仪温湿度读数状态管理（Zustand）
 * 读数只来自记录仪文件导入（值班员操作）与旧记录升级，页面不提供手填入口。
 * 导入按自然键幂等 upsert：值班员重试同一文件不会产生重复行；
 * 导入事务只写 readings 表，管理员的入出房记录（stays）不会被顶掉。
 */
import { create } from 'zustand';
import { db } from '@/utils/db';
import type { Reading } from '@/types/reading';
import type { ParsedLoggerRow } from '@/utils/loggerImport';
import { toReadingDraft } from '@/utils/loggerImport';
import { syncEnvToCoats, type EnvSyncResult } from './roomSync';
import type { Body } from '@/types/body';
import { readingNaturalId } from '@/types/reading';

export interface LoggerImportSummary {
  imported: number;
  updated: number;
  skipped: ParsedLoggerRow[];
  unknownCodes: string[];
  sync: EnvSyncResult;
}

interface ReadingStoreState {
  readings: Reading[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadReadings: () => Promise<void>;
  readingsOfBody: (bodyId: string) => Reading[];
  /** 记录仪文件导入：胎体编号解析为 bodyId，未知编号进 skipped；成功后触发一次对账回写 */
  importLoggerRows: (rows: ParsedLoggerRow[], bodies: Body[], batch: string) => Promise<LoggerImportSummary>;
  /** 缺入出房记录时值班员核实：把当天该胎体全部读数挂「已确认」 */
  confirmDay: (bodyId: string, date: string) => Promise<EnvSyncResult | undefined>;
  removeReading: (id: string) => Promise<EnvSyncResult>;
}

export const useReadingStore = create<ReadingStoreState>((set, get) => ({
  readings: [],
  loading: false,
  ready: false,
  error: '',

  async loadReadings() {
    set({ loading: true });
    try {
      const readings = await db.readings.toArray();
      readings.sort((a, b) =>
        a.date < b.date ? 1 : a.date > b.date ? -1 : a.sampledAt < b.sampledAt ? 1 : a.sampledAt > b.sampledAt ? -1 : 0,
      );
      set({ readings, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '记录仪读数读取失败' });
    }
  },

  readingsOfBody(bodyId) {
    return get()
      .readings.filter((reading) => reading.bodyId === bodyId)
      .sort((a, b) =>
        a.date < b.date ? 1 : a.date > b.date ? -1 : a.sampledAt < b.sampledAt ? 1 : a.sampledAt > b.sampledAt ? -1 : 0,
      );
  },

  async importLoggerRows(rows, bodies, batch) {
    // 编号 → 胎体 id；编号大小写不敏感、去空格匹配
    const codeMap = new Map<string, Body>();
    bodies.forEach((body) => codeMap.set(body.code.trim().toLowerCase(), body));
    const accepted: Array<{ row: ParsedLoggerRow; body: Body }> = [];
    const skipped: ParsedLoggerRow[] = [];
    const unknownCodes: string[] = [];

    rows.forEach((row) => {
      const body = codeMap.get(row.code.trim().toLowerCase());
      if (!body) {
        skipped.push({ ...row, reason: `胎体编号 ${row.code} 未登记` });
        if (!unknownCodes.includes(row.code)) unknownCodes.push(row.code);
        return;
      }
      accepted.push({ row, body });
    });

    let imported = 0;
    let updated = 0;
    const existingIds = new Set((await db.readings.toCollection().primaryKeys()) as string[]);

    const records: Reading[] = accepted.map(({ row, body }) => {
      const draft = toReadingDraft(row, body.id, batch);
      const id = readingNaturalId(draft);
      const existing = get().readings.find((item) => item.id === id);
      if (existing) updated += 1;
      else if (existingIds.has(id)) updated += 1;
      else imported += 1;
      const now = Date.now();
      return {
        ...draft,
        id,
        // 重试导入保留既有核实标记，不把值班员已确认的单边时段打回
        confirmed: existing?.confirmed ?? false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    });

    // 事务只写 readings：管理员那份 stays 绝不被顶掉
    if (records.length > 0) await db.readings.bulkPut(records);

    await get().loadReadings();
    const sync = await syncEnvToCoats();
    return { imported, updated, skipped, unknownCodes, sync };
  },

  async confirmDay(bodyId, date) {
    const targets = get().readings.filter((row) => row.bodyId === bodyId && row.date === date);
    if (targets.length === 0) return undefined;
    const now = Date.now();
    await db.readings.bulkPut(targets.map((row) => ({ ...row, confirmed: true, updatedAt: now })));
    await get().loadReadings();
    return syncEnvToCoats();
  },

  async removeReading(id) {
    await db.readings.delete(id);
    await get().loadReadings();
    return syncEnvToCoats();
  },
}));
