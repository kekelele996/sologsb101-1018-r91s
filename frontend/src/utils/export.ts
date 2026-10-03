/**
 * 导出工具：整库 JSON 存档、返工清单文本、编目清单 CSV
 * 荫房部分以对账窗口（记录仪读数 × 管理员入出房）为口径；
 * 全部在浏览器本地完成，不经过任何服务端。
 */
import type { Body } from '@/types/body';
import type { Coat } from '@/types/coat';
import type { Reading } from '@/types/reading';
import type { Stay } from '@/types/stay';
import type { Inspect } from '@/types/inspect';
import { BODY_MATERIAL_LABEL, BODY_SHAPE_LABEL } from '@/types/body';
import { COAT_STATE_LABEL, PAINT_TYPE_LABEL } from '@/types/coat';
import { ENV_VERDICT_LABEL, READING_SOURCE_LABEL } from '@/types/reading';
import { STAY_SOURCE_LABEL } from '@/types/stay';
import { INSPECT_VERDICT_LABEL } from '@/types/inspect';
import { reconcile, type ReconcileWindow } from './reconciliation';
import type { LacquerSnapshot } from './db';

/** 触发浏览器下载 */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** 时间戳文件名片段 */
export function stampSuffix(): string {
  const date = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** 导出整库 JSON，返回文件名 */
export function exportSnapshotJson(snapshot: LacquerSnapshot): string {
  const filename = `gblacquer-backup-${stampSuffix()}.json`;
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8');
  return filename;
}

/** CSV 单元格转义 */
function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 代表性读数（与窗口综合判定一致的最不利一条） */
function representativeReading(window: ReconcileWindow): Reading | null {
  return window.windowReadings.find((row) => row.id === window.verdictReadingId) ?? window.windowReadings[0] ?? null;
}

/** 返工清单：定位到具体道次与记录仪读数 */
export function buildReworkList(
  bodies: Body[],
  coats: Coat[],
  readings: Reading[],
  inspects: Inspect[],
): string {
  const lines: string[] = ['漆器髹涂返工清单', `生成时间：${new Date().toLocaleString('zh-CN')}`, ''];
  const reworks = inspects.filter((item) => item.verdict === 'rework');
  if (reworks.length === 0) {
    lines.push('当前无返工记录。');
    return lines.join('\n');
  }
  reworks.forEach((inspect, index) => {
    const body = bodies.find((item) => item.id === inspect.bodyId);
    const coat = coats.find((item) => item.bodyId === inspect.bodyId && item.seq === inspect.defectCoatSeq);
    // defectRoomId 沿用旧字段名，v3 起存记录仪读数 id（旧记录升级后 id 不变，仍可命中）
    const reading = readings.find((item) => item.id === inspect.defectRoomId);
    lines.push(`${index + 1}. ${body ? `${body.code}（${BODY_MATERIAL_LABEL[body.material]}·${BODY_SHAPE_LABEL[body.shape]}）` : inspect.bodyId}`);
    lines.push(`   质检日期：${inspect.date}　质检人：${inspect.inspector || '未填写'}　结论：${INSPECT_VERDICT_LABEL[inspect.verdict]}`);
    lines.push(`   缺陷：${inspect.defectNote || '未填写'}`);
    lines.push(
      `   定位道次：${
        coat
          ? `第 ${coat.seq} 道 · ${PAINT_TYPE_LABEL[coat.paintType]} · ${coat.colorName} · ${COAT_STATE_LABEL[coat.state]}`
          : '未指定'
      }`,
    );
    lines.push(
      `   关联记录仪读数：${
        reading
          ? `${reading.date} ${reading.sampledAt || '时刻缺'}　${reading.tempC}℃ / ${reading.humidityPct}%（${ENV_VERDICT_LABEL[reading.verdict]} · ${READING_SOURCE_LABEL[reading.source]}）`
          : '未指定'
      }`,
    );
    lines.push('');
  });
  return lines.join('\n');
}

/** 导出返工清单为文本文件 */
export function exportReworkList(
  bodies: Body[],
  coats: Coat[],
  readings: Reading[],
  inspects: Inspect[],
): string {
  const filename = `漆器返工清单-${stampSuffix()}.txt`;
  download(filename, buildReworkList(bodies, coats, readings, inspects), 'text/plain;charset=utf-8');
  return filename;
}

/** 工序台账 CSV（全部胎体 + 道次 + 认下荫干窗口） */
export function exportLedgerCsv(bodies: Body[], coats: Coat[], readings: Reading[], stays: Stay[]): string {
  const header = [
    '胎体编号', '材质', '器型', '尺寸(mm)', '委托/藏家',
    '道次', '漆种', '色名', '涂刷日期', '湿膜(μm)', '道次状态', '待复检',
    '荫干日期', '入房', '出房', '在房小时', '温度(℃)', '湿度(%)', '窗口判定', '对账状态', '读数来源', '入出房来源',
  ];
  const lines: string[] = [header.map(csvCell).join(',')];
  const windows = reconcile(readings, stays);
  const windowKey = (bodyId: string, date: string): string => `${bodyId}__${date}`;
  const windowMap = new Map(windows.map((window) => [windowKey(window.bodyId, window.date), window]));

  bodies.forEach((body) => {
    const bodyCoats = coats.filter((item) => item.bodyId === body.id).sort((a, b) => a.seq - b.seq);
    const bodyStays = stays
      .filter((item) => item.bodyId === body.id)
      .sort((a, b) => a.date.localeCompare(b.date));
    const bodyDates = new Set<string>([
      ...bodyStays.map((stay) => stay.date),
      ...readings.filter((row) => row.bodyId === body.id).map((row) => row.date),
    ]);
    const bodyWindows = [...bodyDates]
      .sort((a, b) => b.localeCompare(a))
      .map((date) => windowMap.get(windowKey(body.id, date)))
      .filter((window): window is ReconcileWindow => window !== undefined);

    const rowCount = Math.max(bodyCoats.length, bodyWindows.length, 1);
    for (let index = 0; index < rowCount; index += 1) {
      const coat = bodyCoats[index];
      const window = bodyWindows[index];
      const sample = window ? representativeReading(window) : null;
      lines.push(
        [
          index === 0 ? body.code : '',
          index === 0 ? BODY_MATERIAL_LABEL[body.material] : '',
          index === 0 ? BODY_SHAPE_LABEL[body.shape] : '',
          index === 0 ? body.sizeMm : '',
          index === 0 ? body.ownerName : '',
          coat ? coat.seq : '',
          coat ? PAINT_TYPE_LABEL[coat.paintType] : '',
          coat ? coat.colorName : '',
          coat ? coat.coatDate : '',
          coat ? coat.thicknessUm : '',
          coat ? COAT_STATE_LABEL[coat.state] : '',
          coat ? (coat.needRecheck ? '是' : '否') : '',
          window ? window.date : '',
          window?.stay ? window.stay.inAt : '',
          window?.stay ? window.stay.outAt : '',
          window && window.stay ? window.stayHours : '',
          sample ? sample.tempC : '',
          sample ? sample.humidityPct : '',
          window && window.acknowledged && window.verdict ? ENV_VERDICT_LABEL[window.verdict] : window ? '待确认' : '',
          window ? (window.acknowledged ? '已认下' : '待确认') : '',
          sample ? READING_SOURCE_LABEL[sample.source] : '',
          window?.stay ? STAY_SOURCE_LABEL[window.stay.source] : '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
  });
  const filename = `漆器髹涂台账-${stampSuffix()}.csv`;
  download(filename, `﻿${lines.join('\n')}`, 'text/csv;charset=utf-8');
  return filename;
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
