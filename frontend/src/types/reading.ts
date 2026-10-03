/**
 * 荫房温湿度读数（Reading）数据模型
 * 温湿度读数只认记录仪：由值班员导入记录仪文件产生，同一胎体同一天可有多条采样。
 * 与管理员手填的入出房记录（Stay）分账，按「胎体 + 日期」对账后，
 * 落在入出房窗口内的读数才构成认下的荫干窗口依据。
 */

/** 环境判定：适宜 / 偏干 / 偏湿 */
export type EnvVerdict = 'suitable' | 'dry' | 'wet';

/** 读数来源：记录仪导入 / 旧版合并记录升级补登 */
export type ReadingSource = 'logger' | 'legacy';

export interface Reading {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 读数日期 yyyy-MM-dd */
  date: string;
  /** 采样时刻 HH:mm；旧版合并记录升级补登时为空串 */
  sampledAt: string;
  /** 荫房温度（摄氏度） */
  tempC: number;
  /** 相对湿度（%） */
  humidityPct: number;
  /** 判定结论（导入时按温湿度区间自动判定） */
  verdict: EnvVerdict;
  /** 来源：记录仪 / 旧记录升级补登 */
  source: ReadingSource;
  /** 导入批次标识（记录仪文件名等）；旧记录升级补登为 legacy-v3 */
  importBatch: string;
  /** 缺管理员入出房记录时，值班员核实后挂「已确认」，单边确认后同样按认下窗口处理 */
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ReadingDraft = Omit<Reading, 'id' | 'createdAt' | 'updatedAt' | 'verdict'>;

export const ENV_VERDICT_LABEL: Record<EnvVerdict, string> = {
  suitable: '适宜',
  dry: '偏干',
  wet: '偏湿',
};

export const ENV_VERDICT_COLOR: Record<EnvVerdict, string> = {
  suitable: '#2f6f4f',
  dry: '#c9963c',
  wet: '#3a6ea5',
};

export const ENV_VERDICT_OPTIONS: ReadonlyArray<{ value: EnvVerdict; label: string }> = [
  { value: 'suitable', label: '适宜' },
  { value: 'dry', label: '偏干' },
  { value: 'wet', label: '偏湿' },
];

export const READING_SOURCE_LABEL: Record<ReadingSource, string> = {
  logger: '记录仪',
  legacy: '旧记录补登',
};

/**
 * 记录仪读数自然键：同一胎体同一天同一时刻同一读数重复导入时幂等覆盖，
 * 保证值班员重试导入不会产生重复行。
 */
export function readingNaturalId(row: {
  bodyId: string;
  date: string;
  sampledAt: string;
  tempC: number;
  humidityPct: number;
}): string {
  const time = row.sampledAt.trim().length > 0 ? row.sampledAt.trim() : 'na';
  return `rd_${row.bodyId}_${row.date}_${time}_${row.tempC}_${row.humidityPct}`;
}
