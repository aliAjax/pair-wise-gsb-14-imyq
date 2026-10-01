# 油品价格维护

- 行业：石油
- 技术栈：Vue3、Vite、TypeScript、Pinia、Naive UI
- 启动：`npm install && npm run dev`
- 构建：`npm run build`
- 逻辑测试：`npm test`（并发 / 迁移 / 快照恢复，Node 环境模拟两个窗口）
- 浏览器冒烟：`npm run build && npm run preview`，再执行 `node scripts/smoke-browser.mjs`（需要 playwright-core 与 chromium）

这是一个功能最小闭环前端项目，数据默认保存在浏览器localStorage中，方便后续扩展接口、权限、图表或地图能力。

## 多窗口并发调价设计

针对换班时两个窗口同时改挂牌价互相覆盖的问题，调价记录、有效价快照、待处理修订三条数据链如下协作：

- **基线版本**：每条调价记录带 `version`。点"编辑"时表单记下打开那一刻的版本与字段值；提交只带字段级 diff，不再整记录覆盖，同伴改过的字段和待确认状态不会被旧表单盖回去。
- **待处理修订**：提交时若记录版本已领先基线（另一窗口先保存），本次修改不直接落库，转入待处理修订队列；另一窗口再次改动后，队列里的修订会自动重算冲突、标记"需重新确认"。
- **并排确认**：同一字段两边都改过的，并排展示"当前生效值 / 本次提交值"，值班经理逐字段取舍后确认；确认前统计（平均挂牌价）只算已确认生效的记录，确认后立即改用新有效价。
- **迁移**：旧版本数据（无版本号的记录数组）第一次打开时自动补齐 `version`/`updatedAt` 迁入新结构，原始内容备份在 `dfwlfront-9-price:legacy-backup`。
- **写失败恢复**：`records + revisions` 作为整体单键原子写入（`dfwlfront-9-price:state`），成功后落一份到最后完整快照（`dfwlfront-9-price:snapshot`）。写失败时主键原样未动、内存以持久化内容为准回滚；主键损坏时从最后完整快照恢复；未完成的修订随快照保留，可重试。

存储键一览：

| 键 | 内容 |
| --- | --- |
| `dfwlfront-9-price` | 旧版本数据（迁移后移除） |
| `dfwlfront-9-price:state` | 主数据：调价记录 + 待处理修订（原子写入） |
| `dfwlfront-9-price:snapshot` | 最后一个完整快照，用于恢复 |
| `dfwlfront-9-price:legacy-backup` | 迁移前的旧数据备份 |
