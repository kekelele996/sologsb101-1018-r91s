/**
 * 入出房记录（Stay）数据模型
 * 出入房时刻只认工序管理员：每天手填一条（同一胎体同一天仅一条），
 * 与记录仪温湿度读数（Reading）分账，按「胎体 + 日期」对账。
 * 缺记录仪读数时先挂「待确认」，管理员核实后补挂确认标记。
 */

/** 来源：管理员手填 / 旧版合并记录升级补登 */
export type StaySource = 'manager' | 'legacy';

export interface Stay {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 记录日期 yyyy-MM-dd */
  date: string;
  /** 入房时间 HH:mm */
  inAt: string;
  /** 出房时间 HH:mm（小于入房时间表示跨夜） */
  outAt: string;
  /** 来源：管理员手填 / 旧记录升级补登 */
  source: StaySource;
  /** 缺记录仪读数时，管理员核实后挂「已确认」；两边齐的正常对账恒为 true */
  confirmed: boolean;
  /** 备注，如值班交接说明 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type StayDraft = Omit<Stay, 'id' | 'createdAt' | 'updatedAt'>;

export const STAY_SOURCE_LABEL: Record<StaySource, string> = {
  manager: '管理员手填',
  legacy: '旧记录补登',
};

export function createEmptyStayDraft(bodyId: string): StayDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    bodyId,
    date: today,
    inAt: '09:00',
    outAt: '21:00',
    source: 'manager',
    confirmed: false,
    note: '',
  };
}
