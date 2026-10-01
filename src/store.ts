import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { ACTIVE_STATUS, EDITABLE_KEYS, statuses } from "./config";
import { commit, ensureSeeded, KEYS, loadState } from "./storage";
import type {
  ChangeMap,
  FieldValue,
  PendingRevision,
  PriceRecord,
  SnapshotMeta
} from "./types";

export interface Notice {
  id: number;
  kind: "info" | "warn" | "error";
  text: string;
}

/** 编辑表单提交时携带的基线信息：打开页面那一刻的版本与字段值 */
export interface EditBaseline {
  recordId: string;
  baseVersion: number;
  baseValues: Record<string, FieldValue>;
}

function normalize(key: string, value: unknown): FieldValue {
  if (key === "price") return Number(value) || 0;
  return String(value ?? "");
}

/** 字段级 diff：只提交相对基线真正改过的字段，避免整记录覆盖同伴的修改 */
export function diffChanges(
  baseValues: Record<string, FieldValue>,
  formValues: Record<string, FieldValue>
): ChangeMap {
  const changes: ChangeMap = {};
  for (const key of EDITABLE_KEYS) {
    const from = normalize(key, baseValues[key]);
    const to = normalize(key, formValues[key]);
    if (from !== to) changes[key] = { from, to };
  }
  return changes;
}

/** 冲突 = 我方也改了该字段，且当前生效值已离开我方基线（对方也动过） */
function conflictFields(revision: PendingRevision, record: PriceRecord | undefined): string[] {
  if (!record) return Object.keys(revision.changes);
  return Object.keys(revision.changes).filter(
    (key) => normalize(key, record[key as keyof PriceRecord] as FieldValue) !== revision.changes[key].from
  );
}

let noticeSeq = 0;

