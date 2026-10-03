# 漆器髹涂工序与荫房环境档案（gblacquer）

面向漆艺工作室工序管理员的本地化档案工具：把每件漆器的髹涂道次、荫干时长与打磨推光逐道记录，并同步留存荫房温湿度，作为漆层缺陷回溯依据。

核心动作：**登记胎体与器型 → 编排髹涂道次与漆种 → 记录仪读数与管理员入出房分账对账 → 登记打磨与推光 → 登记镶嵌纹饰 → 成品质检与导出**。

荫房记录按责任**分账**：温湿度读数只认值班员导入的记录仪文件，入出房时刻只认工序管理员每天手填的一条；两边按「胎体编号 + 日期」对账，缺一边的时段先挂「待确认」等人工核实；认下的荫干窗口内出现越界读数，该胎体没做完的髹涂道次挂「待复检」，已在打磨环节的道次退回「已涂」（打磨记录保留作凭据）。

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
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2、v2→v3 升级迁移（v3 荫房分账） |
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
| `/rooms` | 荫房记录 · 分账对账 | 三页签：对账总览（按胎体+日期配对，漏边挂待确认，认下窗口越界回写道次并打磨退回）、记录仪读数（值班员导入 CSV，失败可重试，只写读数分账）、入出房时刻（管理员每天手填一条） | Reading、Stay、Coat |
| `/polish` | 打磨与推光工序 | 按道次生成目数序列（320→2000），未打磨完的道次禁止进入下一道罩漆 | Polish、Coat |
| `/inlays` | 镶嵌纹饰登记 | 螺钿 / 蛋壳 / 描金 / 戗金登记与批量调整分类，器型示意区叠加显示 | Inlay、Body |
| `/export` | 成品质检与导出 | 质检登记（返工定位到具体道次与荫房记录）、返工清单、JSON 导入导出与清空重播种 | Inspect 及全部模型 |

`/` 与未匹配路径重定向到 `/bodies`。筛选条件写入 URL query（`?kw=&paintType=&state=` 等），刷新后条件保留，可直接分享链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Body 胎体 | `src/types/body.ts` | `id` `code` `material`（木/脱胎/金属） `shape`（碗/盘/盒/瓶） `sizeMm` `ownerName` `state`（待髹涂/髹涂中/待荫干/已完成） | 新建后进入道次编排，卡片回显进度与最近荫房 |
| Coat 髹涂道次 | `src/types/coat.ts` | `id` `bodyId` `seq` `paintType`（生漆/色漆/罩漆） `colorName` `coatDate` `thicknessUm` `state`（待涂/已涂/待打磨/已完成） `needRecheck` | 拖拽调序，同器型带出上次漆种与间隔建议 |
| Reading 记录仪读数 | `src/types/reading.ts` | `id` `bodyId` `date` `sampledAt` `tempC` `humidityPct` `verdict`（适宜/偏干/偏湿） `source`（记录仪/旧记录补登） `importBatch` `confirmed` | 温湿度只认记录仪导入；同胎体同日可多条，自然键幂等覆盖，重试导入不产生重复 |
| Stay 入出房记录 | `src/types/stay.ts` | `id` `bodyId` `date` `inAt` `outAt` `source`（管理员手填/旧记录补登） `confirmed` `note` | 出入房时刻只认管理员，同胎体每天仅一条；与读数按胎体+日期对账 |
| Polish 打磨推光 | `src/types/polish.ts` | `id` `bodyId` `seq` `grit` `method`（水砂/推光/揩清） `durationMin` `operator` | 按道次生成目数序列 |
| Inlay 镶嵌 | `src/types/inlay.ts` | `id` `bodyId` `type`（螺钿/蛋壳/描金/戗金） `pattern` `position` `materialNote` | 器型示意区叠加显示，支持批量改分类 |
| Inspect 质检 | `src/types/inspect.ts` | `id` `bodyId` `verdict`（合格/返工） `defectNote` `inspector` `date` `defectCoatSeq` `defectRoomId` | 返工定位到道次与荫房记录并生成返工清单 |

