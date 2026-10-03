/**
 * useCoatProgress()：按胎体统计道次完成度、当前道次、荫干等待时长与复检标记
 * 荫房维度消费对账后的窗口：已认下（读数 + 出入房时刻两侧齐全）才计入窗口数，
 * 待确认时段单列，越界次数只统计认下窗口（与道次回写口径一致）。
 * 被道次页（/coats）、荫房页（/rooms）、打磨页（/polish）与胎体页（/bodies）消费。
 */
import { useCallback, useMemo } from 'react';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import { reconcileWindowsOfBody } from '@/utils/reconcile';
import { dryingHours, roomStayHours } from '@/utils/humidity';
import { ROOM_VERDICT_LABEL } from '@/types/room';
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

export interface CoatProgressResult {
  /** 胎体 id → 统计 */
  map: Record<string, BodyStat>;
  /** 与胎体列表同序的统计数组 */
  list: BodyStat[];
  /** 汇总：道次总数 / 已完成 / 待复检 / 认下窗口越界 */
  totals: { coatTotal: number; coatDone: number; percent: number; recheck: number; roomOver: number };
  /** 取单个胎体的统计（不存在时返回空统计） */
  progressOf: (bodyId: string) => BodyStat;
  /** 取单个胎体的当前道次文案 */
  currentCoatText: (bodyId: string) => string;
}

export function useCoatProgress(): CoatProgressResult {
  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const readings = useRoomStore((state) => state.readings);
  const stays = useRoomStore((state) => state.stays);

  const map = useMemo<Record<string, BodyStat>>(() => {
    const result: Record<string, BodyStat> = {};
    bodies.forEach((body) => {
      const bodyCoats = coats
        .filter((coat) => coat.bodyId === body.id)
        .sort((a, b) => a.seq - b.seq);
      // 对账窗口已按日期倒序：第 0 条为最新
      const windows = reconcileWindowsOfBody(readings, stays, body.id);
      const matched = windows.filter((window) => window.status === 'matched');
      const lastWindow = windows.find((window) => window.status === 'matched') ?? windows[0];
      const done = bodyCoats.filter((coat) => coat.state === 'done').length;
      const current = bodyCoats.find((coat) => coat.state !== 'done');
      const overCount = windows.filter((window) => window.breached).length;
      const waitHours = lastWindow?.stay
        ? roomStayHours(lastWindow.stay.inAt, lastWindow.stay.outAt)
        : lastWindow === undefined && bodyCoats[0]
          ? dryingHours(24, 75, bodyCoats[0].thicknessUm)
          : 0;
      result[body.id] = {
        bodyId: body.id,
        coatTotal: bodyCoats.length,
        coatDone: done,
        coatPercent: bodyCoats.length === 0 ? 0 : Math.round((done / bodyCoats.length) * 100),
        currentSeq: current ? current.seq : 0,
        // 荫干窗口只认两侧齐了对账认下的
        roomCount: matched.length,
        roomOverCount: overCount,
        lastRoomVerdict: lastWindow
          ? lastWindow.status === 'pending'
            ? `${lastWindow.date} 待确认（${lastWindow.missing === 'stay' ? '缺出入房时刻' : '缺记录仪读数'}）`
            : `${lastWindow.date}　${lastWindow.readings[0]?.tempC}℃ / ${lastWindow.readings[0]?.humidityPct}%（${ROOM_VERDICT_LABEL[lastWindow.verdict as 'suitable' | 'dry' | 'wet']}）`
          : '暂无记录',
        polishCount: 0,
        inlayCount: 0,
        dryingHours: waitHours,
      };
    });
    return result;
  }, [bodies, coats, readings, stays]);

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
