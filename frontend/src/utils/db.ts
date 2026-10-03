/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑：
 *   v1 → v2：Coat 增加 paintType 索引并回填历史记录
 *   v2 → v3：荫房记录按责任拆分为 room_readings（记录仪读数）与 room_stays（管理员出入房时刻），
 *            旧 rooms 记录一条拆成两条并补出来源 legacy
 * - 七张业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import type { RoomReading, RoomStay } from '@/types/room';
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

/** v2 及更早的荫房合并记录，仅升级迁移时使用 */
interface LegacyRoom {
  id: string;
  bodyId: string;
  date: string;
  tempC: number;
  humidityPct: number;
  inAt: string;
  outAt: string;
  verdict: RoomReading['verdict'];
  createdAt?: number;
  updatedAt?: number;
}

/** 旧合并记录一条拆两条：读数 + 时刻，两侧均补来源 legacy（升级与旧备份导入共用） */
function splitLegacyRoom(
  room: LegacyRoom,
): { reading: RoomReading; stay: RoomStay } {
  const createdAt = room.createdAt ?? Date.now();
  const updatedAt = room.updatedAt ?? createdAt;
  return {
    reading: {
      id: `reading_${room.id}`,
      bodyId: room.bodyId,
      date: room.date,
      tempC: room.tempC,
      humidityPct: room.humidityPct,
      verdict: room.verdict,
      source: 'legacy',
      officer: '',
      createdAt,
      updatedAt,
    },
    stay: {
      id: `stay_${room.id}`,
      bodyId: room.bodyId,
      date: room.date,
      inAt: room.inAt,
      outAt: room.outAt,
      source: 'legacy',
      manager: '',
      createdAt,
      updatedAt,
    },
  };
}

class LacquerDatabase extends Dexie {
  bodies!: Table<Body, string>;
  coats!: Table<Coat, string>;
  roomReadings!: Table<RoomReading, string>;
  roomStays!: Table<RoomStay, string>;
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
    });

    // v3：荫房记录拆分为「记录仪读数」与「管理员出入房时刻」两张表；
    // 旧 rooms 表必须用 rooms: null 显式标记删除（仅从 stores 省略会因 v1/v2 并集被保留）。
    // 升级回调里仍可通过 tx.table('rooms') 读旧表数据：一条拆两条写入新表，两侧均补来源 legacy。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
        // 复合索引 [bodyId+date] 供按胎体编号加日期对账
        roomReadings: 'id, bodyId, date, verdict, source, [bodyId+date], updatedAt',
        roomStays: 'id, bodyId, date, source, [bodyId+date], updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
        rooms: null,
      })
      .upgrade(async (tx) => {
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            const legal: PaintType[] = ['raw', 'color', 'topcoat'];
            if (!legal.includes(coat.paintType)) coat.paintType = 'raw';
            if (typeof coat.needRecheck !== 'boolean') coat.needRecheck = false;
            if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
          });

        const legacyRooms = await tx.table<LegacyRoom>('rooms').toArray();
        if (legacyRooms.length > 0) {
          const split = legacyRooms.map(splitLegacyRoom);
          await tx.table<RoomReading>('roomReadings').bulkPut(split.map((item) => item.reading));
          await tx.table<RoomStay>('roomStays').bulkPut(split.map((item) => item.stay));
          // 质检单引用的旧 room id 改指向拆分后的读数 id（reading_ 前缀）
          const legacyRoomIds = new Set(legacyRooms.map((room) => room.id));
          await tx
            .table<Inspect>('inspects')
            .toCollection()
            .modify((inspect) => {
              if (inspect.defectRoomId && legacyRoomIds.has(inspect.defectRoomId)) {
                inspect.defectRoomId = `reading_${inspect.defectRoomId}`;
              }
            });
        }
      });
  }
}

export const db = new LacquerDatabase();

