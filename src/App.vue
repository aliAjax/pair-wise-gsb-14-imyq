<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { usePriceStore } from "./price/usePrice";
import {
  AuditKind,
  FieldConflict,
  FUELS,
  PendingRevision,
  REVISION_STATUS_LABEL,
  RevisionStatus,
} from "./price/types";

const store = usePriceStore();

// 打开页面时锁定的基线版本：本窗口每次提交都带它；
// 另一窗口确认过新价（本窗口基线不推进）后，修订被判为需重新确认 / 字段冲突。
const baselineVersion = computed(() => store.baselineVersion);

const filters = ["全部油品", ...FUELS];
const filter = ref(filters[0]);
const today = new Date().toISOString().slice(0, 10);

const form = reactive({
  fuel: FUELS[0],
  price: "",
  effectiveDate: today,
  operator: "",
});
const note = ref("");
const message = ref<{ type: "ok" | "error" | "info"; text: string } | null>(null);

function flash(type: "ok" | "error" | "info", text: string) {
  message.value = { type, text };
}

const baselineStale = computed(() => store.version > baselineVersion.value);

// ---------------------------------------------------------------------------
// 提交调价（带基线版本）
// ---------------------------------------------------------------------------

function submit() {
  const changes: Record<string, string | number> = {};
  const price = Number(form.price);
  if (form.price.trim() !== "" && Number.isFinite(price)) changes.price = price;
  if (form.effectiveDate) changes.effectiveDate = form.effectiveDate;
  if (Object.keys(changes).length === 0) {
    flash("error", "请至少填写挂牌价或生效日期");
    return;
  }
  const result = store.submit({
    fuel: form.fuel,
    changes,
    operator: form.operator.trim() || "当班操作员",
    note: note.value.trim() || "换班调价",
  });
  if (result.ok) {
    form.price = "";
    note.value = "";
    const revision = store.pendingViews.find((view) => view.revision.id === result.revision.id);
    flash(
      "ok",
      revision && revision.analysis.status !== "pending"
        ? `已提交（基线 v${baselineVersion.value}），系统判定：${revision.analysis.reason}`
        : `已提交，基线 v${baselineVersion.value}，等待值班经理确认`,
    );
  } else {
    flash("error", `${result.error}；修订已保留，可在下方失败队列重试`);
  }
}

// ---------------------------------------------------------------------------
// 待处理修订：重新确认 / 并排冲突裁决 / 经理确认 / 回退
// ---------------------------------------------------------------------------

/** 每个冲突修订一份并排裁决草稿（本窗口值 / 同伴值 / 自定义）。 */
const conflictDrafts = reactive<Record<string, FieldConflict[]>>({});

// 修订进入冲突态时预生成裁决草稿；离开冲突态时清掉。
watch(
  store.pendingViews,
  (views) => {
    for (const view of views) {
      if (view.analysis.status === "conflict" && !conflictDrafts[view.revision.id]) {
        conflictDrafts[view.revision.id] = store
          .conflictsFor(view.revision)
          .map((conflict) => ({ ...conflict }));
      }
      if (view.analysis.status !== "conflict" && conflictDrafts[view.revision.id]) {
        delete conflictDrafts[view.revision.id];
      }
    }
  },
  { immediate: true, deep: true },
);

function statusClass(status: RevisionStatus) {
  return `status status-${status}`;
}

function confirmRevision(id: string, hasConflict: boolean) {
  const result = store.confirm(id, hasConflict ? conflictDrafts[id] : undefined);
  if (result.ok) {
    delete conflictDrafts[id];
    flash("ok", `值班经理已确认，统计已按 v${store.version} 新有效价更新`);
  } else {
    flash("error", result.error ?? "确认失败");
  }
}

function rebase(id: string) {
  const result = store.rebase(id);
  flash(result.ok ? "ok" : "error", result.ok ? "基线已推进到当前版本，可再次确认" : (result.error ?? "重新确认失败"));
}

function rollback(id: string) {
  const result = store.rollback(id);
  flash(result.ok ? "info" : "error", result.ok ? "修订已回退并记入调价记录" : (result.error ?? "回退失败"));
}