export const usePriceStore = defineStore("price", () => {
  const records = ref<PriceRecord[]>([]);
  const revisions = ref<PendingRevision[]>([]);
  const snapshotMeta = ref<SnapshotMeta | null>(null);
  const notices = ref<Notice[]>([]);
  /** 另一窗口最近一次的同步时间，用于界面提示 */
  const lastSyncAt = ref<string | null>(null);

  function pushNotice(kind: Notice["kind"], text: string) {
    const id = ++noticeSeq;
    notices.value = [...notices.value, { id, kind, text }];
    window.setTimeout(() => {
      notices.value = notices.value.filter((notice) => notice.id !== id);
    }, 8000);
  }

  function dismissNotice(id: number) {
    notices.value = notices.value.filter((notice) => notice.id !== id);
  }

  /** 每个待处理修订当前的冲突字段（随 records 变化自动重算 = 重新确认） */
  const revisionConflicts = computed(() => {
    const map = new Map<string, string[]>();
    for (const revision of revisions.value) {
      const record = records.value.find((item) => item.id === revision.recordId);
      map.set(revision.id, conflictFields(revision, record));
    }
    return map;
  });

  const pendingRevisions = computed(() => revisions.value);

  const activeRecords = computed(() => records.value.filter((record) => record.status === ACTIVE_STATUS));

  /** 统计只使用已确认的有效价，待处理修订在值班经理确认前不参与 */
  const averageActivePrice = computed(() => {
    if (activeRecords.value.length === 0) return 0;
    const sum = activeRecords.value.reduce((acc, record) => acc + record.price, 0);
    return Math.round((sum / activeRecords.value.length) * 100) / 100;
  });

  const chartRows = computed(() =>
    statuses.map((status) => ({
      status,
      value: records.value.filter((record) => record.status === status).length
    }))
  );

  /** 统一提交入口：成功更新快照元信息；失败时主键原样未动，以持久化内容为准回滚内存 */
  function persistOrRecover(): boolean {
    const result = commit({ records: records.value, revisions: revisions.value });
    if (result.ok && result.meta) {
      snapshotMeta.value = result.meta;
      return true;
    }
    applyLoadResult({ silent: true });
    pushNotice("error", "写入失败，已从最后一个完整快照恢复；未完成的修订已保留，可重试");
    return false;
  }

  function applyLoadResult(options?: { silent?: boolean }) {
    const result = loadState();
    records.value = result.state.records;
    revisions.value = result.state.revisions;
    if (result.snapshotMeta) snapshotMeta.value = result.snapshotMeta;
    for (const text of result.notices) {
      pushNotice(result.recovered ? "error" : "info", text);
    }
    if (!options?.silent) {
      const snapshot = ensureSeeded(result);
      if (snapshot) snapshotMeta.value = { version: snapshot.version, savedAt: snapshot.savedAt };
    }
    return result;
  }

  // ---- 跨窗口同步：另一窗口写入后，重新加载并重算所有修订的冲突 ----

  let syncTimer: number | undefined;

  function syncFromStorage() {
    const before = JSON.stringify({ records: records.value, revisions: revisions.value });
    applyLoadResult({ silent: true });
    const after = JSON.stringify({ records: records.value, revisions: revisions.value });
    if (before !== after) {
      lastSyncAt.value = new Date().toISOString();
      pushNotice("warn", "另一窗口更新了数据，待处理修订已重新核对，请重新确认");
    }
  }

  function onStorage(event: StorageEvent) {
    if (!event.key || !event.key.startsWith(KEYS.legacy)) return;
    if (event.key === KEYS.legacyBackup) return;
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(syncFromStorage, 60);
  }

  let listening = false;

  function init() {
    applyLoadResult();
    if (!listening) {
      listening = true;
      window.addEventListener("storage", onStorage);
    }
  }

  // ---- 业务动作 ----

  function nextStatus(status: string) {
    const index = statuses.indexOf(status);
    return statuses[(index + 1) % statuses.length];
  }

  /**
   * 写动作前的同步刷新：localStorage 是同步的，
   * 刷新-修改-提交在同一个同步块内完成，其他窗口无法插入，
   * 因此乐观锁比较的永远是最新版本，不会把过期数组整体写回。
   */
  function refreshFromStorage() {
    applyLoadResult({ silent: true });
  }

  function submitNew(formValues: Record<string, FieldValue>): boolean {
    refreshFromStorage();
    const timestamp = new Date().toISOString();
    const record: PriceRecord = {
      id: crypto.randomUUID(),
      fuel: String(formValues.fuel ?? ""),
      price: Number(formValues.price) || 0,
      operator: String(formValues.operator ?? ""),
      effectiveDate: String(formValues.effectiveDate ?? ""),
      notes: String(formValues.notes ?? "") || "暂无备注",
      status: ACTIVE_STATUS,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1
    };
    records.value = [record, ...records.value];
    const ok = persistOrRecover();
    if (ok) pushNotice("info", `${record.fuel} 已保存（v1）`);
    return ok;
  }

  /**
   * 提交编辑：携带打开表单时的基线版本。
   * 版本一致 → 只把改过的字段应用到最新记录；版本落后 → 转入待处理修订，不覆盖他人修改。
   * 返回是否已持久化；失败时调用方应保留表单内容以便重试。
   */
  function submitEdit(baseline: EditBaseline, formValues: Record<string, FieldValue>, submittedBy: string): boolean {
    refreshFromStorage();
    const current = records.value.find((record) => record.id === baseline.recordId);
    if (!current) {
      pushNotice("error", "该记录已被删除，本次修改未保存");
      return false;
    }
    const changes = diffChanges(baseline.baseValues, formValues);
    if (Object.keys(changes).length === 0) {
      pushNotice("info", "没有字段改动，无需保存");
      return true;
    }
    if (current.version === baseline.baseVersion) {
      for (const [key, change] of Object.entries(changes)) {
        (current as unknown as Record<string, FieldValue>)[key] = change.to;
      }
      current.version += 1;
      current.updatedAt = new Date().toISOString();
      const applied = persistOrRecover();
      if (applied) pushNotice("info", `${current.fuel} 已保存（v${current.version}）`);
      return applied;
    }
    const revision: PendingRevision = {
      id: crypto.randomUUID(),
      recordId: baseline.recordId,
      baseVersion: baseline.baseVersion,
      changes,
      submittedBy: submittedBy || "未署名",
      submittedAt: new Date().toISOString()
    };
    revisions.value = [revision, ...revisions.value];
    const queued = persistOrRecover();
    if (queued) {
      const conflicts = revisionConflicts.value.get(revision.id) ?? [];
      pushNotice(
        "warn",
        conflicts.length > 0
          ? `另一窗口已先保存（当前 v${current.version}），${conflicts.length} 个字段两边都改过，已转入待处理修订`
          : `另一窗口已先保存（当前 v${current.version}），本次修改已转入待处理修订，待值班经理确认`
      );
    }
    return queued;
  }

  /**
   * 值班经理确认修订：无冲突字段直接采用提交值；
   * 冲突字段按 choices 逐个取舍（mine=采用提交值，current=保留当前值）。
   * 确认后记录版本 +1，统计随即使用新有效价。
   */
  function confirmRevision(revisionId: string, choices: Record<string, "mine" | "current">, resolvedBy: string) {
    refreshFromStorage();
    const revision = revisions.value.find((item) => item.id === revisionId);
    if (!revision) {
      pushNotice("warn", "该修订已被另一窗口处理");
      return;
    }
    const record = records.value.find((item) => item.id === revision.recordId);
    if (!record) {
      pushNotice("error", "目标记录已删除，无法并入，请驳回该修订");
      return;
    }
    const conflicts = revisionConflicts.value.get(revision.id) ?? [];
    for (const [key, change] of Object.entries(revision.changes)) {
      const takeMine = !conflicts.includes(key) || choices[key] === "mine";
      if (takeMine) (record as unknown as Record<string, FieldValue>)[key] = change.to;
    }
    record.version += 1;
    record.updatedAt = new Date().toISOString();
    revisions.value = revisions.value.filter((item) => item.id !== revisionId);
    if (persistOrRecover()) {
      pushNotice("info", `修订已由 ${resolvedBy || "值班经理"} 确认，${record.fuel} 更新为 v${record.version}，统计已按新有效价计算`);
    }
  }

  function rejectRevision(revisionId: string, resolvedBy: string) {
    refreshFromStorage();
    const revision = revisions.value.find((item) => item.id === revisionId);
    if (!revision) return;
    revisions.value = revisions.value.filter((item) => item.id !== revisionId);
    if (persistOrRecover()) {
      pushNotice("info", `修订已由 ${resolvedBy || "值班经理"} 驳回`);
    }
  }

  function flowStatus(recordId: string) {
    refreshFromStorage();
    const record = records.value.find((item) => item.id === recordId);
    if (!record) return;
    record.status = nextStatus(record.status);
    record.version += 1;
    record.updatedAt = new Date().toISOString();
    persistOrRecover();
  }

  function removeRecord(recordId: string) {
    refreshFromStorage();
    const record = records.value.find((item) => item.id === recordId);
    if (!record) {
      pushNotice("warn", "该记录已被另一窗口删除");
      return;
    }
    records.value = records.value.filter((item) => item.id !== recordId);
    if (persistOrRecover()) {
      const orphanCount = revisions.value.filter((item) => item.recordId === recordId).length;
      pushNotice(
        "info",
        orphanCount > 0 ? `已删除 ${record.fuel}，其 ${orphanCount} 条待处理修订变为无目标状态` : `已删除 ${record.fuel}`
      );
    }
  }

  return {
    records,
    revisions,
    snapshotMeta,
    notices,
    lastSyncAt,
    pendingRevisions,
    revisionConflicts,
    activeRecords,
    averageActivePrice,
    chartRows,
    init,
    pushNotice,
    dismissNotice,
    submitNew,
    submitEdit,
    confirmRevision,
    rejectRevision,
    flowStatus,
    removeRecord
  };
});
