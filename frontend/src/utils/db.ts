/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移：
 *   v1 → v2：Coat 增加 paintType 索引并回填历史记录
 *   v2 → v3：荫房记录按责任分账——温湿度读数 readings（记录仪）与入出房 stays（管理员），
 *            旧 rooms 表逐行拆分为两边并补登来源 source='legacy'，随后删除 rooms 表
 * - 七张业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import type { EnvVerdict, Reading, ReadingSource } from '@/types/reading';
import type { Stay, StaySource } from '@/types/stay';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gblacquer';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gblacquer:db-version',
  lastBackupAt: 'gblacquer:last-backup-at',
  uiPrefs: 'gblacquer:ui-prefs',
} as const;

export interface UiPrefs {
  /** 最近选中的胎体 */
  lastBodyId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBodyId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { lastBodyId: typeof parsed.lastBodyId === 'string' ? parsed.lastBodyId : null };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 记录结构版本与最近备份时间，便于「本地数据」页回显 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

/* --------------------- v2 及更早的荫房合并记录（仅迁移/旧备份用） --------------------- */

/** v1/v2 的 Room 表结构：温湿度与出入房时刻混记，升级时逐行拆分 */
export interface LegacyRoom {
  id: string;
  bodyId: string;
  date: string;
  tempC: number;
  humidityPct: number;
  inAt: string;
  outAt: string;
  verdict: EnvVerdict;
  createdAt?: number;
  updatedAt?: number;
}

const LEGACY_VERDICTS: ReadonlyArray<EnvVerdict> = ['suitable', 'dry', 'wet'];
const LEGACY_IMPORT_BATCH = 'legacy-v3';

/**
 * 旧数据升级：把每条合并记录拆成「读数（归记录仪）」与「入出房（归管理员）」两边，
 * 来源统一补登为 legacy；读数保留原 id，保证质检记录的缺陷定位仍能命中。
 */
export function splitLegacyRooms(legacyRooms: LegacyRoom[]): { readings: Reading[]; stays: Stay[] } {
  const readings: Reading[] = [];
  const stays: Stay[] = [];
  legacyRooms.forEach((room) => {
    const stamp = room.updatedAt ?? room.createdAt ?? Date.now();
    const verdict: EnvVerdict = LEGACY_VERDICTS.includes(room.verdict) ? room.verdict : 'suitable';
    readings.push({
      id: room.id,
      bodyId: room.bodyId,
      date: room.date,
      sampledAt: '',
      tempC: room.tempC,
      humidityPct: room.humidityPct,
      verdict,
      source: 'legacy',
      importBatch: LEGACY_IMPORT_BATCH,
      confirmed: true,
      createdAt: room.createdAt ?? stamp,
      updatedAt: room.updatedAt ?? stamp,
    });
    stays.push({
      id: `${room.id}_stay`,
      bodyId: room.bodyId,
      date: room.date,
      inAt: room.inAt,
      outAt: room.outAt,
      source: 'legacy',
      confirmed: true,
      note: '',
      createdAt: room.createdAt ?? stamp,
      updatedAt: room.updatedAt ?? stamp,
    });
  });
  return { readings, stays };
}

class LacquerDatabase extends Dexie {
  bodies!: Table<Body, string>;
  coats!: Table<Coat, string>;
  readings!: Table<Reading, string>;
  stays!: Table<Stay, string>;
  polishes!: Table<Polish, string>;
  inlays!: Table<Inlay, string>;
  inspects!: Table<Inspect, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, state, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    });

    // v2：Coat 增加 paintType 索引；历史记录缺少 paintType 时按「生漆」回填
    this.version(2).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    }).upgrade(async (tx) => {
      await tx
        .table<Coat>('coats')
        .toCollection()
        .modify((coat) => {
          const legal: PaintType[] = ['raw', 'color', 'topcoat'];
          if (!legal.includes(coat.paintType)) coat.paintType = 'raw';
          if (typeof coat.needRecheck !== 'boolean') coat.needRecheck = false;
          if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
        });
    });

    // v3：荫房分账。readings（记录仪温湿度）与 stays（管理员入出房）按 [bodyId+date] 对账；
    // 旧 rooms 表在升级回调中拆出后，以 rooms: null 显式删表（不在 stores 声明不会自动删除）。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
        readings: 'id, bodyId, date, verdict, source, [bodyId+date], updatedAt',
        stays: 'id, bodyId, date, source, confirmed, [bodyId+date], updatedAt',
        rooms: null,
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const legacyRooms = await tx.table<LegacyRoom>('rooms').toArray();
        const split = splitLegacyRooms(legacyRooms);
        if (split.readings.length > 0) await tx.table<Reading>('readings').bulkPut(split.readings);
        if (split.stays.length > 0) await tx.table<Stay>('stays').bulkPut(split.stays);
      });
  }
}

