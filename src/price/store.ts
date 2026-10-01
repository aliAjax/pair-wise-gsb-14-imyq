import {
  EffectiveSnapshot,
  FieldConflict,
  FUELS,
  IngestResult,
  PendingRevision,
  PriceAuditEntry,
  PriceDoc,
  PriceValues,
  ResolutionChoice,
  RetryItem,
  RevisionAnalysis,
  RevisionStatus,
  SCHEMA_VERSION,
} from "./types";

// ---------------------------------------------------------------------------
// 持久化：单文档 + 跨窗口（storage 事件 / BroadcastChannel）+ 写入失败恢复
// ---------------------------------------------------------------------------

const STORAGE_KEY = "dfwlfront-9-price";
const CHANNEL_NAME = "dfwlfront-9-price-sync";

const SEED_PRICES: Record<string, PriceValues> = {
  "92号汽油": { price: 7.62, operator: "站长", effectiveDate: "2026-06-30" },
  "95号汽油": { price: 7.78, operator: "站长", effectiveDate: "2026-06-30" },
  "98号汽油": { price: 8.41, operator: "站长", effectiveDate: "2026-06-30" },
  柴油: { price: 7.18, operator: "值班经理", effectiveDate: "2026-06-30" },
};

function emptyPrices(): Record<string, PriceValues> {
  return Object.fromEntries(FUELS.map((fuel) => [fuel, {}])) as Record<string, PriceValues>;
}

function initialSnapshot(prices = SEED_PRICES): EffectiveSnapshot {
  return {
    version: 1,
    prices: structuredClone(prices),
    author: "系统",
    note: "初始挂牌价",
    revisionId: "migration",
    createdAt: new Date().toISOString(),
  };
}

/**
 * 旧数据迁移：
 * - 无文档：用种子数据生成 v1 完整快照，补 schemaVersion / version。
 * - 旧版裸数组（v0 页面直接存的 RecordItem[]）：取每个油品最新的
 *   “生效中”记录入有效价，“待确认”记录转成基线为 v1 的待处理修订，
 *   其余进审计流水，并补齐版本字段。
 * - 已是新文档但缺字段：逐项补齐。
 */