数据结构版本号 `DB_SCHEMA_VERSION` 定义在 `src/utils/db.ts`，当前为 `v3`：

- v1→v2：`coats` 表增加 `paintType` 索引，并在 Dexie `.upgrade()` 中为历史记录回填 `paintType = 'raw'`、`needRecheck = false`、`thicknessUm = 40`。
- v2→v3：荫房按责任分账，旧 `rooms` 表逐行**拆分**为 `readings`（温湿度，归记录仪）与 `stays`（出入房时刻，归管理员）两张表，两边都补登 `source = 'legacy'`、`importBatch = 'legacy-v3'` 与确认标记；读数保留原 `room_*` id，使旧质检记录的缺陷定位仍能命中。拆分完成后删除旧 `rooms` 表。导入 v2 旧备份时走同一套拆分逻辑（`normalizeSnapshot()`）。

**对账与越界规则**（`src/utils/reconciliation.ts` + `src/stores/roomSync.ts`）：

- 两边齐：读数落在入出房时段（支持跨夜）内才计入「认下的荫干窗口」；窗口外读数仅留痕不参与判定。
- 缺入出房 / 缺读数：时段挂「待确认」，可分别由值班员、管理员点核实认下；认下前**不**触发道次回写。
- 认下窗口取最不利读数（wet > dry > suitable），越界即把该胎体**没做完**（非「已完成」）的道次挂 `needRecheck`，其中「待打磨」道次退回「已涂」（打磨记录保留作凭据）。
- 记录仪导入在单个事务中只写 `readings`，按 `胎体+日期+时刻+温湿度` 自然键 upsert；文件读不出 / 表头不对时弹窗提示并可重试，任何失败都不会改动管理员那份 `stays`。

---

## 六、目录结构

```
sologsb101-1018/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # body.ts coat.ts reading.ts stay.ts polish.ts inlay.ts inspect.ts
│   │   ├── stores/               # bodyStore.ts coatStore.ts readingStore.ts stayStore.ts roomSync.ts
│   │   ├── components/common/    # StageTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
│   │   ├── hooks/                # useCoatProgress.ts useIdbTable.ts
│   │   ├── pages/                # BodyList.tsx CoatBoard.tsx RoomLog.tsx PolishBoard.tsx InlayBoard.tsx ExportView.tsx
│   │   ├── router/               # index.tsx
│   │   └── utils/                # humidity.ts reconciliation.ts loggerImport.ts db.ts export.ts
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

- **IndexedDB（Dexie，数据库名 `gblacquer`）**：7 张业务表 `bodies` / `coats` / `readings` / `stays` / `polishes` / `inlays` / `inspects`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 在首次打开时自动播种**三层互相引用**的演示数据（Body → Coat / Reading+Stay / Polish / Inlay → Inspect，固定 id 如 `body_01`、`coat_0101`，并含两边齐、窗口外读数、缺入出房、缺读数等待确认样例），播种幂等。
- **记录仪 CSV 格式**：首行表头 `胎体编号,日期,采样时刻,温度℃,相对湿度%`（兼容 code/date/time/temp/rh 等英文别名），页面可下载模板；同胎体同日多条采样，窗口判定只取入出房时段内的读数。
- **localStorage**：仅存元数据 —— `gblacquer:db-version`（本地结构版本）、`gblacquer:last-backup-at`（最近导出时间）、`gblacquer:ui-prefs`（当前选中胎体）。
- **备份**：`/export` 页可导出 JSON（7 张表全量数据 + 结构版本号），导入时校验 `app` 字段与各集合数组完整性，v2 旧备份（`rooms`）会自动拆分为 `readings` / `stays` 并补来源；覆盖导入前二次确认；另有返工清单 TXT 与工序台账 CSV（荫房列以认下对账窗口为口径）。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `tsc --noEmit`，必须零错误）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22818`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gblacquer` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