// ---------------------------------------------------------------------------
// 快照 / 审计 / 失败重试
// ---------------------------------------------------------------------------

const AUDIT_LABEL: Record<AuditKind, string> = {
  migration: "数据迁移",
  submit: "提交调价",
  approve: "确认生效",
  rollback: "回退",
  restore: "快照恢复",
};

const RETRY_LABEL = {
  submit: "待提交修订",
  confirm: "待确认修订",
  rollback: "待回退修订",
} as const;

function displayValue(value: unknown) {
  if (value === undefined || value === "") return "—";
  return String(value);
}

function changeSummary(changes: Record<string, string | number>) {
  return Object.entries(changes)
    .map(([key, value]) => `${key === "price" ? "挂牌价" : key === "effectiveDate" ? "生效日期" : key}: ${value}`)
    .join("，");
}

function restore(versionNumber: number) {
  if (window.confirm(`确定恢复到 v${versionNumber} 完整快照？之后未完成的修订需要重新确认。`)) {
    store.restoreSnapshot(versionNumber);
    flash("info", `已恢复到 v${versionNumber}，统计按该版本有效价计算`);
  }
}

const maxChart = computed(() => Math.max(1, ...store.statusChart.map((row) => row.value)));

const filteredPending = computed(() =>
  filter.value.startsWith("全部")
    ? store.pendingViews
    : store.pendingViews.filter((view) => view.revision.fuel === filter.value),
);

const filteredAudit = computed(() =>
  filter.value.startsWith("全部")
    ? store.audit
    : store.audit.filter((entry) => entry.fuel === filter.value),
);

function armFailure() {
  store.armWriteFailure();
  flash("info", "已注入一次写入失败：下一次提交/确认/回退会触发快照恢复与失败重试队列");
}

function retry(itemId: string) {
  const result = store.retry(itemId);
  flash(result.ok ? "ok" : "error", result.ok ? "重试成功，数据已写入" : (result.error ?? "重试失败"));
}

function dismissRetry(itemId: string) {
  store.dismissRetry(itemId);
}

function copySummary(revision: PendingRevision) {
  const text = `${revision.fuel} / ${changeSummary(revision.changes)} / ${REVISION_LABEL_SAFE(revision.status)}`;
  void navigator.clipboard?.writeText(text);
}

