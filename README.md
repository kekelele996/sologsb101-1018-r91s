# 漆器髹涂工序与荫房环境档案（gblacquer）

面向漆艺工作室工序管理员的本地化档案工具：把每件漆器的髹涂道次、荫干时长与打磨推光逐道记录，并同步留存荫房温湿度，作为漆层缺陷回溯依据。

核心动作：**登记胎体与器型 → 编排髹涂道次与漆种 → 记录荫房温湿度 → 登记打磨与推光 → 登记镶嵌纹饰 → 成品质检与导出**。

纯前端单页应用（React 18 + TypeScript + Ant Design + Vite + Zustand + React Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后依然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22818**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gblacquer}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/export` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18（函数组件 + Hooks） | 页面按路由懒加载 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `tsc --noEmit` 类型检查 |
| UI 组件库 | Ant Design 5（含 `@ant-design/icons`） | 表格、表单、对话框、拖拽排序、徽标 |
| 构建工具 | Vite 5 | 开发服务器端口 22818 |
| 状态管理 | Zustand 4 | `bodyStore` / `coatStore` / `roomStore` |
| 路由 | React Router 6（`createBrowserRouter`，history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2→v3 升级迁移（v3 荫房读数 / 出入房时刻拆表） |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22818
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22818）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/bodies` | 胎体与器型台账 | 新建胎体、按材质与器型筛选（同步 URL query），卡片回显已完成道次与最近荫房记录 | Body、Coat、Room |
| `/coats` | 髹涂道次编排 | 拖拽调整道次先后并重编号、批量改漆种与状态、同器型自动带出上次漆种与间隔建议 | Coat、Body |
| `/rooms` | 荫房记录对账 | 三个页签：对账总览（按胎体编号+日期配对，认下 / 待确认）、记录仪读数（温湿度，读不出可重试）、出入房时刻（管理员手填，每胎体每天一条）；认下窗口越界回写未做完道次为「待复检」并打磨退回，支持日期区间筛选 | RoomReading、RoomStay、Coat |
| `/polish` | 打磨与推光工序 | 按道次生成目数序列（320→2000），未打磨完的道次禁止进入下一道罩漆 | Polish、Coat |
| `/inlays` | 镶嵌纹饰登记 | 螺钿 / 蛋壳 / 描金 / 戗金登记与批量调整分类，器型示意区叠加显示 | Inlay、Body |
| `/export` | 成品质检与导出 | 质检登记（返工定位到具体道次与荫房记录）、返工清单、JSON 导入导出与清空重播种 | Inspect 及全部模型 |

`/` 与未匹配路径重定向到 `/bodies`。筛选条件写入 URL query（`?kw=&paintType=&state=` 等），刷新后条件保留，可直接分享链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Body 胎体 | `src/types/body.ts` | `id` `code` `material`（木/脱胎/金属） `shape`（碗/盘/盒/瓶） `sizeMm` `ownerName` `state`（待髹涂/髹涂中/待荫干/已完成） | 新建后进入道次编排，卡片回显进度与最近荫房 |
| Coat 髹涂道次 | `src/types/coat.ts` | `id` `bodyId` `seq` `paintType`（生漆/色漆/罩漆） `coatDate` `thicknessUm` `state`（待涂/已涂/待打磨/已完成） `needRecheck` | 拖拽调序；认下的荫干窗口越界时未做完道次挂待复检、已涂道次打磨退回「待打磨」 |
| RoomReading 记录仪读数 | `src/types/room.ts` | `id` `bodyId` `date` `tempC` `humidityPct` `verdict` `source`（logger/legacy） `officer` | 温湿度只认值班员记录仪；读取失败按有限次数重试，失败不清空已有读数 |
| RoomStay 出入房时刻 | `src/types/room.ts` | `id` `bodyId` `date` `inAt` `outAt` `source`（manager/legacy） `manager` | 入房/出房时刻只认工序管理员手填，每胎体每天一条，重复保存只更新不新增，与读数互不顶掉 |
| Polish 打磨推光 | `src/types/polish.ts` | `id` `bodyId` `seq` `grit` `method`（水砂/推光/揩清） `durationMin` `operator` | 按道次生成目数序列；挂待复检的道次禁止直接完成打磨 |
| Inlay 镶嵌 | `src/types/inlay.ts` | `id` `bodyId` `type`（螺钿/蛋壳/描金/戗金） `pattern` `position` `materialNote` | 器型示意区叠加显示，支持批量改分类 |
| Inspect 质检 | `src/types/inspect.ts` | `id` `bodyId` `verdict`（合格/返工） `defectNote` `defectCoatSeq` `defectRoomId` | 返工定位到道次与荫房**记录仪读数** |

