/**
 * 荫房分账 → 道次回写
 * 仅「认下的荫干窗口」（两边齐，或单边经人工确认）内出现越界读数时回写：
 * - 该胎体没做完的髹涂道次挂「待复检」
 * - 已在打磨环节的道次（待打磨）退回「已涂」，打磨记录保留作凭据
 * 待确认（漏边）时段先挂着，不触发任何回写。
 *
 * 读数与入出房记录的增删改均幂等调用 syncEnvToCoats()。
 */
import { db } from '@/utils/db';
import { useCoatStore } from './coatStore';
import { reconcile, type ReconcileWindow } from '@/utils/reconciliation';
import type { Reading } from '@/types/reading';
import type { Stay } from '@/types/stay';

export interface EnvSyncResult {
  windows: ReconcileWindow[];
  /** 本次回写命中的待复检道次数 */
  recheckCoats: number;
  /** 本次由「待打磨」退回「已涂」的道次数（打磨记录保留） */
  polishRolledBack: number;
}

export async function syncEnvToCoats(readings?: Reading[], stays?: Stay[]): Promise<EnvSyncResult> {
  const [readingRows, stayRows] = await Promise.all([
    readings ? Promise.resolve(readings) : db.readings.toArray(),
    stays ? Promise.resolve(stays) : db.stays.toArray(),
  ]);
  const windows = reconcile(readingRows, stayRows);
  const overBodyIds = new Set(
    windows.filter((window) => window.over).map((window) => window.bodyId),
  );

  const coats = await db.coats.toArray();
  let recheckCoats = 0;
  let polishRolledBack = 0;
  const now = Date.now();
  const next = coats.map((coat) => {
    if (!overBodyIds.has(coat.bodyId) || coat.state === 'done') return coat;
    const updated: typeof coat = { ...coat, needRecheck: true, updatedAt: now };
    recheckCoats += 1;
    if (coat.state === 'toPolish') {
      updated.state = 'coated';
      polishRolledBack += 1;
    }
    return updated;
  });

  if (recheckCoats > 0) await db.coats.bulkPut(next);
  await useCoatStore.getState().loadCoats();

  return { windows, recheckCoats, polishRolledBack };
}