function REVISION_LABEL_SAFE(status: RevisionStatus) {
  return REVISION_STATUS_LABEL[status];
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业前端最小闭环 · 换班并发调价</p>
          <h1>油品价格维护</h1>
          <p class="subtitle">
            调价记录、有效价快照与待处理修订串联：提交带基线版本，跨窗口改动需重新确认，
            同字段两边都改时并排裁决，值班经理确认后统计才使用新有效价。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">乐观版本控制</span>
          <span class="tag">快照恢复</span>
        </div>
      </header>

      <section class="metrics">
        <article class="metric">
          <span>有效价版本</span>
          <strong>v{{ store.version }}</strong>
        </article>
        <article class="metric">
          <span>待处理修订（含冲突 / 待重认）</span>
          <strong>{{ store.pendingCount }}</strong>
        </article>
        <article class="metric">
          <span>平均挂牌价（当前有效价）</span>
          <strong>¥{{ store.averagePrice.toFixed(2) }}</strong>
        </article>
      </section>

      <div :class="['baseline', baselineStale ? 'baseline-stale' : 'baseline-ok']">
        <span>
          本窗口基线版本：<strong>v{{ baselineVersion }}</strong>
          ｜当前有效价：<strong>v{{ store.version }}</strong>
        </span>
        <span v-if="baselineStale">
          ⚠ 打开页面后另一窗口已确认新价，新提交会按旧基线判定，未完成修订需重新确认
        </span>
        <span v-else>✓ 基线为最新，提交后可直接由值班经理确认</span>
        <button type="button" class="secondary" @click="armFailure">模拟下一次写入失败</button>
      </div>

      <p v-if="message" :class="['flash', `flash-${message.type}`]">{{ message.text }}</p>

      <section class="workspace">
        <!-- 调价表单 -->
        <form class="panel" @submit.prevent="submit">
          <h2>调整油品价格</h2>
          <p class="panel-hint">提交基线 v{{ baselineVersion }}：同伴在此版本后确认的字段会触发重认或冲突。</p>
          <div class="form-grid">
            <label>
              油品
              <select v-model="form.fuel" required>
                <option v-for="fuel in FUELS" :key="fuel" :value="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              挂牌价（元/升）
              <input v-model="form.price" type="number" step="0.01" min="0" placeholder="如 7.65" required />
            </label>
            <label>
              操作员
              <input v-model="form.operator" type="text" placeholder="当班员工姓名" required />
            </label>
            <label>
              生效日期
              <input v-model="form.effectiveDate" type="date" required />
            </label>
            <label>
              备注
              <textarea v-model="note" placeholder="换班说明 / 调价依据" />
            </label>
            <button type="submit">保存价格（带基线提交）</button>
          </div>

          <div class="mini-chart">
            <div v-for="row in store.statusChart" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>待处理修订</h2>
            <select v-model="filter">
              <option v-for="item in filters" :key="item" :value="item">{{ item }}</option>
            </select>
          </div>

          <div class="record-grid">
            <div v-if="filteredPending.length === 0" class="empty">没有待处理修订，所有挂牌价均已生效</div>

            <article
              v-for="view in filteredPending"
              :key="view.revision.id"
              :class="['record', `record-${view.analysis.status}`]"
            >
              <div class="record-head">
                <p class="record-title">
                  {{ view.revision.fuel }}
                  <span class="version-tag">基线 v{{ view.revision.baseVersion }}</span>
                </p>
                <span :class="statusClass(view.analysis.status)">{{ REVISION_LABEL_SAFE(view.analysis.status) }}</span>
              </div>

              <div class="details">
                <span>提交人：{{ view.revision.operator }}</span>
                <span>提交时间：{{ new Date(view.revision.createdAt).toLocaleString() }}</span>
                <span class="details-wide">改动：{{ changeSummary(view.revision.changes) || "—" }}</span>
                <span class="details-wide muted">{{ view.analysis.reason }}</span>
              </div>

              <!-- 同一字段两边都改过：并排列出双方值，逐项裁决 -->
              <div v-if="view.analysis.status === 'conflict'" class="conflicts">
                <p class="conflicts-title">同字段双方均修改，请逐项选择保留值：</p>
                <div v-for="conflict in conflictDrafts[view.revision.id]" :key="conflict.field" class="conflict-row">
                  <span class="conflict-label">{{ conflict.label }}</span>
                  <label :class="['conflict-option', { chosen: conflict.choice === 'mine' }]">
                    <input type="radio" :name="`${view.revision.id}-${conflict.field}`" value="mine" v-model="conflict.choice" />
                    <span class="conflict-side">本窗口</span>
                    <strong>{{ displayValue(conflict.mine) }}</strong>
                  </label>
                  <label :class="['conflict-option', { chosen: conflict.choice === 'theirs' }]">
                    <input type="radio" :name="`${view.revision.id}-${conflict.field}`" value="theirs" v-model="conflict.choice" />
                    <span class="conflict-side">同伴（已生效）</span>
                    <strong>{{ displayValue(conflict.theirs) }}</strong>
                  </label>
                  <label :class="['conflict-option', 'conflict-custom', { chosen: conflict.choice === 'custom' }]">
                    <input type="radio" :name="`${view.revision.id}-${conflict.field}`" value="custom" v-model="conflict.choice" />
                    <span class="conflict-side">自定义</span>
                    <input v-model="conflict.custom" type="text" placeholder="输入裁决值" />
                  </label>
                </div>
                <div class="actions">
                  <button type="button" @click="confirmRevision(view.revision.id, true)">按裁决确认并生成新快照</button>
                  <button type="button" class="danger" @click="rollback(view.revision.id)">回退</button>
                </div>
              </div>

              <div v-else class="actions">
                <button
                  v-if="view.analysis.status === 'needs_recheck'"
                  type="button"
                  @click="rebase(view.revision.id)"
                >
                  值班经理重新确认（基线推进 v{{ store.version }}）
                </button>
                <button
                  type="button"
                  :disabled="view.analysis.status === 'needs_recheck'"
                  @click="confirmRevision(view.revision.id, false)"
                >
                  确认生效
                </button>
                <button type="button" class="secondary" @click="copySummary(view.revision)">复制摘要</button>
                <button type="button" class="danger" @click="rollback(view.revision.id)">回退</button>
              </div>
            </article>
          </div>
        </section>
      </section>

      <!-- 写入失败后的未完成动作：保留重试 -->
      <section v-if="store.retries.length" class="retry-panel">
        <h2>写入失败 · 未完成动作（{{ store.retries.length }}）</h2>
        <p class="panel-hint">已从最后一个完整快照恢复有效价，以下修订保留未完成状态，可重试或放弃。</p>
        <div v-for="item in store.retries" :key="item.id" class="retry-item">
          <div>
            <strong>{{ RETRY_LABEL[item.action] }}</strong>
            <span class="muted">（已尝试 {{ item.attempts }} 次）</span>
            <p class="muted">{{ item.lastError }}</p>
          </div>
          <div class="actions">
            <button type="button" @click="retry(item.id)">重试</button>
            <button type="button" class="secondary" @click="dismissRetry(item.id)">放弃</button>
          </div>
        </div>
      </section>

      <section class="lower-grid">
        <!-- 有效价快照 -->
        <section class="panel">
          <h2>有效价快照</h2>
          <p class="panel-hint">每次经理确认生成一份完整快照；统计只取当前版本。</p>
          <div class="snapshot-list">
            <article
              v-for="snapshot in [...store.snapshots].reverse()"
              :key="snapshot.version"
              :class="['snapshot', { current: snapshot.version === store.version }]"
            >
              <div class="snapshot-head">
                <strong>v{{ snapshot.version }}</strong>
                <span v-if="snapshot.version === store.version" class="status">当前有效价</span>
                <span class="muted">{{ new Date(snapshot.createdAt).toLocaleString() }} · {{ snapshot.author }}</span>
              </div>
              <div class="snapshot-prices">
                <span v-for="fuel in FUELS" :key="fuel">
                  {{ fuel }}：<strong>¥{{ displayValue(snapshot.prices[fuel]?.price) }}</strong>
                </span>
              </div>
              <p class="muted">{{ snapshot.note }}</p>
              <div class="actions">
                <button
                  v-if="snapshot.version !== store.version"
                  type="button"
                  class="secondary"
                  @click="restore(snapshot.version)"
                >
                  恢复到此版本
                </button>
              </div>
            </article>
          </div>
        </section>

        <!-- 调价记录（审计流水，只追加） -->
        <section class="panel">
          <h2>调价记录</h2>
          <p class="panel-hint">提交、确认、回退、迁移与恢复的完整流水。</p>
          <div class="audit-list">
            <article v-for="entry in filteredAudit.slice(0, 30)" :key="entry.id" class="audit-item">
              <div class="audit-head">
                <span class="audit-kind">{{ AUDIT_LABEL[entry.kind] }}</span>
                <span :class="entry.effectiveVersion ? 'version-tag live' : 'version-tag'">
                  {{ entry.effectiveVersion ? `v${entry.effectiveVersion} 生效` : "待确认" }}
                </span>
              </div>
              <p v-if="entry.fuel !== '全部油品'" class="audit-line">
                {{ entry.fuel }}<template v-if="changeSummary(entry.changes)"> · {{ changeSummary(entry.changes) }}</template>
              </p>
              <p v-else class="audit-line">{{ entry.note }}</p>
              <p class="muted">{{ entry.operator }} · {{ new Date(entry.createdAt).toLocaleString() }}</p>
            </article>
            <div v-if="filteredAudit.length === 0" class="empty">暂无调价记录</div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
