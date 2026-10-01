/** 调价记录：每次确认修改 version +1，作为乐观锁 */
export interface PriceRecord {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  notes: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type FieldValue = string | number;

/** 单字段改动：from 为提交人打开页面时看到的基线值 */
export interface FieldChange {
  from: FieldValue;
  to: FieldValue;
}

export type ChangeMap = Record<string, FieldChange>;

/**
 * 待处理修订：提交时基线版本已过期（另一窗口先保存）时生成，
 * 等值班经理确认后才并入有效价。
 */
export interface PendingRevision {
  id: string;
  recordId: string;
  /** 提交人打开编辑表单时的记录版本 */
  baseVersion: number;
  changes: ChangeMap;
  submittedBy: string;
  submittedAt: string;
}

/** 有效价快照：最后一次完整写入成功的一致状态，用于写失败恢复 */
export interface Snapshot {
  version: number;
  savedAt: string;
  records: PriceRecord[];
  revisions: PendingRevision[];
}

export interface PersistedState {
  records: PriceRecord[];
  revisions: PendingRevision[];
}

export interface SnapshotMeta {
  version: number;
  savedAt: string;
}
