export const project = {
  "number": 9,
  "folder": "dfwl/frontend/dfwlfront-9",
  "framework": "vue",
  "title": "油品价格维护",
  "subtitle": "维护挂牌价、记录更新时间，并支持恢复默认价格。",
  "industry": "石油",
  "stack": [
    "Vue3",
    "Vite",
    "TypeScript",
    "Pinia",
    "Naive UI"
  ],
  "storageKey": "dfwlfront-9-price",
  "formTitle": "调整油品价格",
  "primaryAction": "保存价格",
  "entityLabel": "油品",
  "statuses": [
    "生效中",
    "待确认",
    "已回退"
  ],
  "filters": [
    "全部油品",
    "92号汽油",
    "95号汽油",
    "98号汽油",
    "柴油"
  ],
  "fields": [
    {
      "key": "fuel",
      "label": "油品",
      "type": "select",
      "options": [
        "92号汽油",
        "95号汽油",
        "98号汽油",
        "柴油"
      ]
    },
    {
      "key": "price",
      "label": "挂牌价",
      "type": "number"
    },
    {
      "key": "operator",
      "label": "操作员"
    },
    {
      "key": "effectiveDate",
      "label": "生效日期",
      "type": "date"
    }
  ],
  "records": [
    {
      "fuel": "92号汽油",
      "price": 7.62,
      "operator": "站长",
      "effectiveDate": "2026-06-30",
      "status": "生效中",
      "notes": "正常调价"
    },
    {
      "fuel": "柴油",
      "price": 7.18,
      "operator": "值班经理",
      "effectiveDate": "2026-06-30",
      "status": "待确认",
      "notes": "等待复核"
    }
  ],
  "metricLabels": [
    "调价记录",
    "待处理修订",
    "平均挂牌价(生效中)"
  ]
} as const;

export type FieldType = "number" | "date" | "select" | "text";

export interface FieldDef {
  key: string;
  label: string;
  type?: FieldType;
  options?: readonly string[];
}

export const fields = project.fields as readonly FieldDef[];

/** 可被编辑 / 参与冲突检测的字段（含备注） */
export const EDITABLE_KEYS = [...project.fields.map((f) => f.key), "notes"] as const;

export const FIELD_LABELS: Record<string, string> = Object.fromEntries([
  ...project.fields.map((f) => [f.key, f.label]),
  ["notes", "备注"],
  ["status", "状态"]
]);

export const statuses: string[] = [...project.statuses];

export const ACTIVE_STATUS = project.statuses[0]; // 生效中
