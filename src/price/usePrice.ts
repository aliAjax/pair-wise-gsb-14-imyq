import { defineStore } from "pinia";
import { computed, shallowRef, triggerRef } from "vue";
import { analyzeRevision, buildConflicts, priceStore } from "./store";
import {
  EffectiveSnapshot,
  FieldConflict,
  FUELS,
  PendingRevision,
  PriceAuditEntry,
  REVISION_STATUS_LABEL,
  RetryItem,
  RevisionAnalysis,
} from "./types";

export interface PendingView {
  revision: PendingRevision;
  analysis: RevisionAnalysis;
}

const FIELD_LABELS: Record<string, string> = {
  fuel: "油品",
  price: "挂牌价",
  operator: "操作员",
  effectiveDate: "生效日期",
};

/**
 * 调价领域的 Pinia 适配层：
 * 真正的并发判定 / 快照 / 恢复逻辑在 priceStore（纯 TS，可单测），
 * 这里只负责把文档变化接到 Vue 响应式并暴露计算视图。
 */
export const usePriceStore = defineStore("price", () => {
  const doc = shallowRef(priceStore.doc);

  priceStore.subscribe((next) => {
    doc.value = next;
    // 本地操作多为原地变更，强制刷新 shallowRef。
    triggerRef(doc);
  });

  // 本窗口基线：打开页面时锁定，本窗口确认/恢复后推进，跨窗口写入不推进。
  const baselineVersion = computed(() => {
    void doc.value; // 文档刷新后重新读取
    return priceStore.baselineVersion;
  });

  const version = computed(() => doc.value.version);
  const effective = computed<EffectiveSnapshot>(() => doc.value.effective);
  const snapshots = computed(() => doc.value.snapshots);
  const audit = computed<PriceAuditEntry[]>(() => doc.value.audit);
  const retries = computed<RetryItem[]>(() => doc.value.retries);

  const effectivePriceRows = computed(() =>
    FUELS.map((fuel) => ({
      fuel,
      values: doc.value.effective.prices[fuel] ?? {},
    })),
  );

  const pendingViews = computed<PendingView[]>(() =>
    doc.value.pending.map((revision) => ({
      revision,
      analysis: analyzeRevision(revision, doc.value.effective, doc.value.snapshots),
    })),
  );

  const pendingCount = computed(() => doc.value.pending.length);

  const averagePrice = computed(() => {
    const prices = FUELS.map((fuel) => Number(doc.value.effective.prices[fuel]?.price)).filter(
      (value) => Number.isFinite(value) && value > 0,
    );
    if (prices.length === 0) return 0;
    return Math.round((prices.reduce((acc, value) => acc + value, 0) / prices.length) * 100) / 100;
  });

  const statusChart = computed(() =>
    (["pending", "needs_recheck", "conflict"] as const).map((status) => ({
      status: REVISION_STATUS_LABEL[status],
      value: doc.value.pending.filter((revision) => revision.status === status).length,
    })),
  );

  function conflictsFor(revision: PendingRevision): FieldConflict[] {
    return buildConflicts(revision, doc.value.effective, doc.value.snapshots, FIELD_LABELS);
  }

  function submit(input: { fuel: string; changes: Record<string, string | number>; operator: string; note: string }) {
    return priceStore.submitRevision(input);
  }
  function confirm(id: string, resolutions?: FieldConflict[]) {
    return priceStore.confirmRevision(id, resolutions);
  }
  function rebase(id: string) {
    return priceStore.rebaseRevision(id);
  }
  function rollback(id: string) {
    return priceStore.rollbackRevision(id);
  }
  function retry(itemId: string) {
    return priceStore.retry(itemId);
  }
  function dismissRetry(itemId: string) {
    priceStore.dismissRetry(itemId);
  }
  function restoreSnapshot(versionNumber: number) {
    return priceStore.restoreSnapshot(versionNumber);
  }
  function armWriteFailure() {
    priceStore.failNextWrite = true;
  }

  return {
    baselineVersion,
    version,
    effective,
    snapshots,
    audit,
    retries,
    effectivePriceRows,
    pendingViews,
    pendingCount,
    averagePrice,
    statusChart,
    conflictsFor,
    submit,
    confirm,
    rebase,
    rollback,
    retry,
    dismissRetry,
    restoreSnapshot,
    armWriteFailure,
  };
});
