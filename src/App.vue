<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { EDITABLE_KEYS, FIELD_LABELS, fields, project } from "./config";
import { usePriceStore, type EditBaseline } from "./store";
import type { FieldValue, PendingRevision, PriceRecord } from "./types";

const store = usePriceStore();
store.init();

type FormState = Record<string, string | number>;

function createBlank(): FormState {
  return Object.fromEntries([
    ...fields.map((field) => [field.key, field.type === "number" ? "" : ""]),
    ["notes", ""]
  ]);
}

const form = reactive<FormState>(createBlank());
const filter = ref(project.filters[0]);
const confirmer = ref("值班经理");
/** 当前编辑上下文：打开表单那一刻的记录版本与字段值（基线） */
const editing = ref<EditBaseline | null>(null);
/** 每个修订里冲突字段的取舍：mine=采用提交值，current=保留当前值 */
const choices = reactive<Record<string, Record<string, "mine" | "current">>>({});

const records = computed(() => store.records);
const revisions = computed(() => store.pendingRevisions);

const filteredRecords = computed(() => {
  if (filter.value.startsWith("全部")) return records.value;
  return records.value.filter((record) => record.fuel === filter.value);
});

const metrics = computed(() => [
  records.value.length,
  revisions.value.length,
  store.averageActivePrice
]);

const maxChart = computed(() => Math.max(1, ...store.chartRows.map((row) => row.value)));

const editingRecord = computed(() =>
  editing.value ? records.value.find((record) => record.id === editing.value?.recordId) : undefined
);

/** 基线已过期：打开表单后另一窗口保存了新版本 */
const isStale = computed(
  () => Boolean(editing.value && editingRecord.value && editingRecord.value.version !== editing.value?.baseVersion)
);

function pickBaseline(record: PriceRecord): Record<string, FieldValue> {
  return Object.fromEntries(
    EDITABLE_KEYS.map((key) => [key, record[key as keyof PriceRecord] as FieldValue])
  );
}

function startEdit(record: PriceRecord) {
  editing.value = {
    recordId: record.id,
    baseVersion: record.version,
    baseValues: pickBaseline(record)
  };
  Object.assign(form, pickBaseline(record));
}

function cancelEdit() {
  editing.value = null;
  Object.assign(form, createBlank());
}

function submit() {
  if (editing.value) {
    // 写失败时保留表单内容，用户可直接重试
    if (store.submitEdit(editing.value, { ...form }, String(form.operator ?? ""))) cancelEdit();
  } else if (store.submitNew({ ...form })) {
    Object.assign(form, createBlank());
  }
}

function fieldLabel(key: string) {
  return FIELD_LABELS[key] ?? key;
}

function recordOf(revision: PendingRevision) {
  return records.value.find((record) => record.id === revision.recordId);
}

function conflictsOf(revision: PendingRevision) {
  return store.revisionConflicts.get(revision.id) ?? [];
}

function currentValue(revision: PendingRevision, key: string): FieldValue {
  const record = recordOf(revision);
  if (!record) return "—";
  return record[key as keyof PriceRecord] as FieldValue;
}

function getChoice(revisionId: string, key: string): "mine" | "current" {
  return choices[revisionId]?.[key] ?? "current";
}

function setChoice(revisionId: string, key: string, value: "mine" | "current") {
  if (!choices[revisionId]) choices[revisionId] = {};
  choices[revisionId][key] = value;
}

function confirm(revision: PendingRevision) {
  store.confirmRevision(revision.id, choices[revision.id] ?? {}, confirmer.value);
  delete choices[revision.id];
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
}

function primaryText(record: PriceRecord) {
  return `${record.fuel} / ${record.price}`;
}