**荫房对账规则（`src/utils/reconcile.ts`）**：读数与时刻按「胎体编号 + 日期」配对。两侧齐全才**认下荫干窗口**（matched）；只有一侧的时段挂**待确认**（pending）并标明缺侧（缺读数 / 缺出入房时刻），暂不回写道次。只有认下窗口的读数越界（偏干 / 偏湿）才回写该胎体未做完的道次；补齐另一侧后自动重新对账。一天有多条读数时按最不利一档合并判读。

数据结构版本号 `DB_SCHEMA_VERSION` 定义在 `src/utils/db.ts`，当前为 `v3`。版本演进：

- `v1 → v2`：`coats` 表增加 `paintType` 索引，历史记录回填 `paintType = 'raw'`、`needRecheck = false`、`thicknessUm = 40`。
- `v2 → v3`：`rooms` 单表拆为 `room_readings`（记录仪读数）与 `room_stays`（出入房时刻）两张表。旧 `rooms` 在升级事务中**一条拆两条**写入，两侧均补 `source = 'legacy'`（旧版合并记录），质检单引用的旧 room id 改写为 `reading_` 前缀；旧表用 `rooms: null` 显式物理删除。导入 v2 旧备份 JSON 时走同一套拆分逻辑。

---

## 六、目录结构

```
sologsb101-1018/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # body.ts coat.ts room.ts polish.ts inlay.ts inspect.ts
│   │   ├── stores/               # bodyStore.ts coatStore.ts roomStore.ts
│   │   ├── components/common/    # StageTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
│   │   ├── hooks/                # useCoatProgress.ts useIdbTable.ts
│   │   ├── pages/                # BodyList.tsx CoatBoard.tsx RoomLog.tsx PolishBoard.tsx InlayBoard.tsx ExportView.tsx
│   │   ├── router/               # index.tsx
│   │   ├── utils/                # humidity.ts reconcile.ts retry.ts db.ts export.ts
│   │   ├── styles/               # main.css
│   │   ├── App.tsx main.tsx
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面只读 Zustand store，跨页状态不留在组件内部 `useState`；IndexedDB 读写统一走 `useIdbTable()` 封装；筛选派生逻辑统一走 store 导出的选择器函数。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gblacquer`）**：7 张业务表 `bodies` / `coats` / `roomReadings` / `roomStays` / `polishes` / `inlays` / `inspects`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 在首次打开时自动播种**三层互相引用**的演示数据（Body → Coat / RoomReading+RoomStay → Polish / Inlay / Inspect，固定 id 如 `body_01`、`coat_0101`），播种幂等。荫房读数与出入房时刻分表存储，各带 `source` 来源字段（`logger` 记录仪 / `manager` 管理员 / `legacy` 旧版合并记录）。
- **localStorage**：仅存元数据 —— `gblacquer:db-version`（本地结构版本）、`gblacquer:last-backup-at`（最近导出时间）、`gblacquer:ui-prefs`（当前选中胎体）。
- **备份**：`/export` 页可导出 JSON（7 张表全量数据 + 结构版本号），导入时校验 `app` 字段与各集合数组完整性，v2 旧备份（`rooms` 单表）会自动拆成读数 + 时刻并补 `legacy` 来源，覆盖导入前二次确认；另有返工清单 TXT 与工序台账 CSV（台账并列输出记录仪温湿度与管理员出入房时刻、来源与对账状态）。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `tsc --noEmit`，必须零错误）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22818`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gblacquer` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
