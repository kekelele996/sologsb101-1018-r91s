/**
 * /rooms 荫房记录（分账 + 对账）
 * 温湿度读数认记录仪（值班员导入，失败可重试），入出房时刻认管理员（每天手填一条）；
 * 两边按「胎体编号 + 日期」对账，漏的时段先挂着等确认；
 * 认下的荫干窗口出现越界读数，没做完的道次挂待复检，已在打磨的退回已涂。
 * 消费 Reading、Stay、Coat；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileSearchOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useReadingStore, type LoggerImportSummary } from '@/stores/readingStore';
import { useStayStore, StayDuplicateError } from '@/stores/stayStore';
import {
  ENV_VERDICT_COLOR,
  ENV_VERDICT_LABEL,
  ENV_VERDICT_OPTIONS,
  READING_SOURCE_LABEL,
  type EnvVerdict,
  type Reading,
} from '@/types/reading';
import {
  STAY_SOURCE_LABEL,
  createEmptyStayDraft,
  type Stay,
  type StayDraft,
} from '@/types/stay';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { dewPoint, dryingAdvice, rangeHint, roomStayHours } from '@/utils/humidity';
import {
  RECONCILE_STATUS_COLOR,
  RECONCILE_STATUS_LABEL,
  countOverWindows,
  countPending,
  reconcile,
  type ReconcileStatus,
  type ReconcileWindow,
} from '@/utils/reconciliation';
import { LOGGER_CSV_TEMPLATE, LoggerFileError, parseLoggerCsv } from '@/utils/loggerImport';
import { download } from '@/utils/export';

const FILTER_KEYS = ['verdict', 'rstatus'] as const;

const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: ReconcileStatus; label: string }> = [
  { value: 'matched', label: RECONCILE_STATUS_LABEL.matched },
  { value: 'readingOnly', label: RECONCILE_STATUS_LABEL.readingOnly },
  { value: 'stayOnly', label: RECONCILE_STATUS_LABEL.stayOnly },
];

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'verdict', label: '窗口判定', options: ENV_VERDICT_OPTIONS },
  {
    key: 'rstatus',
    label: '对账状态',
    options: STATUS_FILTER_OPTIONS.map((item) => ({ value: item.value, label: item.label })),
  },
];

function describeSync(sync: { recheckCoats: number; polishRolledBack: number }): string {
  const parts: string[] = [];
  if (sync.recheckCoats > 0) parts.push(`${sync.recheckCoats} 个未完道次挂待复检`);
  if (sync.polishRolledBack > 0) parts.push(`${sync.polishRolledBack} 个道次打磨退回（打磨记录保留）`);
  return parts.length > 0 ? parts.join('，') : '';
}

export default function RoomLog() {
  const { message } = AntdApp.useApp();
  const [stayForm] = Form.useForm<StayDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const readings = useReadingStore((state) => state.readings);
  const importLoggerRows = useReadingStore((state) => state.importLoggerRows);
  const confirmDay = useReadingStore((state) => state.confirmDay);
  const removeReading = useReadingStore((state) => state.removeReading);
  const stays = useStayStore((state) => state.stays);
  const createStay = useStayStore((state) => state.createStay);
  const updateStay = useStayStore((state) => state.updateStay);
  const removeStay = useStayStore((state) => state.removeStay);
  const confirmStay = useStayStore((state) => state.confirmStay);

  const fileRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState('reconcile');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [stayOpen, setStayOpen] = useState(false);
  const [editingStay, setEditingStay] = useState<Stay | null>(null);

  // 记录仪文件读不出：错误弹窗中可重试（重新选择文件）；解析阶段不写任何数据
  const [fileError, setFileError] = useState<{ name: string; detail: string } | null>(null);

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;
  const bodyOptions = bodies.map((body) => ({
    value: body.id,
    label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
  }));

  const windows = useMemo(() => reconcile(readings, stays), [readings, stays]);

  const url = useFilterQuery(FILTER_KEYS);

  const filteredWindows = useMemo(() => {
    const keyword = url.keyword.trim();
    const verdicts = url.values.verdict ?? [];
    const statuses = (url.values.rstatus ?? []) as ReconcileStatus[];
    return windows.filter((window) => {
      if (keyword.length > 0) {
        const haystack = `${bodyCode(window.bodyId)}${window.date}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (statuses.length > 0 && !statuses.includes(window.status)) return false;
      if (verdicts.length > 0) {
        if (!window.verdict || !verdicts.includes(window.verdict)) return false;
      }
      if (dateFrom.length > 0 && window.date < dateFrom) return false;
      if (dateTo.length > 0 && window.date > dateTo) return false;
      return true;
    });
    // bodyCode 依赖 bodies，reconcile 结果体 id 稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windows, url.keyword, url.values, dateFrom, dateTo, bodies]);

  const stat = useMemo(() => {
    const acknowledged = windows.filter((window) => window.acknowledged);
    return {
      total: windows.length,
      matched: windows.filter((window) => window.status === 'matched').length,
      pending: countPending(windows),
      over: countOverWindows(windows),
      acknowledgedSuitable: acknowledged.filter((window) => window.verdict === 'suitable').length,
    };
  }, [windows]);

  /* ------------------------------ 记录仪导入 ------------------------------ */

  const openFilePicker = (): void => fileRef.current?.click();

  const handleLoggerFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setFileError({ name: file.name, detail: '文件读不出（可能未传完或已损坏），请重传记录仪文件。' });
      return;
    }
    try {
      const parsed = parseLoggerCsv(text, file.name);
      if (bodies.length === 0) {
        setFileError({ name: file.name, detail: '还没有胎体台账，无法按编号对账，请先登记胎体后重试。' });
        return;
      }
      let summary: LoggerImportSummary;
      try {
        summary = await importLoggerRows(parsed.rows, bodies, parsed.batch);
      } catch (error) {
        setFileError({
          name: file.name,
          detail: `写入本地库失败：${error instanceof Error ? error.message : '未知错误'}，管理员那份入出房记录未受影响，可重试。`,
        });
        return;
      }
      const tail = describeSync(summary.sync);
      if (summary.imported + summary.updated === 0) {
        message.warning('全部行均未导入（编号未登记或数据无效），管理员记录未受影响');
      } else if (summary.skipped.length > 0) {
        message.warning(
          `导入 ${summary.imported} 条、覆盖 ${summary.updated} 条；跳过 ${summary.skipped.length} 行（见对账页提示）${tail ? `；${tail}` : ''}`,
        );
      } else {
        message.success(
          `记录仪读数已导入 ${summary.imported} 条、覆盖 ${summary.updated} 条${tail ? `；${tail}` : '；待确认时段未回写道次'}`,
        );
      }
      setActiveTab('reconcile');
    } catch (error) {
      const detail = error instanceof LoggerFileError ? error.message : '记录仪文件解析失败，请确认是按模板导出的 CSV。';
      setFileError({ name: file.name, detail });
    }
  };

  const downloadTemplate = (): void => {
    download('记录仪导入模板.csv', `﻿${LOGGER_CSV_TEMPLATE}`, 'text/csv;charset=utf-8');
    message.success('已下载记录仪导入模板');
  };

  /* ------------------------------ 入出房手填 ------------------------------ */

  const openCreateStay = (): void => {
    const bodyId = bodies[0]?.id ?? '';
    if (!bodyId) {
      message.warning('请先在胎体台账中登记胎体');
      return;
    }
    setEditingStay(null);
    stayForm.setFieldsValue(createEmptyStayDraft(bodyId));
    setStayOpen(true);
  };

  const openEditStay = (stay: Stay): void => {
    setEditingStay(stay);
    stayForm.setFieldsValue({
      bodyId: stay.bodyId,
      date: stay.date,
      inAt: stay.inAt,
      outAt: stay.outAt,
      source: stay.source,
      confirmed: stay.confirmed,
      note: stay.note,
    });
    setStayOpen(true);
  };

  const submitStay = async (): Promise<void> => {
    const values = await stayForm.validateFields();
    try {
      if (editingStay) {
        const sync = await updateStay(editingStay.id, values);
        const tail = describeSync(sync);
        message.success(`已更新入出房记录${tail ? `；${tail}` : ''}`);
      } else {
        const { sync } = await createStay(values);
        const tail = describeSync(sync);
        message.success(`已登记 ${values.date} 入出房时刻${tail ? `；${tail}` : '；缺读数时先挂待确认'}`);
      }
      setStayOpen(false);
    } catch (error) {
      if (error instanceof StayDuplicateError) {
        message.error(error.message);
        return;
      }
      throw error;
    }
  };

  const confirmReadingDay = async (window: ReconcileWindow): Promise<void> => {
    const sync = await confirmDay(window.bodyId, window.date);
    if (!sync) return;
    const tail = describeSync(sync);
    message.success(`值班员已核实当天读数${tail ? `；${tail}` : '；窗口认下，读数在适宜区间'}`);
  };

  const confirmStayOnly = async (window: ReconcileWindow): Promise<void> => {
    if (!window.stay) return;
    const sync = await confirmStay(window.stay.id);
    message.success(`管理员已核实该时段${describeSync(sync) ? `；${describeSync(sync)}` : '；窗口认下'}`);
  };

  /* ------------------------------ 表格列 ------------------------------ */

  const reconcileColumns: ColumnsType<ReconcileWindow> = [
    { title: '日期', dataIndex: 'date', width: 110, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 120,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    {
      title: '对账状态',
      dataIndex: 'status',
      width: 110,
      render: (value: ReconcileStatus) => (
        <Tag color={RECONCILE_STATUS_COLOR[value]}>{RECONCILE_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '入出房（管理员）',
      key: 'stay',
      width: 150,
      render: (_v, record) =>
        record.stay ? (
          <Space direction="vertical" size={0}>
            <span>
              {record.stay.inAt} ~ {record.stay.outAt}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.stayHours} 小时 · {STAY_SOURCE_LABEL[record.stay.source]}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">缺入出房，挂账等确认</Typography.Text>
        ),
    },
    {
      title: '窗口读数（记录仪）',
      key: 'readings',
      render: (_v, record) =>
        record.readings.length === 0 ? (
          <Typography.Text type="secondary">缺记录仪读数，挂账等确认</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            <Space size={4} wrap>
              {record.readings.map((row) => {
                const inside = record.windowReadings.some((item) => item.id === row.id);
                return (
                  <Tag
                    key={row.id}
                    color={inside ? ENV_VERDICT_COLOR[row.verdict] : 'default'}
                    style={inside ? undefined : { opacity: 0.45 }}
                  >
                    {row.sampledAt || '时刻缺'} {row.tempC}℃/{row.humidityPct}%
                    {inside ? '' : '（窗口外）'}
                  </Tag>
                );
              })}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {record.readings.length} 条，窗口内 {record.windowReadings.length} 条
            </Typography.Text>
          </Space>
        ),
    },
    {
      title: '认下窗口判定',
      dataIndex: 'verdict',
      width: 130,
      render: (value: EnvVerdict | null, record) => {
        if (!record.acknowledged) return <Tag color="default">待确认</Tag>;
        if (value === null) return <Tag>已认下（无读数）</Tag>;
        return (
          <Space direction="vertical" size={0}>
            <Tag color={ENV_VERDICT_COLOR[value]}>{ENV_VERDICT_LABEL[value]}</Tag>
            {record.over ? (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                越界→道次待复检
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_v, record) => {
        if (record.acknowledged) {
          return (
            <Button size="small" type="link" onClick={() => setActiveTab(record.stay ? 'stays' : 'readings')}>
              查看来源
            </Button>
          );
        }
        if (record.status === 'readingOnly') {
          return (
            <Button size="small" type="link" icon={<CheckCircleOutlined />} onClick={() => void confirmReadingDay(record)}>
              值班员核实读数
            </Button>
          );
        }
        return (
          <Button size="small" type="link" icon={<CheckCircleOutlined />} onClick={() => void confirmStayOnly(record)}>
            管理员核实时段
          </Button>
        );
      },
    },
  ];

  const readingColumns: ColumnsType<Reading> = [
    { title: '日期', dataIndex: 'date', width: 110, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 120,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    { title: '采样时刻', dataIndex: 'sampledAt', width: 100, render: (value: string) => value || '时刻缺（旧记录）' },
    { title: '温度', dataIndex: 'tempC', width: 90, render: (value: number) => `${value} ℃` },
    { title: '湿度', dataIndex: 'humidityPct', width: 90, render: (value: number) => `${value} %` },
    {
      title: '判定 / 露点',
      dataIndex: 'verdict',
      width: 160,
      render: (value: EnvVerdict, record) => (
        <Space size={4} wrap>
          <Tag color={ENV_VERDICT_COLOR[value]}>{ENV_VERDICT_LABEL[value]}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            露点 {dewPoint(record.tempC, record.humidityPct)}℃
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '来源 / 批次',
      key: 'source',
      render: (_v, record) => (
        <Space direction="vertical" size={0}>
          <Tag>{READING_SOURCE_LABEL[record.source]}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.importBatch}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '核实状态',
      dataIndex: 'confirmed',
      width: 110,
      render: (value: boolean) => (value ? <Tag color="success">已核实</Tag> : <Tag>待对账</Tag>),
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_v, record) => (
        <Popconfirm
          title="删除该记录仪读数"
          description="只影响读数分账，入出房记录不会被改动。"
          okText="确认"
          cancelText="取消"
          onConfirm={() =>
            void removeReading(record.id).then((sync) => {
              message.success('已删除读数');
              const tail = describeSync(sync);
              if (tail) message.info(tail);
            })
          }
        >
          <Button size="small" type="link" danger icon={<DeleteOutlined />}>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const stayColumns: ColumnsType<Stay> = [
    { title: '日期', dataIndex: 'date', width: 120, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 120,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    { title: '入房', dataIndex: 'inAt', width: 90 },
    { title: '出房', dataIndex: 'outAt', width: 90 },
    {
      title: '在房时长',
      key: 'stay',
      width: 100,
      render: (_v, record) => `${roomStayHours(record.inAt, record.outAt)} 小时`,
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 120,
      render: (value: Stay['source']) => <Tag>{STAY_SOURCE_LABEL[value]}</Tag>,
    },
    {
      title: '对账',
      key: 'matched',
      width: 120,
      render: (_v, record) => {
        const hasReading = readings.some((row) => row.bodyId === record.bodyId && row.date === record.date);
        if (hasReading) return <Tag color="success">两边齐</Tag>;
        return record.confirmed ? <Tag color="processing">已核实（缺读数）</Tag> : <Tag color="warning">缺读数·待确认</Tag>;
      },
    },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'action',
      width: 170,
      render: (_v, record) => (
        <Space size={4} wrap>
          {!record.confirmed && !readings.some((row) => row.bodyId === record.bodyId && row.date === record.date) ? (
            <Button size="small" type="link" icon={<CheckCircleOutlined />} onClick={() => void confirmStay(record.id)}>
              核实
            </Button>
          ) : null}
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditStay(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该入出房记录"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void removeStay(record.id).then((sync) => {
                message.success('已删除入出房记录');
                const tail = describeSync(sync);
                if (tail) message.info(tail);
              })
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const overWindows = windows.filter((window) => window.over);

  const reconcileTab = (
    <div>
      <div className="gb-stat-row">
        <StatBadge label="对账窗口" value={stat.total} suffix="个" tone="primary" />
        <StatBadge label="两边齐" value={stat.matched} suffix="个" tone="success" />
        <StatBadge label="待确认时段" value={stat.pending} suffix="个" tone="warning" />
        <StatBadge label="认下窗口越界" value={stat.over} suffix="个" tone="danger" />
        <StatBadge label="认下且适宜" value={stat.acknowledgedSuitable} suffix="个" tone="info" />
        <StatBadge label="记录仪读数" value={readings.length} suffix="条" />
      </div>

      {stat.pending > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${stat.pending} 个时段漏边挂账：缺入出房时刻或缺记录仪读数，核实认下前不回写道次`}
          description="温湿度认记录仪、出入房时刻认管理员；请两边核对后在对应行点「核实」。"
        />
      ) : (
        <Alert type="success" showIcon style={{ marginBottom: 14 }} message="所有时段两边齐或已核实，无挂账" />
      )}
      {overWindows.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`${overWindows
            .map((window) => `${bodyCode(window.bodyId)} ${window.date}（${ENV_VERDICT_LABEL[window.verdict ?? 'suitable']}）`)
            .join('；')}`}
          description="认下荫干窗口内出现越界读数：该胎体没做完的髹涂道次已挂待复检，待打磨的道次退回已涂（打磨记录保留作凭据）。"
        />
      ) : null}

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
          setDateFrom('');
          setDateTo('');
        }}
        keywordPlaceholder="搜索编号 / 日期…"
        actions={
          <Space size={6} wrap>
            <Input type="date" size="small" style={{ width: 150 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <Typography.Text type="secondary">至</Typography.Text>
            <Input type="date" size="small" style={{ width: 150 }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {windows.length === 0 ? (
          <EmptyPanel
            title="还没有任何荫房记录"
            description="值班员在「记录仪读数」页签导入温湿度 CSV，管理员在「入出房时刻」页签每天手填一条，两边在此按胎体+日期自动对账。"
            actionText="导入记录仪读数"
            onAction={() => {
              setActiveTab('readings');
              openFilePicker();
            }}
            secondaryText="手填入出房"
            onSecondary={() => setActiveTab('stays')}
            size="small"
          />
        ) : filteredWindows.length === 0 ? (
          <EmptyPanel title="当前条件下没有对账窗口" description="试着调整对账状态、判定或日期区间。" size="small" />
        ) : (
          <Table<ReconcileWindow>
            rowKey={(row) => `${row.bodyId}_${row.date}`}
            size="small"
            pagination={{ pageSize: 8 }}
            columns={reconcileColumns}
            dataSource={filteredWindows}
          />
        )}
      </Card>
    </div>
  );

  const readingsTab = (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="温湿度读数只认记录仪"
        description={
          <Space direction="vertical" size={2}>
            <span>
              导入记录仪 CSV（表头：胎体编号,日期,采样时刻,温度℃,相对湿度%）。同一读数重复导入按自然键覆盖，可放心重试；导入只写读数分账，管理员的入出房记录不会被顶掉。
            </span>
            <span>{rangeHint()}</span>
          </Space>
        }
      />
      <Space wrap style={{ marginBottom: 14 }}>
        <Button type="primary" icon={<CloudUploadOutlined />} onClick={openFilePicker}>
          导入记录仪文件
        </Button>
        <Button icon={<DownloadOutlined />} onClick={downloadTemplate}>
          下载 CSV 模板
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          style={{ display: 'none' }}
          onChange={(event) => void handleLoggerFile(event)}
        />
      </Space>
      <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
        {readings.length === 0 ? (
          <EmptyPanel
            title="还没有记录仪读数"
            description="把记录仪导出的 CSV 交给值班员导入；文件读不出或表头不对时会弹窗提示，可直接重试选择文件。"
            actionText="导入记录仪文件"
            onAction={openFilePicker}
            size="small"
          />
        ) : (
          <Table<Reading> rowKey="id" size="small" pagination={{ pageSize: 9 }} columns={readingColumns} dataSource={readings} />
        )}
      </Card>
    </div>
  );

  const staysTab = (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="入出房时刻只认工序管理员：每天手填一条"
        description="与记录仪读数按胎体+日期对账；缺读数的时段先挂「待确认」，核实后可手动认下。记录仪重复导入不会改动本页记录。"
      />
      <Card
        className="gb-table-card"
        styles={{ body: { padding: 0 } }}
        title="入出房时刻（管理员手填）"
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreateStay}>
            新增入出房
          </Button>
        }
      >
        {stays.length === 0 ? (
          <EmptyPanel
            title="还没有入出房记录"
            description="每天入荫房时由管理员登记入房与出房时刻，同胎体同一天仅一条。"
            actionText="新增入出房"
            onAction={openCreateStay}
            size="small"
          />
        ) : (
          <Table<Stay> rowKey="id" size="small" pagination={{ pageSize: 9 }} columns={stayColumns} dataSource={stays} />
        )}
      </Card>

      <Modal
        open={stayOpen}
        title={editingStay ? `编辑 ${editingStay.date} 入出房记录` : '新增入出房记录（管理员）'}
        onCancel={() => setStayOpen(false)}
        onOk={() => void submitStay()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={stayForm} layout="vertical" preserve={false} initialValues={{ source: 'manager' }}>
          <Form.Item name="bodyId" label="关联胎体" rules={[{ required: true, message: '请选择胎体' }]}>
            <Select options={bodyOptions} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="inAt" label="入房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
            <Form.Item name="outAt" label="出房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注（值班交接等）">
            <Input placeholder="如：跨夜续荫" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dryingAdvice(24, 75, 40)}
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>荫房记录 · 分账对账</h2>
          <p>温湿度读数认记录仪，入出房时刻认管理员；按胎体编号 + 日期对账，漏的时段挂待确认，认下窗口越界即回写道次并打磨退回。</p>
        </div>
        <Space>
          <Button icon={<FileSearchOutlined />} onClick={() => setActiveTab('reconcile')}>
            对账总览
          </Button>
          <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => {
            setActiveTab('readings');
            openFilePicker();
          }}>
            导入记录仪
          </Button>
        </Space>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'reconcile', label: '对账总览', children: reconcileTab },
          { key: 'readings', label: `记录仪读数（${readings.length}）`, children: readingsTab },
          { key: 'stays', label: `入出房时刻（${stays.length}）`, children: staysTab },
        ]}
      />

      {/* 记录仪文件读不出/解析失败：弹窗可重试，任何阶段都未写入 stays */}
      <Modal
        open={fileError !== null}
        title={
          <Space>
            <FileSearchOutlined />
            记录仪文件读取失败
          </Space>
        }
        onCancel={() => setFileError(null)}
        footer={[
          <Button key="cancel" onClick={() => setFileError(null)}>
            取消
          </Button>,
          <Button
            key="retry"
            type="primary"
            onClick={() => {
              setFileError(null);
              openFilePicker();
            }}
          >
            重试，重新选择文件
          </Button>,
        ]}
      >
        {fileError ? (
          <Space direction="vertical" size={6}>
            <Typography.Text strong>{fileError.name}</Typography.Text>
            <Typography.Text type="secondary">{fileError.detail}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本次未写入任何数据，管理员那份入出房记录保持原样。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
