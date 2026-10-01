/**
 * 端到端模拟：两个浏览器窗口（各自 PriceStore 实例，共享一个 mock localStorage），
 * 验证基线版本 / 跨窗口重认 / 同字段并排冲突 / 旧数据迁移 / 写入失败恢复与重试。
 * 运行：npm run sim（或 npx esbuild 打包后 node 运行）
 */
import { PriceStore } from "./store.ts";
import type { PriceDoc } from "./types.ts";

declare const process: { exit(code?: number): void };

let passed = 0;
let failed = 0;

function lengthOf<T>(items: readonly T[]): number {
  return items.length;
}

function baselineOf(storeInstance: PriceStore): number {
  return storeInstance.baselineVersion;
}

function assert(condition: unknown, message: string): asserts condition {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

// --- mock 浏览器环境：localStorage + storage 事件 + BroadcastChannel --------

class MemoryStorage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
    // storage 事件投递给所有文档；写入方自己收到时 ingest 是幂等 no-op。
    for (const listener of storageListeners) listener({ key, newValue: value } as StorageEvent);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
  dump(): PriceDoc {
    return JSON.parse(this.data.get("dfwlfront-9-price")!);
  }
}

const storageListeners = new Set<(e: StorageEvent) => void>();
const channels = new Map<string, Set<MockChannel>>();

class MockChannel {
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(private name: string) {
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name)!.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of channels.get(this.name)!) {
      if (peer !== this) peer.onmessage?.({ data } as MessageEvent);
    }
  }
  close() {
    channels.get(this.name)?.delete(this);
  }
}

function installBrowserMocks(rawDoc: string | null) {
  storageListeners.clear();
  channels.clear();
  const storage = new MemoryStorage();
  if (rawDoc !== null) storage.setItem("dfwlfront-9-price", rawDoc);
  globalThis.localStorage = storage as unknown as Storage;
  globalThis.BroadcastChannel = MockChannel as unknown as typeof BroadcastChannel;
  globalThis.window = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "storage") storageListeners.add(listener as (e: StorageEvent) => void);
    },
  } as unknown as Window & typeof globalThis;
}

function openWindow(): PriceStore {
  return new PriceStore();
}

function revisionStatus(storeInstance: PriceStore, revisionId: string) {
  return storeInstance.doc.pending.find((revision) => revision.id === revisionId)?.status;
}

console.log("场景 0：首次打开，迁移 + 补齐版本");
{
  installBrowserMocks(null);
  const a = openWindow();
  assert(a.doc.version === 1, "初始版本应为 v1");
  assert(a.doc.effective.version === 1, "有效价应为完整快照 v1");
  assert(a.doc.snapshots.length === 1, "应保留 v1 完整快照");
  assert(a.doc.effective.prices["92号汽油"].price === 7.62, "种子有效价应进入快照");
  assert(a.doc.audit[0].kind === "migration", "应记录迁移流水");
  assert(globalThis.localStorage.getItem("dfwlfront-9-price") !== null, "迁移后应立即落盘");
}

console.log("场景 1：旧版裸数组迁移（生效中 + 待确认）");
{
  const legacy = JSON.stringify([
    { id: "seed-1", fuel: "92号汽油", price: 7.9, operator: "甲", effectiveDate: "2026-07-01", status: "生效中", notes: "", createdAt: new Date().toISOString() },
    { id: "seed-2", fuel: "柴油", price: 6.9, operator: "乙", effectiveDate: "2026-07-02", status: "待确认", notes: "等复核", createdAt: new Date().toISOString() },
  ]);
  installBrowserMocks(legacy);
  const a = openWindow();
  assert(a.doc.effective.prices["92号汽油"].price === 7.9, "旧版生效中记录应入有效价");
  assert(a.doc.pending.length === 1, "旧版待确认记录应转为待处理修订");
  assert(a.doc.pending[0].baseVersion === 1, "迁移修订基线应补齐为 v1");
  assert(a.doc.effective.prices["98号汽油"].price === 8.41, "缺失油品应用种子价补齐");
  assert(a.doc.audit.some((entry) => entry.kind === "migration"), "迁移应留审计");
  assert(a.doc.snapshots[0].version === 1, "应生成 v1 完整快照");
}

