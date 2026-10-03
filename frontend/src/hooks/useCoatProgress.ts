/**
 * useCoatProgress()：按胎体统计道次完成度、当前道次、荫干等待时长与复检标记
 * 被道次页（/coats）、荫房页（/rooms）、打磨页（/polish）与胎体页（/bodies）消费。
 * 荫房口径：记录仪读数与管理员入出房按「胎体 + 日期」对账后，只统计认下的荫干窗口；
 * 待确认的漏边时段不计入超标，也不回写道次。
 */
import { useCallback, useMemo } from 'react';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useReadingStore } from '@/stores/readingStore';
import { useStayStore } from '@/stores/stayStore';
import { dryingHours } from '@/utils/humidity';
import { reconcile, type ReconcileWindow } from '@/utils/reconciliation';
import { ENV_VERDICT_LABEL } from '@/types/reading';
import { COAT_STATE_LABEL } from '@/types/coat';
import type { BodyStat } from '@/types/body';

const EMPTY_STAT: BodyStat = {
  bodyId: '',
  coatTotal: 0,
  coatDone: 0,
  coatPercent: 0,
  currentSeq: 0,
  roomCount: 0,
  roomOverCount: 0,
  lastRoomVerdict: '暂无记录',
  polishCount: 0,
  inlayCount: 0,
  dryingHours: 0,
};

/** 窗口综合读数文案：取最不利一条（越界优先），温湿度来自该条采样 */
function windowClimateText(window: ReconcileWindow): string {
  if (window.windowReadings.length === 0) return `已认下（无读数，${ENV_VERDICT_LABEL.suitable}）`;
  const representative =
    window.windowReadings.find((row) => row.id === window.verdictReadingId) ?? window.windowReadings[0];
  if (!representative) return ENV_VERDICT_LABEL.suitable;
  return `${representative.tempC}℃ / ${representative.humidityPct}%（${ENV_VERDICT_LABEL[representative.verdict]}）`;
}

export interface CoatProgressResult {
  /** 胎体 id → 统计 */
  map: Record<string, BodyStat>;
  /** 与胎体列表同序的统计数组 */
  list: BodyStat[];
  /** 汇总：道次总数 / 已完成 / 待复检 */
  totals: { coatTotal: number; coatDone: number; percent: number; recheck: number; roomOver: number };
  /** 取单个胎体的统计（不存在时返回空统计） */
  progressOf: (bodyId: string) => BodyStat;
  /** 取单个胎体的当前道次文案 */
  currentCoatText: (bodyId: string) => string;
}

export function useCoatProgress(): CoatProgressResult {
  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const readings = useReadingStore((state) => state.readings);
  const stays = useStayStore((state) => state.stays);

  const windowsByBody = useMemo(() => {
    const map = new Map<string, ReconcileWindow[]>();
    reconcile(readings, stays).forEach((window) => {
      const list = map.get(window.bodyId) ?? [];
      list.push(window);
      map.set(window.bodyId, list);
    });
    return map;
  }, [readings, stays]);

  const map = useMemo<Record<string, BodyStat>>(() => {
    const result: Record<string, BodyStat> = {};
    bodies.forEach((body) => {
      const bodyCoats = coats
        .filter((coat) => coat.bodyId === body.id)
        .sort((a, b) => a.seq - b.seq);
      const bodyWindows = windowsByBody.get(body.id) ?? []; // reconcile 已按日期倒序
      const acknowledged = bodyWindows.filter((window) => window.acknowledged);
      const done = bodyCoats.filter((coat) => coat.state === 'done').length;
      const current = bodyCoats.find((coat) => coat.state !== 'done');
      const lastWindow = acknowledged[0];
      const overCount = acknowledged.filter((window) => window.over).length;
      const waitHours = lastWindow
        ? lastWindow.stayHours > 0
          ? lastWindow.stayHours
          : dryingHours(24, 75, bodyCoats[0]?.thicknessUm ?? 40)
        : bodyCoats[0]
          ? dryingHours(24, 75, bodyCoats[0].thicknessUm)
          : 0;
      result[body.id] = {
        bodyId: body.id,
        coatTotal: bodyCoats.length,
        coatDone: done,
        coatPercent: bodyCoats.length === 0 ? 0 : Math.round((done / bodyCoats.length) * 100),
        currentSeq: current ? current.seq : 0,
        roomCount: acknowledged.length,
        roomOverCount: overCount,
        lastRoomVerdict: lastWindow ? `${lastWindow.date}　${windowClimateText(lastWindow)}` : '暂无认下窗口',
        polishCount: 0,
        inlayCount: 0,
        dryingHours: waitHours,
      };
    });
    return result;
  }, [bodies, coats, windowsByBody]);

  const list = useMemo(() => bodies.map((body) => map[body.id] ?? { ...EMPTY_STAT, bodyId: body.id }), [bodies, map]);

  const totals = useMemo(() => {
    const coatTotal = list.reduce((sum, item) => sum + item.coatTotal, 0);
    const coatDone = list.reduce((sum, item) => sum + item.coatDone, 0);
    return {
      coatTotal,
      coatDone,
      percent: coatTotal === 0 ? 0 : Math.round((coatDone / coatTotal) * 100),
      recheck: coats.filter((coat) => coat.needRecheck).length,
      roomOver: list.reduce((sum, item) => sum + item.roomOverCount, 0),
    };
  }, [coats, list]);

  const progressOf = useCallback(
    (bodyId: string): BodyStat => map[bodyId] ?? { ...EMPTY_STAT, bodyId },
    [map],
  );

  const currentCoatText = useCallback(
    (bodyId: string): string => {
      const stat = map[bodyId];
      if (!stat || stat.coatTotal === 0) return '尚未编排道次';
      const current = coats.find((coat) => coat.bodyId === bodyId && coat.seq === stat.currentSeq);
      if (!current) return `全部 ${stat.coatTotal} 道已完成`;
      return `第 ${current.seq} 道 · ${COAT_STATE_LABEL[current.state]}`;
    },
    [coats, map],
  );

  return { map, list, totals, progressOf, currentCoatText };
}

export default useCoatProgress;
