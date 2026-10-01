import { ACTIVE_STATUS, statuses } from "./config";
import { project } from "./config";
import type {
  PersistedState,
  PriceRecord,
  Snapshot,
  SnapshotMeta
} from "./types";

const PREFIX = project.storageKey;

export const KEYS = {
  legacy: PREFIX,
  /** 主键：records + revisions 单键原子写入，写失败时旧值原样保留，不会撕裂 */
  state: `${PREFIX}:state`,
  /** 最后一个完整快照，主键损坏时从它恢复 */
  snapshot: `${PREFIX}:snapshot`,
  legacyBackup: `${PREFIX}:legacy-backup`
} as const;

export interface LoadResult {
  state: PersistedState;
  snapshotMeta: SnapshotMeta | null;
  migrated: boolean;
  recovered: boolean;
  notices: string[];
}

export interface CommitResult {
  ok: boolean;
  meta: SnapshotMeta | null;
}

function now(): string {
  return new Date().toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把任意来源（旧数据 / 种子 / 快照）的记录规范化为带版本的完整记录 */
export function normalizeRecord(raw: unknown, index: number): PriceRecord {
  const source = isObject(raw) ? raw : {};
  const createdAt = typeof source.createdAt === "string" && source.createdAt
    ? source.createdAt
    : new Date(Date.now() - index * 86400000).toISOString();
  const status = typeof source.status === "string" && statuses.includes(source.status)
    ? source.status
    : ACTIVE_STATUS;
  return {
    id: typeof source.id === "string" && source.id ? source.id : crypto.randomUUID(),
    fuel: typeof source.fuel === "string" ? source.fuel : "",
    price: Number(source.price) || 0,
    operator: typeof source.operator === "string" ? source.operator : "",
    effectiveDate: typeof source.effectiveDate === "string" ? source.effectiveDate : "",
    notes: typeof source.notes === "string" ? source.notes : "暂无备注",
    status,
    createdAt,
    updatedAt: typeof source.updatedAt === "string" && source.updatedAt ? source.updatedAt : createdAt,
    version: Number.isInteger(source.version) && (source.version as number) >= 1
      ? (source.version as number)
      : 1
  };
}

function isValidRecord(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.fuel === "string" &&
    typeof value.price === "number" &&
    typeof value.status === "string" &&
    Number.isInteger(value.version) &&
    (value.version as number) >= 1
  );
}

function isValidRevision(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.recordId === "string" &&
    Number.isInteger(value.baseVersion) &&
    isObject(value.changes) &&
    Object.values(value.changes).every(
      (change) => isObject(change) && "from" in change && "to" in change
    )
  );
}

function isValidSnapshot(value: unknown): value is Snapshot {
  if (!isObject(value)) return false;
  return (
    Number.isInteger(value.version) &&
    typeof value.savedAt === "string" &&
    Array.isArray(value.records) &&
    value.records.every(isValidRecord) &&
    Array.isArray(value.revisions) &&
    value.revisions.every(isValidRevision)
  );
}

function readSnapshotKey(key: string): Snapshot | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readSnapshot(): Snapshot | null {
  return readSnapshotKey(KEYS.snapshot);
}

function seedRecords(): PriceRecord[] {
  return project.records.map((record, index) => normalizeRecord(record, index));
}

/**
 * 旧数据迁移：老版本把记录数组直接存在 legacy 键里、没有版本号。
 * 首次打开时补齐 version/updatedAt，写入新键并生成首个快照，
 * 原始内容备份到 legacyBackup 后移除旧键。
 */
function migrateLegacy(notices: string[]): PersistedState | null {
  const raw = localStorage.getItem(KEYS.legacy);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 内容不可读时按无旧数据处理，不阻塞新流程
  }
  if (!Array.isArray(parsed)) return null;
  const records = parsed.map((item, index) => normalizeRecord(item, index));
  const state: PersistedState = { records, revisions: [] };
  const result = commit(state);
  if (!result.ok) return null;
  try {
    localStorage.setItem(KEYS.legacyBackup, raw);
    localStorage.removeItem(KEYS.legacy);
  } catch {
    /* 备份失败不影响迁移结果 */
  }
  notices.push(`已迁移 ${records.length} 条旧数据，并补齐版本号（v1）`);
  return state;
}

/**
 * 启动加载：迁移旧数据 → 读主键（损坏时回退到最后完整快照）→ 都没有则放种子数据。
 * 待处理修订随主键/快照一起保存，恢复后仍留在队列里可重试。
 */
export function loadState(): LoadResult {
  const notices: string[] = [];
  const migratedState = migrateLegacy(notices);
  if (migratedState) {
    const snapshot = readSnapshot();
    return {
      state: migratedState,
      snapshotMeta: snapshot ? { version: snapshot.version, savedAt: snapshot.savedAt } : null,
      migrated: true,
      recovered: false,
      notices
    };
  }

  const primary = readSnapshotKey(KEYS.state);
  if (primary) {
    return {
      state: { records: primary.records, revisions: primary.revisions },
      snapshotMeta: { version: primary.version, savedAt: primary.savedAt },
      migrated: false,
      recovered: false,
      notices
    };
  }

  const snapshot = readSnapshot();
  if (snapshot) {
    notices.push(`主数据读取失败，已从最后一个完整快照 v${snapshot.version} 恢复`);
    return {
      state: { records: snapshot.records, revisions: snapshot.revisions },
      snapshotMeta: { version: snapshot.version, savedAt: snapshot.savedAt },
      migrated: false,
      recovered: true,
      notices
    };
  }

  notices.push("未找到有效数据，已载入默认价格");
  return {
    state: { records: seedRecords(), revisions: [] },
    snapshotMeta: null,
    migrated: false,
    recovered: false,
    notices
  };
}

/**
 * 原子提交：把 records + revisions 作为整体先写主键（单键 setItem 要么成功、
 * 要么旧值原样保留），成功后再落一份到最后完整快照。
 * 主键写失败时持久层没有任何变化，调用方以持久化内容为准回滚内存即可；
 * 未完成的修订留在主键/快照里，恢复后可重试。
 */
export function commit(state: PersistedState): CommitResult {
  const previous = readSnapshotKey(KEYS.state) ?? readSnapshot();
  const snapshot: Snapshot = {
    version: (previous?.version ?? 0) + 1,
    savedAt: now(),
    records: state.records,
    revisions: state.revisions
  };
  const payload = JSON.stringify(snapshot);
  try {
    localStorage.setItem(KEYS.state, payload);
  } catch {
    return { ok: false, meta: null };
  }
  try {
    localStorage.setItem(KEYS.snapshot, payload);
  } catch {
    /* 主键已是最新一致状态，快照留待下次提交补齐 */
  }
  return { ok: true, meta: { version: snapshot.version, savedAt: snapshot.savedAt } };
}

/** 首次打开（无任何键）时写入种子数据与首个快照；迁移或已有数据时直接返回现有快照 */
export function ensureSeeded(result: LoadResult): Snapshot | null {
  const hasAnyKey = [KEYS.state, KEYS.snapshot].some((key) => localStorage.getItem(key) !== null);
  if (hasAnyKey) return readSnapshotKey(KEYS.state) ?? readSnapshot();
  const commitResult = commit(result.state);
  return commitResult.meta ? readSnapshotKey(KEYS.state) : null;
}