console.log("场景 2：同字段两边都改 → conflict，并排裁决后确认");
{
  installBrowserMocks(null);
  const a = openWindow();
  const b = openWindow();

  const ra = a.submitRevision({ fuel: "92号汽油", changes: { price: 8.0 }, operator: "A窗口", note: "A改价" });
  assert(ra.ok, "A 提交应成功");
  assert(ra.revision.status === "pending", "A 提交后应为待确认");
  assert(ra.revision.baseVersion === 1, "A 修订应带基线 v1");
  assert(b.doc.pending.length === 1, "B 窗口应实时同步到 A 的待处理修订");

  const rb = b.submitRevision({ fuel: "92号汽油", changes: { price: 8.2 }, operator: "B窗口", note: "B改价" });
  assert(rb.ok, "B 提交应成功");

  const ca = a.confirmRevision(ra.revision.id);
  assert(ca.ok, "A 确认成功，生成 v2");
  assert(revisionStatus(b, rb.revision.id) === "conflict", "B 修订应被判为字段冲突");

  const resolutions = [
    { field: "price", label: "挂牌价", mine: 8.2, theirs: 8.0, choice: "mine" as const },
  ];
  const cb = b.confirmRevision(rb.revision.id, resolutions);
  assert(cb.ok, "B 按并排裁决确认成功");
  const doc = globalThis.localStorage.getItem("dfwlfront-9-price")!;
  const parsed = JSON.parse(doc) as PriceDoc;
  assert(parsed.version === 3, "裁决确认后应生成 v3");
  assert(parsed.effective.prices["92号汽油"].price === 8.2, "v3 有效价应采用裁决值 8.2");
  assert(parsed.snapshots.length === 3, "应保留 v1-v3 三份完整快照");
  assert(parsed.pending.length === 0, "确认后待处理队列应为空");
  assert(
    parsed.audit.some((entry) => entry.kind === "approve" && entry.note.includes("冲突字段裁决")),
    "裁决确认应记入审计",
  );
}

console.log("场景 3：不同字段两边改 → 需重新确认，确认时不覆盖同伴字段");
{
  installBrowserMocks(null);
  const a = openWindow();
  const b = openWindow();

  const ra = a.submitRevision({ fuel: "95号汽油", changes: { price: 7.9 }, operator: "A", note: "A改价" });
  const rb = b.submitRevision({ fuel: "95号汽油", changes: { effectiveDate: "2026-08-01" }, operator: "B", note: "B改日期" });

  assert(a.confirmRevision(ra.revision.id).ok, "A 先确认 → v2");
  assert(revisionStatus(b, rb.revision.id) === "needs_recheck", "B 修订应需重新确认");
  assert(
    b.doc.pending.find((revision) => revision.id === rb.revision.id)?.recheckReason?.includes("v2"),
    "重认原因应指明当前版本 v2",
  );

  // 经理重新确认后基线推进，状态回到待确认
  assert(b.rebaseRevision(rb.revision.id).ok, "重新确认应成功");
  assert(revisionStatus(b, rb.revision.id) === "pending", "重认后应回到待确认");
  assert(b.doc.pending[0].baseVersion === 2, "基线应推进到 v2");

  assert(b.confirmRevision(rb.revision.id).ok, "确认 → v3");
  const parsed = JSON.parse(globalThis.localStorage.getItem("dfwlfront-9-price")!) as PriceDoc;
  assert(parsed.effective.prices["95号汽油"].price === 7.9, "同伴改的价格应保留");
  assert(parsed.effective.prices["95号汽油"].effectiveDate === "2026-08-01", "B 改的日期应并入");
}

console.log("场景 3b：打开页面后同伴确认同字段，本窗口再提交仍带 v1 基线 → 冲突");
{
  installBrowserMocks(null);
  const a = openWindow(); // 同伴
  const b = openWindow(); // 本窗口，打开时基线 v1

  const ra = a.submitRevision({ fuel: "柴油", changes: { price: 7.3 }, operator: "A", note: "" });
  assert(a.confirmRevision(ra.revision.id).ok, "同伴确认 → v2");
  assert(baselineOf(b) === 1, "B 窗口基线应始终冻结在打开时的 v1");

  // B 虽然已经通过 storage 事件看到 v2，提交仍必须带 v1
  const rb = b.submitRevision({ fuel: "柴油", changes: { price: 7.6 }, operator: "B", note: "" });
  assert(rb.revision.baseVersion === 1, "提交必须带打开页面时的基线 v1，而非当前 v2");
  assert(rb.revision.status === "conflict", "同字段两边都改过应直接判冲突");

  const resolutions = [
    { field: "price", label: "挂牌价", mine: 7.6, theirs: 7.3, choice: "theirs" as const },
  ];
  assert(b.confirmRevision(rb.revision.id, resolutions).ok, "采用同伴值裁决确认");
  const parsed = JSON.parse(globalThis.localStorage.getItem("dfwlfront-9-price")!) as PriceDoc;
  assert(parsed.effective.prices["柴油"].price === 7.3, "裁决后有效价应为同伴值 7.3");
  assert(baselineOf(b) === 3, "本窗口完成确认后基线推进到 v3");
}

