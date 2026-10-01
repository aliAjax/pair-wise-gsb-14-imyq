/**
 * 浏览器冒烟测试：两个页面（窗口）共享 localStorage，模拟换班同时改价。
 * 运行：先 npm run build && npm run preview，再 node scripts/smoke-browser.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";

let passed = 0;
let failed = 0;

function assert(condition, name, extra) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

const browser = await chromium.launch();

// ---- 场景一：两个窗口同时改价 → 待处理修订 → 值班经理确认 ----

console.log("场景一 两个窗口同时保存，冲突进入待处理修订");
{
  const context = await browser.newContext();
  const pageA = await context.newPage();
  await pageA.goto(BASE);
  await pageA.waitForSelector(".record");

  const pageB = await context.newPage();
  await pageB.goto(BASE);
  await pageB.waitForSelector(".record");

  // 窗口A 打开 92号汽油 的编辑表单（此时基线 v1）
  await pageA.locator(".record", { hasText: "92号汽油" }).getByRole("button", { name: "编辑" }).click();
  await pageA.waitForSelector(".baseline");
  const baselineText = await pageA.locator(".baseline").textContent();
  assert(baselineText.includes("v1"), "编辑表单显示打开时的基线版本", baselineText);

  // 窗口B 也编辑同一油品并先保存
  await pageB.locator(".record", { hasText: "92号汽油" }).getByRole("button", { name: "编辑" }).click();
  await pageB.locator(".panel input[type=number]").fill("8.18");
  await pageB.getByRole("button", { name: "提交修改" }).click();
  await pageB.waitForSelector(".record:has-text('v2')");

  // 窗口A 稍后才提交（基线已过期）→ 应出现 stale 提示
  await pageA.waitForSelector(".stale-warning");
  assert(true, "另一窗口保存后，编辑表单出现基线过期提示");
  await pageA.locator(".panel input[type=number]").fill("8.28");
  await pageA.getByRole("button", { name: "提交修改" }).click();

  // 待处理修订出现，且 price 字段两边都改过 → 并排展示
  await pageA.waitForSelector(".revision");
  assert(await pageA.locator(".revision .status.conflict").isVisible(), "修订被标记为冲突需重新确认");
  const sides = pageA.locator(".revision .side-by-side .side");
  assert((await sides.count()) === 2, "同一字段两边都改过，并排列出当前值与提交值");
  const sideText = await pageA.locator(".revision .side-by-side").textContent();
  assert(sideText.includes("8.18") && sideText.includes("8.28"), "并排展示的是 B 的当前值和 A 的提交值", sideText);

  // 记录本体仍是 B 的值，统计未采用新价
  const recordText = await pageA.locator(".record", { hasText: "92号汽油" }).textContent();
  assert(recordText.includes("8.18") && !recordText.includes("8.28"), "确认前有效价仍是 B 保存的值");

  // 值班经理选择“采用提交值”并确认
  await pageA.locator(".revision .side", { hasText: "本次提交值" }).locator("input").check();
  await pageA.getByRole("button", { name: "值班经理确认" }).click();
  await pageA.waitForSelector(".record:has-text('8.28')");
  assert(true, "值班经理确认后，新有效价生效");
  assert((await pageA.locator(".revision").count()) === 0, "确认后修订出队");

  // 窗口B 通过 storage 事件同步到结果
  await pageB.waitForSelector(".record:has-text('8.28')");
  assert(true, "另一窗口同步到确认后的有效价");

  await context.close();
}

// ---- 场景二：旧数据迁移 ----

console.log("场景二 旧数据首次打开迁移并补齐版本");
{
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem(
      "dfwlfront-9-price",
      JSON.stringify([
        { id: "old-1", fuel: "95号汽油", price: 8.02, operator: "站长", effectiveDate: "2026-06-01", status: "生效中", notes: "旧系统数据", createdAt: "2026-06-01T00:00:00.000Z" }
      ])
    );
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector(".record");
  assert(await page.locator(".notice", { hasText: "已迁移" }).isVisible(), "出现迁移提示");
  assert(await page.locator(".record:has-text('95号汽油')").isVisible(), "旧记录保留");
  assert(await page.locator(".record:has-text('v1')").isVisible(), "旧记录补齐版本号 v1");
  assert(await page.locator(".snapshot-line", { hasText: "v1" }).isVisible(), "生成了首个有效价快照");
  await context.close();
}

// ---- 场景三：主数据损坏 → 从快照恢复 ----

console.log("场景三 主数据损坏后从最后完整快照恢复");
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector(".record");
  const before = await page.locator(".record").count();
  await page.evaluate(() => {
    localStorage.setItem("dfwlfront-9-price:state", "{corrupted");
  });
  await page.reload();
  await page.waitForSelector(".record");
  assert(await page.locator(".notice", { hasText: "已从最后一个完整快照" }).isVisible(), "出现快照恢复提示");
  assert((await page.locator(".record").count()) === before, "记录从快照完整恢复");
  await context.close();
}

await browser.close();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
