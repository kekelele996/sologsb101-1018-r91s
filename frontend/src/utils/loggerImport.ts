/**
 * 记录仪文件解析（CSV）
 * 值班员把荫房记录仪导出的温湿度 CSV 导入本系统；
 * 解析失败抛错（文件读不出 / 表头不对），由页面弹窗提示并允许重试，不写入任何数据。
 *
 * 期望表头（首行）：
 *   胎体编号,日期,采样时刻,温度℃,相对湿度%
 * 兼容记录仪常见英文字段别名；同一胎体同一天可有多条采样行。
 */
import { judgeVerdict } from './humidity';
import type { Reading } from '@/types/reading';

/** 记录仪导入成功后的完整读数载荷（含自动判定，仅缺主键与时间戳） */
export type LoggerReadingPayload = Omit<Reading, 'id' | 'createdAt' | 'updatedAt'>;

/** 记录仪导入模板（页面提供下载，值班员按此格式导出/整理） */
export const LOGGER_CSV_TEMPLATE = '胎体编号,日期,采样时刻,温度℃,相对湿度%\nLQ-2401,2026-03-07,08:30,24.2,78';

export interface ParsedLoggerRow {
  lineNo: number;
  code: string;
  date: string;
  sampledAt: string;
  tempC: number;
  humidityPct: number;
  reason?: string;
}

export interface LoggerParseResult {
  rows: ParsedLoggerRow[];
  skipped: ParsedLoggerRow[];
  /** 文件名，作为导入批次 */
  batch: string;
}

export class LoggerFileError extends Error {}

interface HeaderSpec {
  index: number;
  aliases: string[];
}

const HEADER_SPECS: ReadonlyArray<HeaderSpec & { key: 'code' | 'date' | 'sampledAt' | 'tempC' | 'humidityPct' }> = [
  { key: 'code', index: -1, aliases: ['胎体编号', '编号', '体编号', 'code', 'body', 'bodycode'] },
  { key: 'date', index: -1, aliases: ['日期', 'date', 'day'] },
  { key: 'sampledAt', index: -1, aliases: ['采样时刻', '时刻', '时间', 'time', 'sampledat', 'sampled'] },
  { key: 'tempC', index: -1, aliases: ['温度℃', '温度', '温度(℃)', 'temp', 'tempc', 'temperature'] },
  { key: 'humidityPct', index: -1, aliases: ['相对湿度%', '湿度%', '湿度', '相对湿度', 'humidity', 'rh'] },
];

/** 极简 CSV 行解析（支持引号包裹与逗号转义） */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

/** 校验并归一化一行数据；不合法时在 reason 中给出原因 */
function normalizeRow(lineNo: number, cells: string[], indexMap: Record<string, number>): ParsedLoggerRow {
  const get = (key: 'code' | 'date' | 'sampledAt' | 'tempC' | 'humidityPct'): string =>
    (cells[indexMap[key]] ?? '').trim();

  const base: ParsedLoggerRow = {
    lineNo,
    code: '',
    date: '',
    sampledAt: '',
    tempC: 0,
    humidityPct: 0,
  };

  const code = get('code');
  if (!code) return { ...base, reason: '缺胎体编号' };
  const date = get('date');
  if (!DATE_RE.test(date)) return { ...base, code, date, reason: '日期格式应为 yyyy-MM-dd' };
  const sampledRaw = get('sampledAt');
  if (!TIME_RE.test(sampledRaw)) return { ...base, code, date, sampledAt: sampledRaw, reason: '时刻格式应为 HH:mm' };
  const sampledAt = sampledRaw.padStart(5, '0');
  const tempC = Number.parseFloat(get('tempC'));
  if (!Number.isFinite(tempC) || tempC < -10 || tempC > 60) {
    return { ...base, code, date, sampledAt, reason: '温度超出合理范围（-10~60℃）' };
  }
  const humidityPct = Number.parseFloat(get('humidityPct'));
  if (!Number.isFinite(humidityPct) || humidityPct < 0 || humidityPct > 100) {
    return { ...base, code, date, sampledAt, tempC, reason: '湿度应在 0~100 之间' };
  }

  return {
    lineNo,
    code,
    date,
    sampledAt,
    tempC: Math.round(tempC * 10) / 10,
    humidityPct: Math.round(humidityPct * 10) / 10,
  };
}

/**
 * 解析记录仪 CSV 文本。
 * @throws LoggerFileError 文件为空 / 表头缺少必需列
 */
export function parseLoggerCsv(text: string, filename: string): LoggerParseResult {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new LoggerFileError('文件读不出有效内容：需要表头加至少一条读数，请重试或更换记录仪文件');
  }

  const headerCells = splitCsvLine(lines[0] as string).map((cell) => cell.replace(/\s+/g, '').toLowerCase());
  const indexMap: Record<string, number> = { code: -1, date: -1, sampledAt: -1, tempC: -1, humidityPct: -1 };
  HEADER_SPECS.forEach((spec) => {
    const hit = spec.aliases.findIndex((alias) => headerCells.includes(alias.replace(/\s+/g, '').toLowerCase()));
    if (hit >= 0) {
      indexMap[spec.key] = headerCells.indexOf(
        spec.aliases[hit]!.replace(/\s+/g, '').toLowerCase(),
      );
    }
  });
  const missing: string[] = [];
  if (indexMap.code < 0) missing.push('胎体编号');
  if (indexMap.date < 0) missing.push('日期');
  if (indexMap.sampledAt < 0) missing.push('采样时刻');
  if (indexMap.tempC < 0) missing.push('温度');
  if (indexMap.humidityPct < 0) missing.push('湿度');
  if (missing.length > 0) {
    throw new LoggerFileError(`表头缺少必需列：${missing.join('、')}（请按模板导出后重试）`);
  }

  const rows: ParsedLoggerRow[] = [];
  const skipped: ParsedLoggerRow[] = [];
  for (let lineNo = 1; lineNo < lines.length; lineNo += 1) {
    const row = normalizeRow(lineNo + 1, splitCsvLine(lines[lineNo] as string), indexMap);
    if (row.reason) skipped.push(row);
    else rows.push(row);
  }
  if (rows.length === 0) {
    throw new LoggerFileError('没有一行能识别为有效读数，请检查文件内容后重试');
  }

  return { rows, skipped, batch: filename || `logger-${Date.now()}` };
}

/** 解析成功后转成读数载荷（胎体编号在 store 中解析为 bodyId） */
export function toReadingDraft(
  row: ParsedLoggerRow,
  bodyId: string,
  batch: string,
): LoggerReadingPayload {
  return {
    bodyId,
    date: row.date,
    sampledAt: row.sampledAt,
    tempC: row.tempC,
    humidityPct: row.humidityPct,
    verdict: judgeVerdict(row.tempC, row.humidityPct),
    source: 'logger',
    importBatch: batch,
    confirmed: false,
  };
}
