/**
 * /rooms 荫房记录（v3：两份数据分开）
 * - 记录仪读数：温湿度认记录仪（值班员登记，读不出可重试）。
 * - 出入房时刻：入房出房认管理员（每天手填一条，与读数互不顶掉）。
 * - 对账总览：两边按胎体编号 + 日期配对，两侧齐了认下荫干窗口；缺一侧的时段挂待确认。
 *   认下窗口出现越界读数时，该胎体未做完的道次挂待复检、打磨退回。
 * 消费 RoomReading、RoomStay、Coat；复用 <FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  CloudUploadOutlined,
  FieldTimeOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useRoomStore } from '@/stores/roomStore';
import { reconcileRoomWindows, type ReconciledWindow } from '@/utils/reconcile';
import {
  RECONCILE_MISSING_LABEL,
  RECONCILE_STATUS_COLOR,
  RECONCILE_STATUS_LABEL,
  ROOM_SOURCE_COLOR,
  ROOM_SOURCE_LABEL,
  ROOM_VERDICT_COLOR,
  ROOM_VERDICT_LABEL,
  ROOM_VERDICT_OPTIONS,
  createEmptyReadingDraft,
  createEmptyStayDraft,
  type RoomReading,
  type RoomReadingDraft,
  type RoomStay,
  type RoomStayDraft,
} from '@/types/room';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { dewPoint, dryingAdvice, judgeVerdict, roomStayHours } from '@/utils/humidity';

const FILTER_KEYS = ['verdict', 'reconcile'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'verdict', label: '判定', options: ROOM_VERDICT_OPTIONS },
  {
    key: 'reconcile',
    label: '对账',
    multiple: false,
    options: [
      { value: 'matched', label: '已认下' },
      { value: 'pending', label: '待确认' },
    ],
  },
];

export default function RoomLog() {
  const { message } = AntdApp.useApp();
  const [readingForm] = Form.useForm<RoomReadingDraft>();
  const [stayForm] = Form.useForm<RoomStayDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const readings = useRoomStore((state) => state.readings);
  const stays = useRoomStore((state) => state.stays);
  const readingsError = useRoomStore((state) => state.readingsError);
  const readingsLoading = useRoomStore((state) => state.readingsLoading);
  const createReading = useRoomStore((state) => state.createReading);
  const updateReading = useRoomStore((state) => state.updateReading);
  const removeReading = useRoomStore((state) => state.removeReading);
  const upsertStay = useRoomStore((state) => state.upsertStay);
  const removeStay = useRoomStore((state) => state.removeStay);
  const retryLoadReadings = useRoomStore((state) => state.retryLoadReadings);

  const url = useFilterQuery(FILTER_KEYS);
  const [activeTab, setActiveTab] = useState<'overview' | 'readings' | 'stays'>('overview');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [readingOpen, setReadingOpen] = useState(false);
  const [editingReading, setEditingReading] = useState<RoomReading | null>(null);
  const [draftTemp, setDraftTemp] = useState(24);
  const [draftHumidity, setDraftHumidity] = useState(75);

  const [stayOpen, setStayOpen] = useState(false);
  const [editingStay, setEditingStay] = useState<RoomStay | null>(null);

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;

  const windows = useMemo(() => reconcileRoomWindows(readings, stays), [readings, stays]);

  const filteredWindows = useMemo(() => {
    const keyword = url.keyword.trim();
    const verdicts = url.values.verdict ?? [];
    const reconcile = url.values.reconcile ?? [];
    return windows.filter((window) => {
      if (keyword.length > 0) {
        const haystack = `${bodyCode(window.bodyId)}${window.date}${window.readings
          .map((item) => `${item.tempC}${item.humidityPct}`)
          .join('')}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (reconcile.length > 0 && !reconcile.includes(window.status)) return false;
      if (verdicts.length > 0 && (window.verdict === null || !verdicts.includes(window.verdict))) return false;
      if (dateFrom.length > 0 && window.date < dateFrom) return false;
      if (dateTo.length > 0 && window.date > dateTo) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windows, url.keyword, url.values, dateFrom, dateTo, bodies]);

  const filteredReadings = useMemo(() => {
    const keyword = url.keyword.trim();
    return readings.filter((reading) => {
      if (keyword.length > 0 && !`${bodyCode(reading.bodyId)}${reading.date}${reading.tempC}${reading.humidityPct}`.includes(keyword)) {
        return false;
      }
      if (dateFrom.length > 0 && reading.date < dateFrom) return false;
      if (dateTo.length > 0 && reading.date > dateTo) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readings, url.keyword, dateFrom, dateTo, bodies]);

  const filteredStays = useMemo(() => {
    const keyword = url.keyword.trim();
    return stays.filter((stay) => {
      if (keyword.length > 0 && !`${bodyCode(stay.bodyId)}${stay.date}${stay.inAt}${stay.outAt}`.includes(keyword)) {
        return false;
      }
      if (dateFrom.length > 0 && stay.date < dateFrom) return false;
      if (dateTo.length > 0 && stay.date > dateTo) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stays, url.keyword, dateFrom, dateTo, bodies]);

  const stat = useMemo(() => {
    const matched = windows.filter((window) => window.status === 'matched').length;
    const pending = windows.length - matched;
    const breached = windows.filter((window) => window.breached).length;
    return { matched, pending, breached };
  }, [windows]);

  /* --------------------------- 记录仪读数弹窗 --------------------------- */

  const openCreateReading = (preset?: { bodyId: string; date: string }): void => {
    const bodyId = preset?.bodyId ?? bodies[0]?.id ?? '';
    if (!bodyId) {
      message.warning('请先在胎体台账中登记胎体');
      return;
    }
    setEditingReading(null);
    const draft = createEmptyReadingDraft(bodyId);
    if (preset?.date) draft.date = preset.date;
    setDraftTemp(draft.tempC);
    setDraftHumidity(draft.humidityPct);
    readingForm.setFieldsValue(draft);
    setReadingOpen(true);
  };

  const openEditReading = (reading: RoomReading): void => {
    setEditingReading(reading);
    setDraftTemp(reading.tempC);
    setDraftHumidity(reading.humidityPct);
    readingForm.setFieldsValue({
      bodyId: reading.bodyId,
      date: reading.date,
      tempC: reading.tempC,
      humidityPct: reading.humidityPct,
      source: reading.source,
      officer: reading.officer,
    });
    setReadingOpen(true);
  };

  const submitReading = async (): Promise<void> => {
    const values = await readingForm.validateFields();
    if (editingReading) {
      await updateReading(editingReading.id, values);
      message.success(`已更新 ${values.date} 的记录仪读数`);
    } else {
      await createReading(values);
      const window = useRoomStore
        .getState()
        .windowsOfBody(values.bodyId)
        .find((item) => item.date === values.date);
      if (window?.status === 'pending') {
        message.warning('读数已登记；管理员出入房时刻未补，该时段先挂待确认，暂不回写道次');
      } else if (window?.breached) {
        message.warning(`判定${ROOM_VERDICT_LABEL[window.verdict as 'dry' | 'wet']}，窗口已认下：未做完道次挂待复检、打磨退回`);
      } else {
        message.success('记录仪读数已登记，窗口已认下，环境适宜');
      }
    }
    setReadingOpen(false);
  };

  /* --------------------------- 管理员时刻弹窗 --------------------------- */

  const openCreateStay = (preset?: { bodyId: string; date: string }): void => {
    const bodyId = preset?.bodyId ?? bodies[0]?.id ?? '';
    if (!bodyId) {
      message.warning('请先在胎体台账中登记胎体');
      return;
    }
    setEditingStay(null);
    const draft = createEmptyStayDraft(bodyId);
    if (preset?.date) draft.date = preset.date;
    stayForm.setFieldsValue(draft);
    setStayOpen(true);
  };

  const openEditStay = (stay: RoomStay): void => {
    setEditingStay(stay);
    stayForm.setFieldsValue({
      bodyId: stay.bodyId,
      date: stay.date,
      inAt: stay.inAt,
      outAt: stay.outAt,
      source: stay.source,
      manager: stay.manager,
    });
    setStayOpen(true);
  };

  const submitStay = async (): Promise<void> => {
    const values = await stayForm.validateFields();
    await upsertStay(values, editingStay?.id);
    if (!editingStay) {
      const window = useRoomStore
        .getState()
        .windowsOfBody(values.bodyId)
        .find((item) => item.date === values.date);
      if (window?.status === 'pending') {
        message.warning('出入房时刻已登记；记录仪读数未到，该时段先挂待确认，暂不回写道次');
      } else if (window?.breached) {
        message.warning(`对账认下且读数${ROOM_VERDICT_LABEL[window.verdict as 'dry' | 'wet']}：未做完道次挂待复检、打磨退回`);
      } else {
        message.success('出入房时刻已登记，与记录仪读数对账认下');
      }
    } else {
      message.success(`已更新 ${values.date} 的出入房时刻`);
    }
    setStayOpen(false);
  };

  const handleRetryReadings = async (): Promise<void> => {
    const ok = await retryLoadReadings();
    if (ok) message.success('记录仪读数已重新读取');
    else message.error('记录仪读数仍读不出，请检查本地数据后再重试');
  };

  /* ------------------------------- 列定义 ------------------------------- */

  const verdictTag = (window: ReconciledWindow) =>
    window.verdict ? (
      <Space size={4} wrap>
        <Tag color={ROOM_VERDICT_COLOR[window.verdict]}>{ROOM_VERDICT_LABEL[window.verdict]}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          露点 {dewPoint(window.readings[0]?.tempC ?? 0, window.readings[0]?.humidityPct ?? 0)}℃
        </Typography.Text>
      </Space>
    ) : (
      <Tag>无读数</Tag>
    );

  const overviewColumns: ColumnsType<ReconciledWindow> = [
    { title: '日期', dataIndex: 'date', width: 110, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 110,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    {
      title: '记录仪温度',
      key: 'temp',
      width: 90,
      render: (_v, record) =>
        record.readings[0] ? `${record.readings[0].tempC} ℃` : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '记录仪湿度',
      key: 'humidity',
      width: 90,
      render: (_v, record) =>
        record.readings[0] ? `${record.readings[0].humidityPct} %` : <Typography.Text type="secondary">—</Typography.Text>,
    },
    { title: '判定', key: 'verdict', width: 150, render: (_v, record) => verdictTag(record) },
    {
      title: '入房',
      key: 'inAt',
      width: 80,
      render: (_v, record) => record.stay?.inAt ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '出房',
      key: 'outAt',
      width: 80,
      render: (_v, record) => record.stay?.outAt ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '在房时长',
      key: 'stay',
      width: 100,
      render: (_v, record) =>
        record.stay ? `${roomStayHours(record.stay.inAt, record.stay.outAt)} 小时` : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '对账状态',
      key: 'status',
      width: 170,
      render: (_v, record) => (
        <Space size={4} wrap>
          <Tag color={RECONCILE_STATUS_COLOR[record.status]}>{RECONCILE_STATUS_LABEL[record.status]}</Tag>
          {record.missing ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {RECONCILE_MISSING_LABEL[record.missing]}
            </Typography.Text>
          ) : record.breached ? (
            <Tooltip title="认下窗口越界，未做完的道次已挂待复检、打磨退回">
              <Tag color="error">越界已回写</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_v, record) =>
        record.status === 'pending' ? (
          record.missing === 'stay' ? (
            <Button size="small" type="link" icon={<FieldTimeOutlined />} onClick={() => openCreateStay({ bodyId: record.bodyId, date: record.date })}>
              补出入房时刻
            </Button>
          ) : (
            <Button size="small" type="link" icon={<CloudUploadOutlined />} onClick={() => openCreateReading({ bodyId: record.bodyId, date: record.date })}>
              补记录仪读数
            </Button>
          )
        ) : (
          <Space size={0}>
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => record.readings[0] && openEditReading(record.readings[0])}>
              读数
            </Button>
            {record.stay ? (
              <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditStay(record.stay as RoomStay)}>
                时刻
              </Button>
            ) : null}
          </Space>
        ),
    },
  ];

  const readingColumns: ColumnsType<RoomReading> = [
    { title: '日期', dataIndex: 'date', width: 110, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 110,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    { title: '温度', dataIndex: 'tempC', width: 80, render: (value: number) => `${value} ℃` },
    { title: '湿度', dataIndex: 'humidityPct', width: 80, render: (value: number) => `${value} %` },
    {
      title: '判定',
      dataIndex: 'verdict',
      width: 100,
      render: (value: RoomReading['verdict'], record) => (
        <Tooltip title={dryingAdvice(record.tempC, record.humidityPct, 40)}>
          <Tag color={ROOM_VERDICT_COLOR[value]}>{ROOM_VERDICT_LABEL[value]}</Tag>
        </Tooltip>
      ),
    },
    { title: '值班员', dataIndex: 'officer', width: 90, render: (value: string) => value || '未填写' },
    {
      title: '来源',
      dataIndex: 'source',
      width: 120,
      render: (value: RoomReading['source']) => <Tag color={ROOM_SOURCE_COLOR[value]}>{ROOM_SOURCE_LABEL[value]}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditReading(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该记录仪读数"
            description="删除后该时段可能转为待确认，待复检回写会重算。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeReading(record.id).then(() => message.success('已删除读数'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const stayColumns: ColumnsType<RoomStay> = [
    { title: '日期', dataIndex: 'date', width: 110, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 110,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    { title: '入房', dataIndex: 'inAt', width: 90 },
    { title: '出房', dataIndex: 'outAt', width: 90 },
    {
      title: '在房时长',
      key: 'stayHours',
      width: 100,
      render: (_v, record) => `${roomStayHours(record.inAt, record.outAt)} 小时`,
    },
    { title: '管理员', dataIndex: 'manager', width: 90, render: (value: string) => value || '未填写' },
    {
      title: '来源',
      dataIndex: 'source',
      width: 120,
      render: (value: RoomStay['source']) => <Tag color={ROOM_SOURCE_COLOR[value]}>{ROOM_SOURCE_LABEL[value]}</Tag>,
    },
    {
      title: '对账',
      key: 'reconcile',
      width: 110,
      render: (_v, record) =>
        readings.some((reading) => reading.bodyId === record.bodyId && reading.date === record.date) ? (
          <Tag color={RECONCILE_STATUS_COLOR.matched}>{RECONCILE_STATUS_LABEL.matched}</Tag>
        ) : (
          <Tooltip title={RECONCILE_MISSING_LABEL.reading}>
            <Tag color={RECONCILE_STATUS_COLOR.pending}>待确认</Tag>
          </Tooltip>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditStay(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该出入房时刻"
            description="删除后该时段可能转为待确认，待复检回写会重算。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeStay(record.id).then(() => message.success('已删除时刻'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const bodyOptions = bodies.map((body) => ({
    value: body.id,
    label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
  }));

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>荫房记录 · 读数与时刻分开对账</h2>
          <p>
            温湿度认值班员记录仪，入房出房时刻认工序管理员；两边按胎体编号 + 日期对账，缺一侧先挂待确认。
            认下窗口越界时，未做完的道次挂待复检、打磨退回。
          </p>
        </div>
        <Space wrap>
          <Button icon={<CloudUploadOutlined />} onClick={() => openCreateReading()}>
            登记记录仪读数
          </Button>
          <Button type="primary" icon={<FieldTimeOutlined />} onClick={() => openCreateStay()}>
            填出入房时刻
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="记录仪读数" value={readings.length} suffix="条" tone="info" />
        <StatBadge label="出入房时刻" value={stays.length} suffix="条" tone="primary" />
        <StatBadge label="已认下窗口" value={stat.matched} suffix="个" tone="success" />
        <StatBadge label="待确认时段" value={stat.pending} suffix="个" tone="warning" />
        <StatBadge label="认下越界" value={stat.breached} suffix="次" tone="danger" />
      </div>

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
        keywordPlaceholder="搜索编号 / 日期 / 温湿度…"
        actions={
          <Space size={6} wrap>
            <Input type="date" size="small" style={{ width: 150 }} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            <Typography.Text type="secondary">至</Typography.Text>
            <Input type="date" size="small" style={{ width: 150 }} value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 16 } }}>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as typeof activeTab)}
          items={[
            {
              key: 'overview',
              label: `对账总览（${windows.length}）`,
              children:
                filteredWindows.length === 0 ? (
                  <EmptyPanel
                    title={windows.length === 0 ? '还没有荫房记录' : '当前条件下没有对账窗口'}
                    description={
                      windows.length === 0
                        ? '值班员登记记录仪读数、管理员每天填一条出入房时刻，两侧按胎体编号 + 日期自动对账。'
                        : '试着调整对账状态、判定或日期区间。'
                    }
                    actionText="登记记录仪读数"
                    onAction={() => openCreateReading()}
                    secondaryText="填出入房时刻"
                    onSecondary={() => openCreateStay()}
                    size="small"
                  />
                ) : (
                  <Table<ReconciledWindow>
                    rowKey="key"
                    size="small"
                    pagination={{ pageSize: 8 }}
                    columns={overviewColumns}
                    dataSource={filteredWindows}
                  />
                ),
            },
            {
              key: 'readings',
              label: `记录仪读数（${readings.length}）`,
              children: (
                <>
                  {readingsError ? (
                    <Alert
                      type="error"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={`记录仪读数读不出：${readingsError}`}
                      description="值班员可重试读取；管理员填写的出入房时刻不受影响，仍可正常登记。"
                      action={
                        <Button size="small" danger icon={<ReloadOutlined />} loading={readingsLoading} onClick={() => void handleRetryReadings()}>
                          重试读取
                        </Button>
                      }
                    />
                  ) : null}
                  {filteredReadings.length === 0 ? (
                    <EmptyPanel
                      title="还没有记录仪读数"
                      description="温湿度以记录仪为准；读不出时可点上方重试，已有读数不会被清空。"
                      actionText="登记记录仪读数"
                      onAction={() => openCreateReading()}
                      size="small"
                    />
                  ) : (
                    <Table<RoomReading>
                      rowKey="id"
                      size="small"
                      pagination={{ pageSize: 8 }}
                      columns={readingColumns}
                      dataSource={filteredReadings}
                      loading={readingsLoading}
                    />
                  )}
                </>
              ),
            },
            {
              key: 'stays',
              label: `出入房时刻（${stays.length}）`,
              children:
                filteredStays.length === 0 ? (
                  <EmptyPanel
                    title="管理员还没填出入房时刻"
                    description="入房 / 出房时刻以管理员手填为准，每个胎体每天一条；与记录仪读数分开保存，互不顶掉。"
                    actionText="填出入房时刻"
                    onAction={() => openCreateStay()}
                    size="small"
                  />
                ) : (
                  <Table<RoomStay> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={stayColumns} dataSource={filteredStays} />
                ),
            },
          ]}
        />
      </Card>

      {/* 记录仪读数弹窗 */}
      <Modal
        open={readingOpen}
        title={editingReading ? `编辑 ${editingReading.date} 的记录仪读数` : '登记记录仪读数'}
        onCancel={() => setReadingOpen(false)}
        onOk={() => void submitReading()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form
          form={readingForm}
          layout="vertical"
          preserve={false}
          onValuesChange={(changed) => {
            if (typeof changed.tempC === 'number') setDraftTemp(changed.tempC);
            if (typeof changed.humidityPct === 'number') setDraftHumidity(changed.humidityPct);
          }}
        >
          <Form.Item name="bodyId" label="关联胎体" rules={[{ required: true, message: '请选择胎体' }]}>
            <Select options={bodyOptions} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="记录日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="officer" label="值班员" style={{ flex: 1 }}>
              <Input placeholder="如：赵勤" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="tempC" label="温度（℃，记录仪）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={5} max={45} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="humidityPct" label="湿度（%，记录仪）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="source" hidden>
            <Input />
          </Form.Item>
          <Space direction="vertical" size={2}>
            <Tag color={ROOM_VERDICT_COLOR[judgeVerdict(draftTemp, draftHumidity)]}>
              实时判定：{ROOM_VERDICT_LABEL[judgeVerdict(draftTemp, draftHumidity)]}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              露点约 {dewPoint(draftTemp, draftHumidity)}℃ · {dryingAdvice(draftTemp, draftHumidity, 40)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              温湿度只认记录仪；若当天管理员时刻未填，该读数先挂待确认，不回写道次。
            </Typography.Text>
          </Space>
        </Form>
      </Modal>

      {/* 管理员出入房时刻弹窗 */}
      <Modal
        open={stayOpen}
        title={editingStay ? `编辑 ${editingStay.date} 的出入房时刻` : '登记出入房时刻（管理员）'}
        onCancel={() => setStayOpen(false)}
        onOk={() => void submitStay()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={stayForm} layout="vertical" preserve={false}>
          <Form.Item name="bodyId" label="关联胎体" rules={[{ required: true, message: '请选择胎体' }]}>
            <Select options={bodyOptions} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="manager" label="工序管理员" style={{ flex: 1 }}>
              <Input placeholder="如：孙茂" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="inAt" label="入房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
            <Form.Item name="outAt" label="出房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
          </Space>
          <Form.Item name="source" hidden>
            <Input />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            入房 / 出房时刻只认管理员手填，每个胎体每天一条，重复保存只更新不新增；记录仪读数读不出时本页照常保存。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