console.log("场景 4：写入失败 → 最后完整快照恢复 + 修订保留 + 重试");
{
  installBrowserMocks(null);
  const a = openWindow();

  a.failNextWrite = true;
  const r = a.submitRevision({ fuel: "98号汽油", changes: { price: 9 }, operator: "A", note: "失败提交" });
  assert(!r.ok, "提交写入应失败");
  assert(lengthOf(a.doc.retries) === 1, "失败动作应进入重试队列");
  assert(a.doc.version === 1, "内存应恢复到最后完整快照 v1");
  assert(a.doc.effective.version === 1, "有效价应恢复");
  assert(a.doc.pending.length === 1, "未完成修订应保留");
  assert(a.doc.audit.some((entry) => entry.kind === "restore"), "应记录快照恢复审计");
  assert(JSON.parse(globalThis.localStorage.getItem("dfwlfront-9-price")!).pending.length === 0,
    "磁盘上最后完整状态不应有半写入修订");

  const submitRetry = a.retry(a.doc.retries[0].id);
  assert(submitRetry.ok, "提交重试应成功");
  assert(lengthOf(a.doc.retries) === 0, "成功后重试队列应清空");
  assert(JSON.parse(globalThis.localStorage.getItem("dfwlfront-9-price")!).pending.length === 1,
    "修订应已持久化");

  // 确认时失败：修订不能丢，统计（有效价）不能跳到未确认版本
  a.failNextWrite = true;
  const confirmFail = a.confirmRevision(a.doc.pending[0].id);
  assert(!confirmFail.ok, "确认写入应失败");
  assert(a.doc.pending.length === 1, "确认失败后修订应仍保留在队列");
  assert(a.doc.pending[0].status !== "approved", "修订不应被标为已生效");
  assert(a.doc.version === 1, "有效价版本应仍停留在 v1");
  assert(a.doc.retries.some((item) => item.action === "confirm"), "应有待确认重试项");

  const confirmRetry = a.retry(a.doc.retries[0].id);
  assert(confirmRetry.ok, "确认重试应成功");
  const parsed = JSON.parse(globalThis.localStorage.getItem("dfwlfront-9-price")!) as PriceDoc;
  assert(parsed.effective.prices["98号汽油"].price === 9, "最终有效价应为 9");
  assert(parsed.version === 2, "版本应推进到 v2");
  assert(parsed.pending.length === 0, "队列应清空");
}

console.log("场景 5：回退留痕 + 手动恢复历史快照");
{
  installBrowserMocks(null);
  const a = openWindow();
  const r1 = a.submitRevision({ fuel: "柴油", changes: { price: 7.5 }, operator: "A", note: "第一次" });
  assert(a.confirmRevision(r1.revision.id).ok, "确认 → v2");
  const r2 = a.submitRevision({ fuel: "柴油", changes: { price: 7.9 }, operator: "A", note: "第二次" });
  assert(a.confirmRevision(r2.revision.id).ok, "确认 → v3");
  assert(JSON.parse(globalThis.localStorage.getItem("dfwlfront-9-price")!).effective.prices["柴油"].price === 7.9,
    "v3 价格应为 7.9");

  const r3 = a.submitRevision({ fuel: "柴油", changes: { price: 8.4 }, operator: "A", note: "待回退" });
  assert(a.rollbackRevision(r3.revision.id).ok, "回退应成功");
  const afterRollback = JSON.parse(globalThis.localStorage.getItem("dfwlfront-9-price")!) as PriceDoc;
  assert(afterRollback.pending.length === 0, "回退后修订应移出队列");
  assert(afterRollback.audit.some((entry) => entry.kind === "rollback"), "回退应留审计");
  assert(afterRollback.version === 3, "回退不应改变有效价版本");

  assert(a.restoreSnapshot(2), "恢复到 v2 应成功");
  assert(a.doc.version === 2, "当前版本应回到 v2");
  assert(a.doc.effective.prices["柴油"].price === 7.5, "恢复后价格应为 7.5");
  assert(!a.doc.snapshots.some((snapshot) => snapshot.version > 2), "恢复点之后的快照应截断");
  assert(a.doc.audit.some((entry) => entry.kind === "restore" && entry.effectiveVersion === 2),
    "恢复应记审计");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);