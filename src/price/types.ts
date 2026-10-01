// 调价记录 / 有效价快照 / 待处理修订共享的数据模型。

export const FUELS = ["92号汽油", "95号汽油", "98号汽油", "柴油"] as const;
export type Fuel = (typeof FUELS)[number];

export type FieldValue = string | number;
export type PriceValues = Record<string, FieldValue>;

export const SCHEMA_VERSION = 1;

/** 待处理修订的生命周期。 */
export type RevisionStatus =
  | "pending" // 已提交，等待值班经理确认
  | "needs_recheck" // 另一窗口改了同一油品，基线已过期，需要重新确认
  | "conflict" // 同一字段两边都改过，等待逐字段裁决
  | "approved" // 经理已确认，已并入有效价
  | "rolled_back"; // 已回退

export type RevisionStatusLabel =
  | "待确认"
  | "需重新确认"
  | "字段冲突"
  | "已生效"
  | "已回退";

export const REVISION_STATUS_LABEL: Record<RevisionStatus, RevisionStatusLabel> = {
  pending: "待确认",
  needs_recheck: "需重新确认",
  conflict: "字段冲突",
  approved: "已生效",
  rolled_back: "已回退",
};

/** 有效价快照：每次经理确认后生成一份完整快照，版本号单调递增。 */
export interface EffectiveSnapshot {
  version: number;
  /** 按油品索引的完整有效价，v1 起每个油品一条。 */
  prices: Record<string, PriceValues>;
  author: string;
  note: string;
  /** 生成该快照所确认的修订 id，迁移初始快照为 "migration"。 */
  revisionId: string;
  createdAt: string;
}

/** 冲突字段的裁决方式。 */
export type ResolutionChoice = "mine" | "theirs" | "custom";

export interface FieldConflict {
  field: string;
  label: string;
  /** 当前窗口修订里的值。 */
  mine: FieldValue;
  /** 已并入有效价（同伴）的值。 */
  theirs: FieldValue;
  choice: ResolutionChoice;
  /** choice 为 custom 时使用的覆盖值，始终以字符串承载输入。 */
  custom?: string;
}

/** 待处理修订：提交时带上打开页面时的基线版本。 */
export interface PendingRevision {
  id: string;
  fuel: string;
  /** 仅包含本修订改动的字段。 */
  changes: PriceValues;
  operator: string;
  note: string;
  /** 打开页面（或最后一次同步）时的基线版本，乐观并发令牌。 */
  baseVersion: number;
  status: RevisionStatus;
  createdAt: string;
  /** 重新确认后的新基线版本（仅 needs_recheck/conflict 使用）。 */
  rebasedTo?: number;
  /** 冲突字段裁决，仅在 status === "conflict" 后由经理填写。 */
  conflicts?: FieldConflict[];
  /** 最近一次状态判定结果说明。 */
  recheckReason?: string;
}

export type AuditKind =
  | "migration"
  | "submit"
  | "approve"
  | "rollback"
  | "restore";

/** 调价记录（审计流水），只追加，不修改。 */
export interface PriceAuditEntry {
  id: string;
  kind: AuditKind;
  fuel: string;
  changes: PriceValues;
  operator: string;
  note: string;
  /** 该条目对应的新有效价版本；提交修订时尚未确认为 null。 */
  effectiveVersion: number | null;
  revisionId: string | null;
  createdAt: string;
}

export type RetryAction = "submit" | "confirm" | "rollback";

/** 写入失败后仍未完成的修订，保留下来等待重试。 */
export interface RetryItem {
  id: string;
  action: RetryAction;
  revisionId?: string;
  /** action === "submit" 时，保存当时要提交的修订草稿。 */
  draft?: PendingRevision;
  /** action === "confirm"/"rollback" 时保存的修订，恢复后可重新挂回队列。 */
  revision?: PendingRevision;
  /** action === "confirm" 时保存裁决结果，避免重试时丢失。 */
  resolutions?: FieldConflict[];
  attempts: number;
  lastError: string;
  createdAt: string;
}

/** localStorage 中的完整文档。 */
export interface PriceDoc {
  schemaVersion: number;
  version: number;
  effective: EffectiveSnapshot;
  snapshots: EffectiveSnapshot[];
  pending: PendingRevision[];
  audit: PriceAuditEntry[];
  retries: RetryItem[];
}

export interface IngestResult {
  changed: boolean;
  /** 本次同步看到的新版本号（无变化时为 null）。 */
  newVersion: number | null;
}

/** 修订与当前有效价之间的差异分析结果。 */
export interface RevisionAnalysis {
  status: RevisionStatus;
  /** 相对当前有效价，仍然有差异、需要应用的字段。 */
  staleFields: string[];
  /** 同一字段两边都改过，需要并排裁决的字段。 */
  overlappingFields: string[];
  reason: string;
}