function copySummary(record: PriceRecord) {
  void window.navigator.clipboard?.writeText(primaryText(record));
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业前端最小闭环</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <div v-if="store.notices.length" class="notices">
        <div v-for="notice in store.notices" :key="notice.id" class="notice" :class="notice.kind">
          <span>{{ notice.text }}</span>
          <button type="button" class="notice-close" @click="store.dismissNotice(notice.id)">×</button>
        </div>
      </div>

      <section class="metrics">
        <article v-for="(label, index) in project.metricLabels" :key="label" class="metric">
          <span>{{ label }}</span>
          <strong>{{ metrics[index] }}</strong>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>{{ editing ? `编辑：${editingRecord?.fuel ?? "已删除记录"}` : project.formTitle }}</h2>

          <p v-if="editing" class="baseline">
            打开时基线版本 v{{ editing.baseVersion }}
            <template v-if="editingRecord"> · 当前 v{{ editingRecord.version }}</template>
          </p>
          <p v-if="editing && !editingRecord" class="stale-warning">
            该记录已被另一窗口删除，提交将不会生效。
          </p>
          <p v-else-if="isStale" class="stale-warning">
            另一窗口已保存新版本（v{{ editingRecord?.version }}）。继续提交不会覆盖对方修改，
            将转入待处理修订，由值班经理确认后生效。
          </p>

          <div class="form-grid">
            <label v-for="field in fields" :key="field.key">
              {{ field.label }}
              <select v-if="field.type === 'select'" v-model="form[field.key]" required>
                <option value="">请选择</option>
                <option v-for="option in field.options" :key="option">{{ option }}</option>
              </select>
              <input
                v-else-if="field.type === 'number'"
                v-model="form[field.key]"
                type="number"
                step="0.01"
                min="0"
                required
              />
              <input v-else v-model="form[field.key]" :type="field.type || 'text'" required />
            </label>
            <label>
              备注
              <textarea v-model="form.notes" placeholder="填写处理说明或现场备注" />
            </label>
            <div class="form-actions">
              <button type="submit">{{ editing ? "提交修改" : project.primaryAction }}</button>
              <button v-if="editing" type="button" class="secondary" @click="cancelEdit">取消编辑</button>
            </div>
          </div>
        </form>

        <section class="list-panel">
          <div v-if="revisions.length" class="revisions">
            <div class="toolbar">
              <h2>待处理修订（{{ revisions.length }}）</h2>
              <label class="confirmer">
                确认人
                <input v-model="confirmer" placeholder="值班经理" />
              </label>
            </div>

            <article v-for="revision in revisions" :key="revision.id" class="revision">
              <div class="record-head">
                <p class="record-title">
                  {{ recordOf(revision)?.fuel ?? "目标记录已删除" }}
                  <span class="version-tag">
                    基线 v{{ revision.baseVersion }} → 当前 v{{ recordOf(revision)?.version ?? "—" }}
                  </span>
                </p>
                <span class="status" :class="{ conflict: conflictsOf(revision).length > 0 }">
                  {{ recordOf(revision) ? (conflictsOf(revision).length ? "有冲突·需重新确认" : "待确认") : "无目标" }}
                </span>
              </div>
              <p class="revision-meta">
                {{ revision.submittedBy }} 提交于 {{ formatTime(revision.submittedAt) }}
              </p>

              <div class="change-list">
                <div
                  v-for="(change, key) in revision.changes"
                  :key="key"
                  class="change-row"
                  :class="{ conflicted: conflictsOf(revision).includes(String(key)) }"
                >
                  <template v-if="conflictsOf(revision).includes(String(key))">
                    <span class="change-label">{{ fieldLabel(String(key)) }}（两边都改过）</span>
                    <div class="side-by-side">
                      <label class="side" :class="{ picked: getChoice(revision.id, String(key)) === 'current' }">
                        <input
                          type="radio"
                          :name="`${revision.id}-${String(key)}`"
                          :checked="getChoice(revision.id, String(key)) === 'current'"
                          @change="setChoice(revision.id, String(key), 'current')"
                        />
                        <em>当前生效值</em>
                        <strong>{{ currentValue(revision, String(key)) }}</strong>
                      </label>
                      <label class="side" :class="{ picked: getChoice(revision.id, String(key)) === 'mine' }">
                        <input
                          type="radio"
                          :name="`${revision.id}-${String(key)}`"
                          :checked="getChoice(revision.id, String(key)) === 'mine'"
                          @change="setChoice(revision.id, String(key), 'mine')"
                        />
                        <em>本次提交值</em>
                        <strong>{{ change.to }}</strong>
                      </label>
                    </div>
                  </template>
                  <template v-else>
                    <span class="change-label">{{ fieldLabel(String(key)) }}</span>
                    <span class="change-diff">{{ change.from }} → <strong>{{ change.to }}</strong></span>
                  </template>
                </div>
              </div>

              <div class="actions">
                <button v-if="recordOf(revision)" type="button" @click="confirm(revision)">值班经理确认</button>
                <button class="secondary" type="button" @click="store.rejectRevision(revision.id, confirmer)">驳回</button>
              </div>
            </article>
          </div>

          <div class="toolbar">
            <h2>{{ project.entityLabel }}列表</h2>
            <select v-model="filter">
              <option v-for="item in project.filters" :key="item">{{ item }}</option>
            </select>
          </div>

          <div class="record-grid">
            <div v-if="filteredRecords.length === 0" class="empty">暂无匹配数据</div>
            <article v-for="record in filteredRecords" :key="record.id" class="record">
              <div class="record-head">
                <p class="record-title">
                  {{ primaryText(record) }}
                  <span class="version-tag">v{{ record.version }}</span>
                </p>
                <span class="status">{{ record.status }}</span>
              </div>
              <div class="details">
                <span v-for="field in fields" :key="field.key">{{ field.label }}: {{ record[field.key] }}</span>
              </div>
              <p class="note">{{ record.notes }}</p>
              <p class="revision-meta">更新于 {{ formatTime(record.updatedAt) }}</p>
              <div class="actions">
                <button type="button" @click="startEdit(record)">编辑</button>
                <button class="secondary" type="button" @click="store.flowStatus(record.id)">流转状态</button>
                <button class="secondary" type="button" @click="copySummary(record)">复制摘要</button>
                <button class="danger" type="button" @click="store.removeRecord(record.id)">删除</button>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in store.chartRows" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>

          <p class="snapshot-line">
            有效价快照 {{ store.snapshotMeta ? `v${store.snapshotMeta.version}` : "未生成" }}
            · {{ formatTime(store.snapshotMeta?.savedAt) }}
            <template v-if="store.lastSyncAt"> · 最近同步 {{ formatTime(store.lastSyncAt) }}</template>
          </p>
        </section>
      </section>
    </div>
  </main>
</template>