function migrate(raw: string | null): PriceDoc {
  if (!raw) {
    const snapshot = initialSnapshot();
    return {
      schemaVersion: SCHEMA_VERSION,
      version: 1,
      effective: snapshot,
      snapshots: [snapshot],
      pending: [],
      audit: [
        {
          id: crypto.randomUUID(),
          kind: "migration",
          fuel: "全部油品",
          changes: {},
          operator: "系统",
          note: "首次打开，初始化挂牌价快照（v1）",
          effectiveVersion: 1,
          revisionId: "migration",
          createdAt: new Date().toISOString(),
        },
      ],
      retries: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 文档损坏：返回可工作的空架子，等待快照/重试恢复。
    const snapshot = initialSnapshot(emptyPrices());
    return {
      schemaVersion: SCHEMA_VERSION,
      version: 1,
      effective: snapshot,
      snapshots: [snapshot],
      pending: [],
      audit: [],
      retries: [],
    };
  }

  // 已是新文档：补齐可能缺的字段与版本。
  if (parsed && typeof parsed === "object" && "effective" in parsed) {
    const doc = parsed as Partial<PriceDoc>;
    const effective = doc.effective ?? initialSnapshot();
    return {
      schemaVersion: SCHEMA_VERSION,
      version: typeof doc.version === "number" ? doc.version : effective.version,
      effective,
      snapshots: doc.snapshots?.length ? doc.snapshots : [effective],
      pending: doc.pending ?? [],
      audit: doc.audit ?? [],
      retries: doc.retries ?? [],
    };
  }

  // 旧版：RecordItem[] 平铺记录。
  const oldRecords = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  const prices = emptyPrices();
  const pending: PendingRevision[] = [];
  const audit: PriceAuditEntry[] = [];
  const now = new Date().toISOString();

  for (const record of oldRecords) {
    const fuel = String(record.fuel ?? "");
    if (!FUELS.includes(fuel as (typeof FUELS)[number])) continue;
    const status = String(record.status ?? "");
    const entry: PriceValues = {};
    if (record.price !== undefined) entry.price = Number(record.price);
    if (record.operator !== undefined) entry.operator = String(record.operator);
    if (record.effectiveDate !== undefined) entry.effectiveDate = String(record.effectiveDate);

    if (status === "生效中") {
      prices[fuel] = { ...prices[fuel], ...entry };
    } else if (status === "待确认") {
      pending.push({
        id: crypto.randomUUID(),
        fuel,
        changes: entry,
        operator: String(entry.operator ?? "旧数据"),
        note: String(record.notes ?? "旧数据迁移：等待复核"),
        baseVersion: 1,
        status: "pending",
        createdAt: String(record.createdAt ?? now),
        recheckReason: "由旧版待确认记录迁移，基线补齐为 v1",
      });
    }
    audit.push({
      id: crypto.randomUUID(),
      kind: "submit",
      fuel,
      changes: entry,
      operator: String(entry.operator ?? "旧数据"),
      note: `旧数据迁移（原状态：${status || "未知"}）`,
      effectiveVersion: status === "生效中" ? 1 : null,
      revisionId: null,
      createdAt: String(record.createdAt ?? now),
    });
  }
  for (const fuel of FUELS) {
    if (Object.keys(prices[fuel]).length === 0) prices[fuel] = { ...SEED_PRICES[fuel] };
  }

  const snapshot: EffectiveSnapshot = {
    version: 1,
    prices,
    author: "系统",
    note: "旧数据迁移：补齐版本与完整有效价快照",
    revisionId: "migration",
    createdAt: now,
  };
  audit.unshift({
    id: crypto.randomUUID(),
    kind: "migration",
    fuel: "全部油品",
    changes: {},
    operator: "系统",
    note: `迁移 ${oldRecords.length} 条旧记录，待处理修订 ${pending.length} 条`,
    effectiveVersion: 1,
    revisionId: "migration",
    createdAt: now,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    effective: snapshot,
    snapshots: [snapshot],
    pending,
    audit,
    retries: [],
  };
}

// ---------------------------------------------------------------------------
// 差异分析：基线版本决定待处理修订是否需要重新确认
// ---------------------------------------------------------------------------

function findBaseline(
  baseVersion: number,
  effective: EffectiveSnapshot,
  snapshots: EffectiveSnapshot[],
): EffectiveSnapshot | undefined {
  if (baseVersion === effective.version) return effective;
  return snapshots.find((snapshot) => snapshot.version === baseVersion);
}

/**
 * 分析一条待处理修订相对当前有效价的状态：
 * - baseVersion 已是最新：pending，可直接确认；
 * - 基线之后该油品被别的窗口确认过：
 *   - 对比基线快照，本修订改过、同伴也改过且值不同的字段 → conflict，并排列出；
 *   - 否则 → needs_recheck，值班经理重新确认后即可应用；
 * - 改动已与有效价完全一致 → approved，无需重复处理。
 */
export function analyzeRevision(
  revision: PendingRevision,
  effective: EffectiveSnapshot,
  snapshots: EffectiveSnapshot[],
): RevisionAnalysis {
  if (revision.baseVersion >= effective.version) {
    return {
      status: "pending",
      staleFields: Object.keys(revision.changes),
      overlappingFields: [],
      reason: `基线 v${revision.baseVersion} 为最新版本，等待值班经理确认`,
    };
  }

  const baseline = findBaseline(revision.baseVersion, effective, snapshots);
  const baseFuel = baseline?.prices[revision.fuel] ?? {};
  const currentFuel = effective.prices[revision.fuel] ?? {};

  // 基线之后，同伴（其它窗口）改过的字段。
  const changedByOther = Object.keys(currentFuel).filter(
    (field) => String(baseFuel[field] ?? "") !== String(currentFuel[field] ?? ""),
  );

  const overlapping: string[] = [];
  const stillDifferent: string[] = [];
  for (const [field, value] of Object.entries(revision.changes)) {
    if (String(currentFuel[field] ?? "") !== String(value)) stillDifferent.push(field);
    // 同一字段两边都改过，且双方值不一致 → 必须并排裁决。
    if (changedByOther.includes(field) && String(currentFuel[field] ?? "") !== String(value)) {
      overlapping.push(field);
    }
  }

  if (overlapping.length > 0) {
    return {
      status: "conflict",
      staleFields: stillDifferent,
      overlappingFields: overlapping,
      reason:
        `基线 v${revision.baseVersion} 已过期（当前 v${effective.version}）：` +
        `字段 ${overlapping.join("、")} 两边都改过`,
    };
  }
  if (stillDifferent.length === 0) {
    return {
      status: "approved",
      staleFields: [],
      overlappingFields: [],
      reason: "改动与当前有效价一致，无需重复确认",
    };
  }
  return {
    status: "needs_recheck",
    staleFields: stillDifferent,
    overlappingFields: [],
    reason: `另一窗口已确认到 v${effective.version}，请核对后重新确认`,
  };
}

export function buildConflicts(
  revision: PendingRevision,
  effective: EffectiveSnapshot,
  snapshots: EffectiveSnapshot[],
  labels: Record<string, string>,
): FieldConflict[] {
  const analysis = analyzeRevision(revision, effective, snapshots);
  const current = effective.prices[revision.fuel] ?? {};
  return analysis.overlappingFields.map((field) => ({
    field,
    label: labels[field] ?? field,
    mine: revision.changes[field],
    theirs: current[field],
    choice: "mine" as ResolutionChoice,
  }));
}

function resolveValue(conflict: FieldConflict): string | number {
  if (conflict.choice === "mine") return conflict.mine;
  if (conflict.choice === "theirs") return conflict.theirs;
  return conflict.custom ?? "";
}

// ---------------------------------------------------------------------------
// Store：内存文档 + 订阅广播
// ---------------------------------------------------------------------------

type Listener = (doc: PriceDoc, source: "local" | "remote") => void;

class PriceStore {
  doc: PriceDoc;
  /**
   * 打开页面时锁定的基线版本：本窗口每次提交都带它。
   * 只在本窗口自己确认/恢复（自己已知晓的变化）后推进；
   * 其它窗口经 storage 事件写入时不推进——那正是需要重新确认的情形。
   */
  baselineVersion: number;
  /** 最近一次成功落盘的版本，写入失败恢复时以此为完整快照边界。 */
  private persistedVersion: number;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  private lastWriteError: string | null = null;
  /** 测试/演练用：让下一次 persist 抛错，验证快照恢复与重试链路。 */
  failNextWrite = false;

  constructor() {
    this.doc = migrate(localStorage.getItem(STORAGE_KEY));
    this.baselineVersion = this.doc.version;
    this.persistedVersion = 0;
    this.persist("迁移落盘");
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<number>) => {
        if (typeof event.data === "number" && event.data !== this.doc.version) {
          this.ingestRemote();
        }
      };
    }
    // storage 事件作为 BroadcastChannel 的兜底（其它标签页写入）。
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY && event.newValue) this.ingestRemote();
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(source: "local" | "remote") {
    for (const listener of this.listeners) listener(this.doc, source);
  }

  private pendingSignature(doc: PriceDoc): string {
    return doc.pending
      .map((revision) => `${revision.id}:${revision.status}:${revision.baseVersion}`)
      .join("|");
  }

  /** 从 localStorage 重新读取另一窗口写入的完整文档，本地未完成重试合并保留。 */
  private ingestRemote(): IngestResult {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { changed: false, newVersion: null };
    let incoming: PriceDoc;
    try {
      incoming = migrate(raw);
    } catch {
      return { changed: false, newVersion: null };
    }
    const sameVersion = incoming.version === this.doc.version;
    const samePending = this.pendingSignature(incoming) === this.pendingSignature(this.doc);
    if (sameVersion && samePending) return { changed: false, newVersion: null };

    const previousVersion = this.doc.version;
    const localRetries = this.doc.retries;
    this.doc = incoming;
    this.persistedVersion = Math.max(this.persistedVersion, incoming.version);
    this.doc.retries = mergeRetries(localRetries, incoming.retries);
    this.rejudgePending("另一窗口已更新有效价");
    this.emit("remote");
    return {
      changed: incoming.version !== previousVersion,
      newVersion: incoming.version !== previousVersion ? incoming.version : null,
    };
  }

  /** 基线过期后重判所有未完成修订的状态。 */
  private rejudgePending(reason: string) {
    for (const revision of this.doc.pending) {
      if (revision.status === "approved" || revision.status === "rolled_back") continue;
      const analysis = analyzeRevision(revision, this.doc.effective, this.doc.snapshots);
      if (analysis.status === "conflict" || analysis.status === "needs_recheck") {
        if (revision.status !== analysis.status || revision.rebasedTo !== this.doc.version) {
          revision.status = analysis.status;
          revision.rebasedTo = this.doc.version;
          revision.recheckReason = `${reason}：${analysis.reason}`;
          revision.conflicts = undefined;
        }
      }
    }
  }

  /**
   * 原子写：先序列化再一次性写 localStorage。
   * 失败时从最后一个完整快照恢复，并把未完成动作塞进重试队列。
   */
  persist(
    reason: string,
    retry?: Omit<RetryItem, "id" | "attempts" | "lastError" | "createdAt">,
  ): boolean {
    let payload: string;
    try {
      payload = JSON.stringify(this.doc);
    } catch (error) {
      this.lastWriteError = `序列化失败：${(error as Error).message}`;
      this.queueRetry(retry, this.lastWriteError);
      return false;
    }
    try {
      if (this.failNextWrite) {
        this.failNextWrite = false;
        throw new Error("模拟写入失败（磁盘不可用）");
      }
      localStorage.setItem(STORAGE_KEY, payload);
      this.lastWriteError = null;
      this.persistedVersion = this.doc.version;
      this.channel?.postMessage(this.doc.version);
      return true;
    } catch (error) {
      this.lastWriteError = `写入失败（${reason}）：${(error as Error).message}`;
      this.restoreFromSnapshot(this.lastWriteError);
      this.queueRetry(retry, this.lastWriteError);
      return false;
    }
  }

  /** 从最后一个完整快照恢复内存；尚未完成的修订全部保留并重判。 */
  private restoreFromSnapshot(reason: string) {
    const target =
      this.doc.snapshots.find((snapshot) => snapshot.version === this.persistedVersion) ??
      this.doc.snapshots.find((snapshot) => snapshot.version < this.doc.version) ??
      this.doc.snapshots[0];

    const restored: PriceDoc = {
      ...this.doc,
      version: target.version,
      effective: structuredClone(target),
      snapshots: this.doc.snapshots.filter((snapshot) => snapshot.version <= target.version),
      pending: [],
    };
    // 未完成修订原样保留（恢复点之前的都不算结束），按恢复点重新判定。
    for (const revision of this.doc.pending) {
      if (revision.status === "approved" || revision.status === "rolled_back") continue;
      const analysis = analyzeRevision(revision, restored.effective, restored.snapshots);
      restored.pending.push({
        ...revision,
        status: analysis.status === "approved" ? "pending" : analysis.status,
        rebasedTo: target.version,
        recheckReason: `写入失败后从 v${target.version} 完整快照恢复：${reason}`,
        conflicts: undefined,
      });
    }
    restored.audit.push({
      id: crypto.randomUUID(),
      kind: "restore",
      fuel: "全部油品",
      changes: {},
      operator: "系统",
      note: `写入失败，已从最后一个完整快照 v${target.version} 恢复；未完成修订保留待重试`,
      effectiveVersion: target.version,
      revisionId: null,
      createdAt: new Date().toISOString(),
    });
    this.doc = restored;
    this.emit("local");
  }

  private queueRetry(
    retry: Omit<RetryItem, "id" | "attempts" | "lastError" | "createdAt"> | undefined,
    error: string,
  ) {
    if (!retry) return;
    const existing = this.doc.retries.find(
      (item) => item.action === retry.action && item.revisionId === retry.revisionId,
    );
    if (existing) {
      existing.attempts += 1;
      existing.lastError = error;
      if (retry.draft) existing.draft = retry.draft;
      if (retry.revision) existing.revision = retry.revision;
      if (retry.resolutions) existing.resolutions = retry.resolutions;
    } else {
      this.doc.retries.push({
        ...retry,
        id: crypto.randomUUID(),
        attempts: 1,
        lastError: error,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // ---- 业务操作 -----------------------------------------------------------

  /** 提交调价：携带打开页面时的基线版本；落盘前先吸收其它窗口的新版本。 */
  submitRevision(input: {
    fuel: string;
    changes: PriceValues;
    operator: string;
    note: string;
  }): { ok: boolean; revision: PendingRevision; error?: string } {
    this.ingestRemote();
    const revision: PendingRevision = {
      id: crypto.randomUUID(),
      fuel: input.fuel,
      changes: input.changes,
      operator: input.operator,
      note: input.note,
      baseVersion: this.baselineVersion,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const analysis = analyzeRevision(revision, this.doc.effective, this.doc.snapshots);
    revision.status = analysis.status === "approved" ? "pending" : analysis.status;
    revision.recheckReason = analysis.status === "pending" ? undefined : analysis.reason;

    this.doc.pending.unshift(revision);
    this.doc.audit.unshift({
      id: crypto.randomUUID(),
      kind: "submit",
      fuel: revision.fuel,
      changes: revision.changes,
      operator: revision.operator,
      note: revision.note,
      effectiveVersion: null,
      revisionId: revision.id,
      createdAt: revision.createdAt,
    });

    const ok = this.persist("提交调价", {
      action: "submit",
      revisionId: revision.id,
      draft: structuredClone(revision),
    });
    if (ok) this.rejudgePending("新修订提交");
    this.emit("local");
    return { ok, revision, error: ok ? undefined : this.lastWriteError ?? "写入失败" };
  }

  /** 值班经理确认：用（可能经过冲突裁决的）修订生成新的完整有效价快照。 */
  confirmRevision(
    revisionId: string,
    resolutions?: FieldConflict[],
    operator = "值班经理",
  ): { ok: boolean; error?: string } {
    this.ingestRemote();
    const index = this.doc.pending.findIndex((item) => item.id === revisionId);
    if (index < 0) return { ok: false, error: "修订不存在或已处理" };
    const revision = this.doc.pending[index];
    if (revision.status === "rolled_back") return { ok: false, error: "该修订已回退" };

    const analysis = analyzeRevision(revision, this.doc.effective, this.doc.snapshots);
    if (analysis.status === "conflict" && (!resolutions || resolutions.length === 0)) {
      return { ok: false, error: "存在双方同改字段，需先逐项选择保留值" };
    }

    const resolutionMap = new Map((resolutions ?? []).map((item) => [item.field, item]));
    const nextPrices = structuredClone(this.doc.effective.prices);
    nextPrices[revision.fuel] = nextPrices[revision.fuel] ?? {};
    const applied: PriceValues = {};
    for (const [field, value] of Object.entries(revision.changes)) {
      const conflict = resolutionMap.get(field);
      const finalValue = conflict ? resolveValue(conflict) : value;
      nextPrices[revision.fuel][field] = finalValue;
      applied[field] = finalValue;
    }
    nextPrices[revision.fuel].operator = operator;

    const newVersion = this.doc.version + 1;
    const now = new Date().toISOString();
    const snapshot: EffectiveSnapshot = {
      version: newVersion,
      prices: nextPrices,
      author: operator,
      note: revision.note,
      revisionId: revision.id,
      createdAt: now,
    };
    this.doc.version = newVersion;
    this.doc.effective = snapshot;
    this.doc.snapshots.push(snapshot);
    this.doc.pending.splice(index, 1);
    this.doc.audit.unshift({
      id: crypto.randomUUID(),
      kind: "approve",
      fuel: revision.fuel,
      changes: applied,
      operator,
      note: resolutions?.length
        ? `确认调价（含 ${resolutions.length} 个冲突字段裁决）`
        : "值班经理确认调价",
      effectiveVersion: newVersion,
      revisionId: revision.id,
      createdAt: now,
    });
    this.rejudgePending("有效价已更新");

    const ok = this.persist("确认调价", {
      action: "confirm",
      revisionId: revision.id,
      revision: structuredClone(revision),
      resolutions,
    });
    if (ok) {
      // 本窗口自己完成的确认对操作者可见，提交基线随之推进。
      this.baselineVersion = newVersion;
    } else if (!this.doc.pending.some((item) => item.id === revision.id)) {
      // 恢复点已把内存退回旧快照，确认中的修订重新挂回待处理队列。
      const recoveredAnalysis = analyzeRevision(
        revision,
        this.doc.effective,
        this.doc.snapshots,
      );
      this.doc.pending.unshift({
        ...revision,
        status: recoveredAnalysis.status === "approved" ? "needs_recheck" : recoveredAnalysis.status,
        rebasedTo: this.doc.version,
        recheckReason: `确认写入失败，修订保留待重试：${this.lastWriteError ?? ""}`,
        conflicts: undefined,
      });
      this.emit("local");
    }
    return { ok, error: ok ? undefined : this.lastWriteError ?? "写入失败，已保留修订待重试" };
  }

  /** 重新确认：值班经理核对过期基线后，把基线推进到当前版本。 */
  rebaseRevision(revisionId: string): { ok: boolean; error?: string } {
    const revision = this.doc.pending.find((item) => item.id === revisionId);
    if (!revision) return { ok: false, error: "修订不存在" };
    const analysis = analyzeRevision(revision, this.doc.effective, this.doc.snapshots);
    if (analysis.status === "conflict") return { ok: false, error: "存在字段冲突，需先并排裁决" };
    revision.baseVersion = this.doc.version;
    revision.rebasedTo = this.doc.version;
    revision.status = "pending";
    revision.recheckReason = `值班经理已按 v${this.doc.version} 重新确认`;
    revision.conflicts = undefined;
    const ok = this.persist("重新确认");
    this.emit("local");
    return { ok, error: ok ? undefined : this.lastWriteError ?? undefined };
  }

  /** 回退修订：不进入有效价，记审计。 */
  rollbackRevision(revisionId: string, operator = "值班经理"): { ok: boolean; error?: string } {
    const index = this.doc.pending.findIndex((item) => item.id === revisionId);
    if (index < 0) return { ok: false, error: "修订不存在" };
    const revision = this.doc.pending[index];
    this.doc.pending.splice(index, 1);
    this.doc.audit.unshift({
      id: crypto.randomUUID(),
      kind: "rollback",
      fuel: revision.fuel,
      changes: revision.changes,
      operator,
      note: "回退调价修订",
      effectiveVersion: null,
      revisionId: revision.id,
      createdAt: new Date().toISOString(),
    });
    const ok = this.persist("回退修订", {
      action: "rollback",
      revisionId: revision.id,
      revision: structuredClone(revision),
    });
    if (!ok && !this.doc.pending.some((item) => item.id === revision.id)) {
      this.doc.pending.unshift(revision);
      this.emit("local");
    }
    return { ok, error: ok ? undefined : this.lastWriteError ?? undefined };
  }

  /** 重试之前写入失败的动作（未完成的修订一直保留到重试成功）。 */
  retry(itemId: string): { ok: boolean; error?: string } {
    const item = this.doc.retries.find((entry) => entry.id === itemId);
    if (!item) return { ok: false, error: "重试项不存在" };

    let result: { ok: boolean; error?: string };
    if (item.action === "submit" && item.draft) {
      const draft = item.draft;
      if (!this.doc.pending.some((revision) => revision.id === draft.id)) {
        this.doc.pending.unshift(draft);
      }
      const ok = this.persist("重试提交");
      result = ok ? { ok: true } : { ok: false, error: this.lastWriteError ?? "仍然写入失败" };
    } else if (item.action === "confirm" && item.revisionId) {
      if (item.revision && !this.doc.pending.some((revision) => revision.id === item.revisionId)) {
        this.doc.pending.unshift(item.revision);
      }
      result = this.confirmRevision(item.revisionId, item.resolutions);
    } else if (item.action === "rollback" && item.revisionId) {
      if (item.revision && !this.doc.pending.some((revision) => revision.id === item.revisionId)) {
        this.doc.pending.unshift(item.revision);
      }
      result = this.rollbackRevision(item.revisionId);
    } else {
      result = { ok: false, error: "无法识别的重试动作" };
    }

    if (result.ok) {
      this.doc.retries = this.doc.retries.filter((entry) => entry.id !== itemId);
      this.persist("清理重试队列");
    }
    this.emit("local");
    return result;
  }

  dismissRetry(itemId: string) {
    this.doc.retries = this.doc.retries.filter((entry) => entry.id !== itemId);
    this.persist("放弃重试");
    this.emit("local");
  }

  /** 值班经理手动恢复到某个历史完整快照。 */
  restoreSnapshot(version: number, operator = "值班经理"): boolean {
    const target =
      version === this.doc.effective.version
        ? this.doc.effective
        : this.doc.snapshots.find((snapshot) => snapshot.version === version);
    if (!target) return false;
    this.doc.version = target.version;
    this.baselineVersion = target.version;
    this.doc.effective = structuredClone(target);
    this.doc.snapshots = this.doc.snapshots.filter((snapshot) => snapshot.version <= version);
    this.rejudgePending(`手动恢复到 v${version}`);
    this.doc.audit.unshift({
      id: crypto.randomUUID(),
      kind: "restore",
      fuel: "全部油品",
      changes: {},
      operator,
      note: `手动恢复到 v${version} 完整快照`,
      effectiveVersion: version,
      revisionId: null,
      createdAt: new Date().toISOString(),
    });
    const ok = this.persist("恢复快照");
    if (ok) this.baselineVersion = target.version;
    this.emit("local");
    return ok;
  }
}

function mergeRetries(local: RetryItem[], remote: RetryItem[]): RetryItem[] {
  const map = new Map<string, RetryItem>();
  for (const item of [...remote, ...local]) {
    const key = `${item.action}:${item.revisionId ?? item.id}`;
    const prev = map.get(key);
    map.set(key, prev && prev.attempts > item.attempts ? prev : item);
  }
  return [...map.values()];
}

/**
 * 全局单例，懒加载：
 * 首次访问时才读取 localStorage，便于测试在无浏览器环境下先装好 mock。
 */
let singleton: PriceStore | null = null;
export const priceStore = new Proxy({} as PriceStore, {
  get(target, property, receiver) {
    singleton ??= new PriceStore();
    const value = Reflect.get(singleton, property, receiver);
    return typeof value === "function" ? value.bind(singleton) : value;
  },
  set(target, property, value, receiver) {
    singleton ??= new PriceStore();
    return Reflect.set(singleton, property, value, receiver);
  },
});
export { PriceStore };
