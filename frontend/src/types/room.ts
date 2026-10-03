/**
 * 荫房两类记录的数据模型（v3 起拆分，责任分开）
 * - RoomReading：荫房值班员用温湿度记录仪登记的读数，温湿度以记录仪为准。
 * - RoomStay：工序管理员每天手填一条的出入房时刻，入房/出房时刻以管理员为准。
 * 两边按「胎体 + 日期」对账：两侧齐了才认下荫干窗口；只有一侧的时段先挂待确认。
 */

/** 判定结论：适宜 / 偏干 / 偏湿（由记录仪读数的温湿度算出） */
export type RoomVerdict = 'suitable' | 'dry' | 'wet';

/** 数据来源：记录仪 / 管理员 / 旧版合并记录升级 */
export type RoomSource = 'logger' | 'manager' | 'legacy';

/* ------------------------------ 记录仪读数 ------------------------------ */

export interface RoomReading {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 记录日期 yyyy-MM-dd（对账键之一） */
  date: string;
  /** 荫房温度（摄氏度，记录仪读数） */
  tempC: number;
  /** 相对湿度（%，记录仪读数） */
  humidityPct: number;
  /** 判定结论（按记录仪温湿度计算） */
  verdict: RoomVerdict;
  /** 数据来源：值班员记录仪导入 / 手工补录为 logger，旧数据升级为 legacy */
  source: RoomSource;
  /** 值班员（记录仪持用人），可空 */
  officer: string;
  createdAt: number;
  updatedAt: number;
}

export type RoomReadingDraft = Omit<RoomReading, 'id' | 'createdAt' | 'updatedAt'>;

/* --------------------------- 管理员出入房时刻 --------------------------- */

export interface RoomStay {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 记录日期 yyyy-MM-dd（对账键之一） */
  date: string;
  /** 入房时间 HH:mm（管理员手填） */
  inAt: string;
  /** 出房时间 HH:mm（管理员手填） */
  outAt: string;
  /** 数据来源：管理员手填为 manager，旧数据升级为 legacy */
  source: RoomSource;
  /** 工序管理员，可空 */
  manager: string;
  createdAt: number;
  updatedAt: number;
}

export type RoomStayDraft = Omit<RoomStay, 'id' | 'createdAt' | 'updatedAt'>;

/* ------------------------------- 字典常量 ------------------------------- */

export const ROOM_VERDICT_LABEL: Record<RoomVerdict, string> = {
  suitable: '适宜',
  dry: '偏干',
  wet: '偏湿',
};

export const ROOM_VERDICT_COLOR: Record<RoomVerdict, string> = {
  suitable: '#2f6f4f',
  dry: '#c9963c',
  wet: '#3a6ea5',
};

export const ROOM_VERDICT_OPTIONS: ReadonlyArray<{ value: RoomVerdict; label: string }> = [
  { value: 'suitable', label: '适宜' },
  { value: 'dry', label: '偏干' },
  { value: 'wet', label: '偏湿' },
];

export const ROOM_SOURCE_LABEL: Record<RoomSource, string> = {
  logger: '记录仪',
  manager: '管理员',
  legacy: '旧版合并记录',
};

export const ROOM_SOURCE_COLOR: Record<RoomSource, string> = {
  logger: '#3a6ea5',
  manager: '#8c2f1f',
  legacy: '#8c8c8c',
};

/** 对账状态：两侧齐了认下窗口（matched），只有一侧先挂待确认（pending） */
export type ReconcileStatus = 'matched' | 'pending';

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  matched: '已认下',
  pending: '待确认',
};

export const RECONCILE_STATUS_COLOR: Record<ReconcileStatus, string> = {
  matched: '#2f6f4f',
  pending: '#c9963c',
};

/** 待确认缺侧：只有读数缺出入房时刻 / 只有时刻缺读数 */
export type ReconcileMissingSide = 'stay' | 'reading';

export const RECONCILE_MISSING_LABEL: Record<ReconcileMissingSide, string> = {
  stay: '缺管理员出入房时刻',
  reading: '缺记录仪读数',
};

export function createEmptyReadingDraft(bodyId: string): RoomReadingDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    bodyId,
    date: today,
    tempC: 24,
    humidityPct: 75,
    verdict: 'suitable',
    source: 'logger',
    officer: '',
  };
}

export function createEmptyStayDraft(bodyId: string): RoomStayDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    bodyId,
    date: today,
    inAt: '09:00',
    outAt: '21:00',
    source: 'manager',
    manager: '',
  };
}