export const db = new LacquerDatabase();

/** 七张业务表清单，事务中统一引用 */
const TABLE_LIST = [db.bodies, db.coats, db.readings, db.stays, db.polishes, db.inlays, db.inspects];

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.bodies.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Body →（Coat / Reading+Stay / Polish / Inlay）→ Inspect，id 固定便于深链命中 */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const bodies: Body[] = [
    {
      id: 'body_01',
      code: 'LQ-2401',
      material: 'wood',
      shape: 'bowl',
      sizeMm: 152,
      ownerName: '陈氏委托',
      state: 'coating',
      createdAt: now - 86400000 * 12,
      updatedAt: now - 86400000 * 2,
    },
    {
      id: 'body_02',
      code: 'LQ-2402',
      material: 'lacquered',
      shape: 'box',
      sizeMm: 96,
      ownerName: '工作室自藏',
      state: 'drying',
      createdAt: now - 86400000 * 9,
      updatedAt: now - 86400000,
    },
    {
      id: 'body_03',
      code: 'LQ-2403',
      material: 'metal',
      shape: 'vase',
      sizeMm: 210,
      ownerName: '市工艺美术馆',
      state: 'done',
      createdAt: now - 86400000 * 30,
      updatedAt: now - 86400000 * 4,
    },
  ];

  // coat_0102：认下窗口越界，道次由「待打磨」退回「已涂」并挂待复检（打磨记录保留作凭据）
  const coats: Coat[] = [
    { id: 'coat_0101', bodyId: 'body_01', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'done', needRecheck: false, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 10 },
    { id: 'coat_0102', bodyId: 'body_01', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06', thicknessUm: 45, state: 'coated', needRecheck: true, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0103', bodyId: 'body_01', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12', thicknessUm: 30, state: 'todo', needRecheck: false, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'coat_0201', bodyId: 'body_02', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 35, state: 'done', needRecheck: false, createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 7 },
    { id: 'coat_0202', bodyId: 'body_02', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-08', thicknessUm: 42, state: 'coated', needRecheck: true, createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'coat_0301', bodyId: 'body_03', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10', thicknessUm: 38, state: 'done', needRecheck: false, createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 25 },
    { id: 'coat_0302', bodyId: 'body_03', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18', thicknessUm: 44, state: 'done', needRecheck: false, createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 18 },
    { id: 'coat_0303', bodyId: 'body_03', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26', thicknessUm: 28, state: 'done', needRecheck: false, createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 4 },
  ];

  // 温湿度读数：只来自记录仪导入。reading_0103 在出房时刻之后，不计入认下窗口
  const readings: Reading[] = [
    { id: 'reading_0101', bodyId: 'body_01', date: '2026-03-03', sampledAt: '14:00', tempC: 24, humidityPct: 78, verdict: 'suitable', source: 'logger', importBatch: 'logger-20260303.csv', confirmed: false, createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'reading_0102', bodyId: 'body_01', date: '2026-03-07', sampledAt: '12:30', tempC: 27, humidityPct: 56, verdict: 'dry', source: 'logger', importBatch: 'logger-20260307.csv', confirmed: false, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'reading_0103', bodyId: 'body_01', date: '2026-03-07', sampledAt: '21:30', tempC: 23, humidityPct: 72, verdict: 'suitable', source: 'logger', importBatch: 'logger-20260307.csv', confirmed: false, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'reading_0201', bodyId: 'body_02', date: '2026-03-05', sampledAt: '16:00', tempC: 23, humidityPct: 91, verdict: 'wet', source: 'logger', importBatch: 'logger-20260305.csv', confirmed: false, createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'reading_0301', bodyId: 'body_03', date: '2026-02-20', sampledAt: '15:00', tempC: 25, humidityPct: 76, verdict: 'suitable', source: 'logger', importBatch: 'logger-20260220.csv', confirmed: false, createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
    // 漏管理员入出房记录：时段先挂着等确认，暂不回写道次
    { id: 'reading_0104', bodyId: 'body_01', date: '2026-03-10', sampledAt: '11:00', tempC: 28, humidityPct: 88, verdict: 'wet', source: 'logger', importBatch: 'logger-20260310.csv', confirmed: false, createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'reading_0302', bodyId: 'body_03', date: '2026-03-01', sampledAt: '09:00', tempC: 22, humidityPct: 70, verdict: 'suitable', source: 'logger', importBatch: 'logger-20260301.csv', confirmed: false, createdAt: now - 86400000 * 3, updatedAt: now - 86400000 * 3 },
  ];

  // 入出房时刻：只来自管理员手填，每天一条
  const stays: Stay[] = [
    { id: 'stay_0101', bodyId: 'body_01', date: '2026-03-03', inAt: '09:00', outAt: '21:00', source: 'manager', confirmed: true, note: '', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'stay_0102', bodyId: 'body_01', date: '2026-03-07', inAt: '08:30', outAt: '20:00', source: 'manager', confirmed: true, note: '', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'stay_0201', bodyId: 'body_02', date: '2026-03-05', inAt: '10:00', outAt: '22:30', source: 'manager', confirmed: true, note: '', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'stay_0301', bodyId: 'body_03', date: '2026-02-20', inAt: '09:30', outAt: '21:30', source: 'manager', confirmed: true, note: '', createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
    // 漏记录仪读数：挂着等确认
    { id: 'stay_0103', bodyId: 'body_01', date: '2026-03-09', inAt: '09:00', outAt: '18:00', source: 'manager', confirmed: false, note: '', createdAt: now - 86400000 * 3, updatedAt: now - 86400000 * 3 },
  ];

  const polishes: Polish[] = [
    { id: 'polish_0101', bodyId: 'body_01', seq: 1, grit: 600, method: 'water', durationMin: 35, operator: '王丽', createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 9 },
    // 第 2 道已有打磨记录，但认下窗口越界后道次退回已涂，打磨记录保留
    { id: 'polish_0102', bodyId: 'body_01', seq: 2, grit: 1500, method: 'burnish', durationMin: 45, operator: '王丽', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'polish_0201', bodyId: 'body_02', seq: 1, grit: 800, method: 'water', durationMin: 30, operator: '李成', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'polish_0301', bodyId: 'body_03', seq: 3, grit: 2000, method: 'burnish', durationMin: 60, operator: '王丽', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 * 4 },
  ];

  const inlays: Inlay[] = [
    { id: 'inlay_0101', bodyId: 'body_01', type: 'nacre', pattern: '缠枝莲', position: '外壁', materialNote: '0.8mm 螺钿片，刻纹嵌贴', createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7 },
    { id: 'inlay_0201', bodyId: 'body_02', type: 'eggshell', pattern: '云纹', position: '盖面', materialNote: '鸭蛋壳拼贴后髹漆磨显', createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inlay_0301', bodyId: 'body_03', type: 'incisedGold', pattern: '折枝花', position: '通体', materialNote: '戗金，金粉入刻线', createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 12 },
    { id: 'inlay_0302', bodyId: 'body_03', type: 'goldTrace', pattern: '诗文', position: '外壁', materialNote: '描金，泥金细描', createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
  ];

  const inspects: Inspect[] = [
    { id: 'inspect_0101', bodyId: 'body_03', verdict: 'pass', defectNote: '', inspector: '周衡', date: '2026-03-02', defectCoatSeq: null, defectRoomId: null, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inspect_0102', bodyId: 'body_02', verdict: 'rework', defectNote: '起皱（荫干过快）', inspector: '周衡', date: '2026-03-08', defectCoatSeq: 2, defectRoomId: 'reading_0201', createdAt: now - 86400000, updatedAt: now - 86400000 },
  ];

  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(bodies);
    await db.coats.bulkPut(coats);
    await db.readings.bulkPut(readings);
    await db.stays.bulkPut(stays);
    await db.polishes.bulkPut(polishes);
    await db.inlays.bulkPut(inlays);
    await db.inspects.bulkPut(inspects);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface LacquerSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  bodies: Body[];
  coats: Coat[];
  readings: Reading[];
  stays: Stay[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
}

export async function exportSnapshot(): Promise<LacquerSnapshot> {
  const [bodies, coats, readings, stays, polishes, inlays, inspects] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.readings.toArray(),
    db.stays.toArray(),
    db.polishes.toArray(),
    db.inlays.toArray(),
    db.inspects.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bodies,
    coats,
    readings,
    stays,
    polishes,
    inlays,
    inspects,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过）；v2 备份（rooms）与 v3（readings/stays）均受理 */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<LacquerSnapshot> & { rooms?: unknown };
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof LacquerSnapshot> = ['bodies', 'coats', 'polishes', 'inlays', 'inspects'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  const hasV3 = Array.isArray(snapshot.readings) && Array.isArray(snapshot.stays);
  const hasV2 = Array.isArray(snapshot.rooms);
  if (!hasV3 && !hasV2) return '备份文件缺少 readings / stays 集合（或旧版 rooms 集合）';
  return '';
}

const READING_SOURCES: ReadonlyArray<ReadingSource> = ['logger', 'legacy'];
const STAY_SOURCES: ReadonlyArray<StaySource> = ['manager', 'legacy'];

/** 补全读数行可能缺失的 v3 字段（旧备份 / 跨版本导出） */
function normalizeReading(row: Partial<Reading> & { bodyId: string; id: string }): Reading {
  const now = Date.now();
  const verdict: EnvVerdict = LEGACY_VERDICTS.includes(row.verdict as EnvVerdict)
    ? (row.verdict as EnvVerdict)
    : 'suitable';
  return {
    date: typeof row.date === 'string' ? row.date : '',
    sampledAt: typeof row.sampledAt === 'string' ? row.sampledAt : '',
    tempC: typeof row.tempC === 'number' ? row.tempC : 24,
    humidityPct: typeof row.humidityPct === 'number' ? row.humidityPct : 75,
    source: READING_SOURCES.includes(row.source as ReadingSource) ? (row.source as ReadingSource) : 'logger',
    importBatch: typeof row.importBatch === 'string' ? row.importBatch : 'imported-v3',
    confirmed: typeof row.confirmed === 'boolean' ? row.confirmed : false,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now,
    ...row,
    // 展开后再兜底一次：非法 verdict 归一化为 suitable
    verdict: LEGACY_VERDICTS.includes(row.verdict as EnvVerdict) ? (row.verdict as EnvVerdict) : verdict,
  } as Reading;
}

/** 补全入出房行可能缺失的 v3 字段；备份还原按管理员已登记处理，默认认下 */
function normalizeStay(row: Partial<Stay> & { bodyId: string; id: string }): Stay {
  const now = Date.now();
  const source: StaySource = STAY_SOURCES.includes(row.source as StaySource) ? (row.source as StaySource) : 'manager';
  return {
    date: typeof row.date === 'string' ? row.date : '',
    inAt: typeof row.inAt === 'string' ? row.inAt : '09:00',
    outAt: typeof row.outAt === 'string' ? row.outAt : '21:00',
    confirmed: typeof row.confirmed === 'boolean' ? row.confirmed : true,
    note: typeof row.note === 'string' ? row.note : '',
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now,
    ...row,
    source,
  } as Stay;
}

/**
 * 归一化备份：v2 备份把 rooms 拆成 readings/stays 并补来源；
 * v3 备份逐行补全新字段。
 */
export function normalizeSnapshot(input: unknown): LacquerSnapshot {
  const snapshot = input as Partial<LacquerSnapshot> & { rooms?: LegacyRoom[] };
  let readings: Reading[];
  let stays: Stay[];
  if (Array.isArray(snapshot.rooms) && (!Array.isArray(snapshot.readings) || !Array.isArray(snapshot.stays))) {
    const split = splitLegacyRooms((snapshot.rooms ?? []) as LegacyRoom[]);
    readings = split.readings;
    stays = split.stays;
  } else {
    readings = (snapshot.readings ?? []).map((row) => normalizeReading(row as Partial<Reading> & { bodyId: string; id: string }));
    stays = (snapshot.stays ?? []).map((row) => normalizeStay(row as Partial<Stay> & { bodyId: string; id: string }));
  }
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: typeof snapshot.exportedAt === 'string' ? snapshot.exportedAt : new Date().toISOString(),
    bodies: snapshot.bodies ?? [],
    coats: snapshot.coats ?? [],
    readings,
    stays,
    polishes: snapshot.polishes ?? [],
    inlays: snapshot.inlays ?? [],
    inspects: snapshot.inspects ?? [],
  };
}

export async function importSnapshot(snapshot: LacquerSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(snapshot.bodies);
    await db.coats.bulkPut(snapshot.coats);
    await db.readings.bulkPut(snapshot.readings);
    await db.stays.bulkPut(snapshot.stays);
    await db.polishes.bulkPut(snapshot.polishes);
    await db.inlays.bulkPut(snapshot.inlays);
    await db.inspects.bulkPut(snapshot.inspects);
  });
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await Promise.all([
      db.bodies.clear(),
      db.coats.clear(),
      db.readings.clear(),
      db.stays.clear(),
      db.polishes.clear(),
      db.inlays.clear(),
      db.inspects.clear(),
    ]);
  });
}

/** 清空并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [bodies, coats, readings, stays, polishes, inlays, inspects] = await Promise.all([
    db.bodies.count(),
    db.coats.count(),
    db.readings.count(),
    db.stays.count(),
    db.polishes.count(),
    db.inlays.count(),
    db.inspects.count(),
  ]);
  return { bodies, coats, readings, stays, polishes, inlays, inspects };
}

/* ------------------------------ 级联删除 ------------------------------ */

export async function removeBodyCascade(bodyId: string): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.coats.where('bodyId').equals(bodyId).delete();
    await db.readings.where('bodyId').equals(bodyId).delete();
    await db.stays.where('bodyId').equals(bodyId).delete();
    await db.polishes.where('bodyId').equals(bodyId).delete();
    await db.inlays.where('bodyId').equals(bodyId).delete();
    await db.inspects.where('bodyId').equals(bodyId).delete();
    await db.bodies.delete(bodyId);
  });
}