/** 七张业务表清单，事务中统一引用 */
const TABLE_LIST = [
  db.bodies,
  db.coats,
  db.roomReadings,
  db.roomStays,
  db.polishes,
  db.inlays,
  db.inspects,
];

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
/* 三层互相引用：Body →（Coat / RoomReading / RoomStay / Polish / Inlay）→ Inspect，id 固定便于深链命中 */

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

  const coats: Coat[] = [
    { id: 'coat_0101', bodyId: 'body_01', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'done', needRecheck: false, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 10 },
    { id: 'coat_0102', bodyId: 'body_01', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06', thicknessUm: 45, state: 'toPolish', needRecheck: true, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0103', bodyId: 'body_01', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12', thicknessUm: 30, state: 'todo', needRecheck: false, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'coat_0201', bodyId: 'body_02', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 35, state: 'done', needRecheck: false, createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 7 },
    { id: 'coat_0202', bodyId: 'body_02', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-08', thicknessUm: 42, state: 'coated', needRecheck: true, createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'coat_0301', bodyId: 'body_03', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10', thicknessUm: 38, state: 'done', needRecheck: false, createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 25 },
    { id: 'coat_0302', bodyId: 'body_03', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18', thicknessUm: 44, state: 'done', needRecheck: false, createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 18 },
    { id: 'coat_0303', bodyId: 'body_03', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26', thicknessUm: 28, state: 'done', needRecheck: false, createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 4 },
  ];

  // 记录仪读数：温湿度认记录仪（值班员赵勤）；room_0102 为偏干越界样本
  const roomReadings: RoomReading[] = [
    { id: 'reading_0101', bodyId: 'body_01', date: '2026-03-03', tempC: 24, humidityPct: 78, verdict: 'suitable', source: 'logger', officer: '赵勤', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'reading_0102', bodyId: 'body_01', date: '2026-03-07', tempC: 27, humidityPct: 56, verdict: 'dry', source: 'logger', officer: '赵勤', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'reading_0201', bodyId: 'body_02', date: '2026-03-05', tempC: 23, humidityPct: 91, verdict: 'wet', source: 'logger', officer: '赵勤', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'reading_0301', bodyId: 'body_03', date: '2026-02-20', tempC: 25, humidityPct: 76, verdict: 'suitable', source: 'logger', officer: '赵勤', createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
    // 只有读数、管理员尚未补出入房时刻：对账挂「待确认」
    { id: 'reading_0103', bodyId: 'body_01', date: '2026-03-09', tempC: 25, humidityPct: 80, verdict: 'suitable', source: 'logger', officer: '赵勤', createdAt: now - 86400000 * 3, updatedAt: now - 86400000 * 3 },
  ];

  // 管理员出入房时刻：入房出房时刻认管理员（管理员孙茂）
  const roomStays: RoomStay[] = [
    { id: 'stay_0101', bodyId: 'body_01', date: '2026-03-03', inAt: '09:00', outAt: '21:00', source: 'manager', manager: '孙茂', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'stay_0102', bodyId: 'body_01', date: '2026-03-07', inAt: '08:30', outAt: '20:00', source: 'manager', manager: '孙茂', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'stay_0201', bodyId: 'body_02', date: '2026-03-05', inAt: '10:00', outAt: '22:30', source: 'manager', manager: '孙茂', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'stay_0301', bodyId: 'body_03', date: '2026-02-20', inAt: '09:30', outAt: '21:30', source: 'manager', manager: '孙茂', createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
    // 只有时刻、记录仪读数未导入：对账挂「待确认」
    { id: 'stay_0202', bodyId: 'body_02', date: '2026-03-09', inAt: '09:15', outAt: '21:10', source: 'manager', manager: '孙茂', createdAt: now - 86400000 * 3, updatedAt: now - 86400000 * 3 },
  ];

  const polishes: Polish[] = [
    { id: 'polish_0101', bodyId: 'body_01', seq: 1, grit: 600, method: 'water', durationMin: 35, operator: '王丽', createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 9 },
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
    await db.roomReadings.bulkPut(roomReadings);
    await db.roomStays.bulkPut(roomStays);
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
  /** v3：记录仪读数（旧备份导入时可能缺失，按空集合处理） */
  roomReadings: RoomReading[];
  /** v3：管理员出入房时刻（旧备份导入时可能缺失，按空集合处理） */
  roomStays: RoomStay[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
  /** v2 及更早备份中的荫房合并记录，仅导入兼容使用 */
  rooms?: LegacyRoom[];
}

export async function exportSnapshot(): Promise<LacquerSnapshot> {
  const [bodies, coats, roomReadings, roomStays, polishes, inlays, inspects] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.roomReadings.toArray(),
    db.roomStays.toArray(),
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
    roomReadings,
    roomStays,
    polishes,
    inlays,
    inspects,
  };
}

/**
 * 校验导入文件结构，返回错误文案（空串表示通过）。
 * 荫房两类记录在 v3 才出现，v2 旧备份允许缺失，导入时按旧 rooms 拆分升级。
 */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<LacquerSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof LacquerSnapshot> = ['bodies', 'coats', 'polishes', 'inlays', 'inspects'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  const hasSplitRooms = Array.isArray(snapshot.roomReadings) && Array.isArray(snapshot.roomStays);
  if (!hasSplitRooms && !Array.isArray(snapshot.rooms)) {
    return '备份文件缺少 roomReadings / roomStays（或旧版 rooms）集合';
  }
  return '';
}

/** 把旧版合并荫房记录拆成读数 + 时刻，两侧补出来源 legacy */
function splitLegacyRooms(rooms: LegacyRoom[]): { readings: RoomReading[]; stays: RoomStay[] } {
  const split = rooms.map(splitLegacyRoom);
  return {
    readings: split.map((item) => item.reading),
    stays: split.map((item) => item.stay),
  };
}

export async function importSnapshot(snapshot: LacquerSnapshot): Promise<void> {
  const roomReadings = Array.isArray(snapshot.roomReadings) ? snapshot.roomReadings : [];
  const roomStays = Array.isArray(snapshot.roomStays) ? snapshot.roomStays : [];
  // v2 及更早备份：导入时同样一条拆两条并补出来源；质检单的旧 room id 改指向读数 id
  const legacy = Array.isArray(snapshot.rooms) ? splitLegacyRooms(snapshot.rooms) : { readings: [], stays: [] };
  const legacyIdMap = new Map(legacy.readings.map((reading) => [reading.id.replace(/^reading_/, ''), reading.id]));
  const inspects = snapshot.inspects.map((inspect) =>
    inspect.defectRoomId && legacyIdMap.has(inspect.defectRoomId)
      ? { ...inspect, defectRoomId: legacyIdMap.get(inspect.defectRoomId) as string }
      : inspect,
  );

  await clearAllTables();
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(snapshot.bodies);
    await db.coats.bulkPut(snapshot.coats);
    await db.roomReadings.bulkPut([...roomReadings, ...legacy.readings]);
    await db.roomStays.bulkPut([...roomStays, ...legacy.stays]);
    await db.polishes.bulkPut(snapshot.polishes);
    await db.inlays.bulkPut(snapshot.inlays);
    await db.inspects.bulkPut(inspects);
  });
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await Promise.all([
      db.bodies.clear(),
      db.coats.clear(),
      db.roomReadings.clear(),
      db.roomStays.clear(),
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
  const [bodies, coats, roomReadings, roomStays, polishes, inlays, inspects] = await Promise.all([
    db.bodies.count(),
    db.coats.count(),
    db.roomReadings.count(),
    db.roomStays.count(),
    db.polishes.count(),
    db.inlays.count(),
    db.inspects.count(),
  ]);
  return { bodies, coats, roomReadings, roomStays, polishes, inlays, inspects };
}

/* ------------------------------ 级联删除 ------------------------------ */

export async function removeBodyCascade(bodyId: string): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.coats.where('bodyId').equals(bodyId).delete();
    await db.roomReadings.where('bodyId').equals(bodyId).delete();
    await db.roomStays.where('bodyId').equals(bodyId).delete();
    await db.polishes.where('bodyId').equals(bodyId).delete();
    await db.inlays.where('bodyId').equals(bodyId).delete();
    await db.inspects.where('bodyId').equals(bodyId).delete();
    await db.bodies.delete(bodyId);
  });
}
