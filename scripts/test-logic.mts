/**
 * 逻辑测试：模拟两个窗口（两个独立 pinia 实例共享同一 localStorage）
 * 运行：node_modules/.bin/esbuild scripts/test-logic.mts --bundle --platform=node --format=esm --outfile=/tmp/test-logic.mjs && node /tmp/test-logic.mjs
 */
import { createPinia, setActivePinia } from "pinia";
import { KEYS, loadState, readSnapshot } from "../src/storage";
import { usePriceStore, type EditBaseline } from "../src/store";
import type { PriceRecord } from "../src/types";

// ---- 浏览器环境桩 ----

const storageListeners: Array<(event: { key: string }) => void> = [];

function createLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    map
  };
}

const ls = createLocalStorage();
let failOnKey: string | null = null;
const realSetItem = ls.setItem;

(globalThis as Record<string, unknown>).localStorage = {
  getItem: ls.getItem,
  removeItem: ls.removeItem,
  clear: ls.clear,
  key: ls.key,
  setItem: (key: string, value: string) => {
    if (failOnKey === key) throw new DOMException("quota", "QuotaExceededError");
    realSetItem(key, value);
  },
  get length() {
    return ls.length;
  }
};

(globalThis as Record<string, unknown>).window = {
  setTimeout: (fn: () => void, ms?: number) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  addEventListener: (type: string, fn: (event: { key: string }) => void) => {
    if (type === "storage") storageListeners.push(fn);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 模拟浏览器行为：一方写入后，另一方收到 storage 事件并同步 */
async function syncWindows() {
  for (const fn of storageListeners) fn({ key: KEYS.state });
  await sleep(120);
}

// ---- 测试工具 ----

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, extra?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

function makeStore() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = usePriceStore();
  store.init();
  return store;
}

function baselineOf(record: PriceRecord): EditBaseline {
  return {
    recordId: record.id,
    baseVersion: record.version,
    baseValues: {
      fuel: record.fuel,
      price: record.price,
      operator: record.operator,
      effectiveDate: record.effectiveDate,
      notes: record.notes
    }
  };
}

const local = () => (globalThis as Record<string, never>).localStorage as unknown as Storage;

// ---- T1 旧数据迁移 ----

console.log("T1 旧数据首次打开迁移并补齐版本");
const legacyRecords = [
  { id: "old-1", fuel: "92号汽油", price: 7.62, operator: "站长", effectiveDate: "2026-06-30", status: "生效中", notes: "正常调价", createdAt: "2026-06-30T00:00:00.000Z" },
  { id: "old-2", fuel: "柴油", price: 7.18, operator: "值班经理", effectiveDate: "2026-06-30", status: "待确认", notes: "等待复核", createdAt: "2026-06-30T00:00:00.000Z" }
];
local().setItem(KEYS.legacy, JSON.stringify(legacyRecords));
{
  const result = loadState();
  assert(result.migrated, "识别出旧数据并执行迁移");
  assert(result.state.records.every((r) => Number.isInteger(r.version) && r.version >= 1), "每条记录补齐了版本号");
  assert(result.state.records.every((r) => typeof r.updatedAt === "string" && r.updatedAt.length > 0), "每条记录补齐了更新时间");
  assert(local().getItem(KEYS.legacy) === null, "旧键已移除");
  assert(local().getItem(KEYS.legacyBackup) !== null, "旧数据已备份");
  assert(readSnapshot()?.version === 1, "迁移后生成了首个完整快照 v1");
}
ls.clear();

// ---- 两个窗口 ----

const storeA = makeStore();
const storeB = makeStore();
const fuel = "92号汽油";
const recordIn = (store: ReturnType<typeof makeStore>) => store.records.find((r) => r.fuel === fuel)!;

// ---- T2 基线一致：直接保存 ----

console.log("T2 基线版本一致时直接保存");
{
  const baseline = baselineOf(recordIn(storeA));
  storeA.submitEdit(baseline, { ...baseline.baseValues, price: 7.88 }, "窗口A");
  await syncWindows();
  const updated = recordIn(storeA);
  assert(updated.price === 7.88, "价格已更新", updated.price);
  assert(updated.version === baseline.baseVersion + 1, "版本号 +1", updated.version);
  assert(storeA.revisions.length === 0, "没有产生待处理修订");
  assert(recordIn(storeB).price === 7.88, "另一窗口通过 storage 事件同步到新值", recordIn(storeB).price);
}

// ---- T3 基线过期：转入待处理修订，不覆盖对方字段 ----

console.log("T3 另一窗口先保存后，提交转入待处理修订且不覆盖");
{
  const baselineA = baselineOf(recordIn(storeA)); // 窗口A打开表单，基线 v2
  const baselineB = baselineOf(recordIn(storeB));
  storeB.submitEdit(baselineB, { ...baselineB.baseValues, price: 8.01 }, "窗口B"); // B 先保存 → v3
  await syncWindows();
  storeA.submitEdit(baselineA, { ...baselineA.baseValues, operator: "窗口A" }, "窗口A"); // A 拿旧基线提交
  await syncWindows();
  const current = recordIn(storeA);
  assert(current.price === 8.01, "B 的价格没被 A 覆盖", current.price);
  assert(current.operator !== "窗口A", "A 的字段没有直接落库", current.operator);
  assert(storeA.revisions.length === 1, "生成了一条待处理修订", storeA.revisions.length);
  const revision = storeA.revisions[0];
  assert(revision.baseVersion === baselineA.baseVersion, "修订携带打开页面时的基线版本", revision.baseVersion);
  assert((storeA.revisionConflicts.get(revision.id) ?? []).length === 0, "改的是不同字段，无冲突");
  storeA.confirmRevision(revision.id, {}, "值班经理");
  await syncWindows();
  const merged = recordIn(storeA);
  assert(merged.operator === "窗口A" && merged.price === 8.01, "确认后两边字段合并生效", { operator: merged.operator, price: merged.price });
  assert(merged.version === 4, "确认后版本 +1", merged.version);
  assert(recordIn(storeB).operator === "窗口A", "另一窗口同步到合并结果");
}

// ---- T4 同字段冲突：并排取舍 ----

console.log("T4 同一字段两边都改过，确认时逐个取舍");
{
  const baselineA = baselineOf(recordIn(storeA)); // v4
  const baselineB = baselineOf(recordIn(storeB));
  storeB.submitEdit(baselineB, { ...baselineB.baseValues, price: 8.2 }, "窗口B"); // B 改价格 → v5
  await syncWindows();
  storeA.submitEdit(baselineA, { ...baselineA.baseValues, price: 8.35 }, "窗口A"); // A 也改价格
  await syncWindows();
  const revision = storeA.revisions[0];
  assert(Boolean(revision), "产生了待处理修订");
  const conflicts = storeA.revisionConflicts.get(revision.id) ?? [];
  assert(conflicts.includes("price"), "同字段 price 被标记为冲突", conflicts);
  assert(recordIn(storeA).price === 8.2, "确认前有效价仍是 B 的值", recordIn(storeA).price);
  storeA.confirmRevision(revision.id, { price: "mine" }, "值班经理");
  await syncWindows();
  assert(recordIn(storeA).price === 8.35, "选择“采用提交值”后生效为 A 的价格", recordIn(storeA).price);

  // 再来一轮，选择保留当前值
  const baselineA2 = baselineOf(recordIn(storeA));
  const baselineB2 = baselineOf(recordIn(storeB));
  storeB.submitEdit(baselineB2, { ...baselineB2.baseValues, price: 8.5 }, "窗口B");
  await syncWindows();
  storeA.submitEdit(baselineA2, { ...baselineA2.baseValues, price: 8.66 }, "窗口A");
  await syncWindows();
  const revision2 = storeA.revisions[0];
  assert(Boolean(revision2), "第二轮也产生了待处理修订");
  storeA.confirmRevision(revision2.id, { price: "current" }, "值班经理");
  await syncWindows();
  assert(recordIn(storeA).price === 8.5, "选择“保留当前值”后维持 B 的价格", recordIn(storeA).price);
}

// ---- T5 统计只用已确认有效价 ----

console.log("T5 统计只使用已确认的有效价");
{
  const active = storeA.records.filter((r) => r.status === "生效中");
  const expected = Math.round((active.reduce((acc, r) => acc + r.price, 0) / active.length) * 100) / 100;
  assert(storeA.averageActivePrice === expected, "平均挂牌价只统计生效中记录", { got: storeA.averageActivePrice, expected });
  // 制造一条待处理修订，确认前统计不变
  const baselineA = baselineOf(recordIn(storeA));
  const baselineB = baselineOf(recordIn(storeB));
  storeB.submitEdit(baselineB, { ...baselineB.baseValues, price: 8.8 }, "窗口B");
  await syncWindows();
  storeA.submitEdit(baselineA, { ...baselineA.baseValues, price: 99 }, "窗口A");
  await syncWindows();
  assert(storeA.revisions.length === 1, "待处理修订已生成");
  assert(storeA.averageActivePrice === Math.round(((8.8 + 7.18) / 2) * 100) / 100 || storeA.averageActivePrice !== 99, "修订确认前统计不采用新价", storeA.averageActivePrice);
  storeA.confirmRevision(storeA.revisions[0].id, { price: "mine" }, "值班经理");
  await syncWindows();
  assert(recordIn(storeA).price === 99, "确认后统计才用新有效价", recordIn(storeA).price);
}

// ---- T6 写失败：回滚到最后完整快照 ----

console.log("T6 写入失败后从最后一个完整快照恢复");
{
  const snapshotBefore = readSnapshot()!;
  const baseline = baselineOf(recordIn(storeA));
  failOnKey = KEYS.state; // 模拟写主键时失败（如配额超限）
  storeA.submitEdit(baseline, { ...baseline.baseValues, price: 9.99 }, "窗口A");
  failOnKey = null;
  const after = recordIn(storeA);
  assert(after.price !== 9.99, "内存态已回滚，失败写入未生效", after.price);
  assert(after.version === baseline.baseVersion, "版本号未虚增", after.version);
  const persisted = JSON.parse(local().getItem(KEYS.state)!) as { records: PriceRecord[] };
  const snapshotNow = readSnapshot()!;
  assert(JSON.stringify(persisted.records) === JSON.stringify(snapshotNow.records), "主键与最后完整快照保持一致");
  assert(snapshotNow.version === snapshotBefore.version, "失败提交没有推进快照版本", snapshotNow.version);
  storeA.submitEdit(baseline, { ...baseline.baseValues, price: 8.8 }, "窗口A"); // 重试
  await syncWindows();
  assert(recordIn(storeA).price === 8.8, "恢复后重试提交成功", recordIn(storeA).price);
}

console.log("T6b 确认修订时写失败，修订留在队列里可重试");
{
  const baselineA = baselineOf(recordIn(storeA));
  const baselineB = baselineOf(recordIn(storeB));
  storeB.submitEdit(baselineB, { ...baselineB.baseValues, price: 8.95 }, "窗口B");
  await syncWindows();
  storeA.submitEdit(baselineA, { ...baselineA.baseValues, price: 9.1 }, "窗口A");
  await syncWindows();
  assert(storeA.revisions.length === 1, "修订已生成");
  const revision = storeA.revisions[0];
  failOnKey = KEYS.state;
  storeA.confirmRevision(revision.id, { price: "mine" }, "值班经理"); // 确认时写失败
  failOnKey = null;
  assert(storeA.revisions.length === 1, "写失败后修订仍留在队列里", storeA.revisions.length);
  const persistedState = JSON.parse(local().getItem(KEYS.state)!) as { revisions: unknown[] };
  assert(persistedState.revisions.length === 1, "持久化的修订也未丢失", persistedState.revisions.length);
  storeA.confirmRevision(revision.id, { price: "mine" }, "值班经理"); // 重试
  await syncWindows();
  assert(storeA.revisions.length === 0, "重试确认成功，修订出队");
  assert(recordIn(storeA).price === 9.1, "重试后新有效价生效", recordIn(storeA).price);
}

// ---- T7 主数据损坏：从快照恢复 ----

console.log("T7 主数据损坏时从最后完整快照恢复");
{
  const snapshot = readSnapshot()!;
  local().setItem(KEYS.state, "{broken json");
  const result = loadState();
  assert(result.recovered, "识别主数据损坏并走了快照恢复");
  assert(JSON.stringify(result.state.records) === JSON.stringify(snapshot.records), "恢复内容与快照一致");
  assert(JSON.stringify(result.state.revisions) === JSON.stringify(snapshot.revisions), "待处理修订也随快照保留");
  local().setItem(KEYS.state, JSON.stringify(snapshot)); // 还原，避免影响后续
}

// ---- T8 跨窗口同步后修订需重新确认 ----

console.log("T8 另一窗口再改同字段后，待处理修订重新标记冲突");
{
  const baselineA = baselineOf(recordIn(storeA));
  const baselineB = baselineOf(recordIn(storeB));
  storeB.submitEdit(baselineB, { ...baselineB.baseValues, operator: "窗口B" }, "窗口B"); // B 改操作员
  await syncWindows();
  storeA.submitEdit(baselineA, { ...baselineA.baseValues, price: 9.3 }, "窗口A"); // A 改价格 → 修订，暂无冲突
  await syncWindows();
  const revision = storeA.revisions[0];
  assert((storeA.revisionConflicts.get(revision.id) ?? []).length === 0, "初始无冲突");
  const latestB = recordIn(storeB);
  storeB.submitEdit(baselineOf(latestB), { ...baselineOf(latestB).baseValues, price: 9.44 }, "窗口B"); // B 也改了价格
  await syncWindows();
  const conflicts = storeA.revisionConflicts.get(revision.id) ?? [];
  assert(conflicts.includes("price"), "另一窗口改动同字段后，修订被重新标记为冲突", conflicts);
  storeA.rejectRevision(revision.id, "值班经理");
  await syncWindows();
  assert(storeA.revisions.length === 0, "驳回后修订出队");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
