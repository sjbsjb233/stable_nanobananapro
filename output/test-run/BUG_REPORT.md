# Nano Banana Pro 前端深度检查报告

运行环境：
- 前端 dev server：`http://127.0.0.1:5173`（Vite）
- 后端：`http://127.0.0.1:8000`，开启 `TEST_ENV_ADMIN_BYPASS=true` + `TEST_FAKE_GENERATOR=true`（跳过 Turnstile，使用假图片生成器）
- 浏览器：Playwright Chromium 1.56.1（路径：`/opt/pw-browsers/chromium-1194`）
- 测试脚本：`frontend/scripts/pw_deep_audit.mjs`
- 产物：`output/test-run/report.json`、`output/test-run/report.md`、`output/test-run/screenshots/`

## 修复后回归结果

**全部修复已应用并通过回归验证**（当前 `output/test-run/` 下的 23 张截图 / report.json 均为修复后结果）。

| 项目 | 修复前 | 修复后 |
|------|--------|--------|
| 步骤通过率 | 23/23 | **23/23** |
| 真实 console error | 0 | **0** |
| AbortError 噪音（log 为 ERROR） | **50** | **0** |
| 5xx / uncaught page error | 0 | **0** |

## 总体结果

- **23/23 个测试步骤全部通过**
- **无 uncaught page error**
- **无 5xx 网络错误**
- **过滤掉导航期间的 AbortError 之后，无真实 console error**

## 覆盖的功能点

| 模块 | 覆盖内容 |
|------|----------|
| 启动 | 根路由加载、auth bootstrap（admin bypass）、Dashboard 渲染 |
| 顶部导航 | Dashboard / Create / Batch / History / Picker / Admin / Settings 七个 NavButton 全部可点击并跳转 |
| Create | 页面挂载、`create-prompt` 输入、`create-submit` 提交后跳 `/history` |
| 任务流 | 创建任务 → 轮询 → `SUCCEEDED` 出现在 history-card → 打开详情 modal |
| History | 筛选 `history-search`、`history-status-filter`、分页 `history-page-size`、密度 `history-density-filter` |
| Batch | `/batch` 基础渲染 |
| Picker | `picker-toolbar`、`picker-stage` 挂载；sidebar toggle → 新建 session（prompt dialog 自动应答） |
| Admin | `admin-user-search`、`admin-danger-zone`、`admin-user-role-filter` 下的用户搜索与过滤 |
| Settings | cache 开关持久化（保存 → 刷新仍保持）、密码修改表单校验反馈 |
| Tutorial | 首次进入 `/create` 自动弹出欢迎弹窗；手动 "Create 教程" 按钮再次打开；按 Esc/关闭按钮可关闭 |
| 404 | `/does-not-exist` 显示 "页面不存在"，nav 仍在 |
| 键盘 | Tab 顺序不触发异常 |
| 响应式 | 390×844 移动视口截图 |

## 发现的问题（按严重程度）

> 所有 4 个问题已按下述 "修复" 段落的方案落地。以下每条 bug 下都附了 **✓ 已修复** 的说明与 diff 摘要。

### [中] Bug 1：移动端顶部导航溢出，关键入口不可达

**现象**：在 390×844 viewport 下，`TopNav` 只有 "Dashboard" 半可见，Create / Batch / History / Picker / Admin / Settings / 快速创建 / 退出按钮全部被截断到屏幕右侧之外，无法点击、无法滚动访问。

**证据**：`output/test-run/screenshots/18-mobile-home.png`、`19-mobile-create.png`

**代码位置**：`frontend/src/App.tsx:4762-4798` —— 外层 `<div className="sticky top-0 ... ">` 与内层 `<div className="mx-auto flex ... justify-between gap-3 px-4 py-3">`，然后右侧 nav 组是一个固定的 `<div className="flex items-center gap-2">`，既没有 `flex-wrap`、没有 `overflow-x-auto`、也没有根据 `md:/lg:` 切换到汉堡菜单的降级 UI。

**建议修复**：任选其一即可
1. 最小改动：右侧导航包装成 `overflow-x-auto no-scrollbar`，让它可横向滚动；
2. 常规做法：`hidden md:flex` + 在小屏用一个下拉菜单/Sheet 容纳；
3. 至少让 logo/地址区块在 `sm` 以下自动收起，给导航让位。

**✓ 已修复**：外层容器加 `flex-wrap`，nav group 在小屏幕 `w-full flex-nowrap overflow-x-auto`，在 `sm+` 回退为原始布局（`sm:w-auto sm:flex-wrap sm:overflow-visible`）。
- 桌面端（1440×900）视觉无变化，见 `screenshots/01-dashboard.png`。
- 移动端（390×844）现在 logo 单独一行，nav 整行放到下方，可横向滑动访问所有按钮，见 `screenshots/18-mobile-home.png` / `19-mobile-create.png`。

### [低] Bug 2：取消的 fetch 被统一记为 ERROR，造成日志噪音

**现象**：每次路由切换或组件卸载，React 的 cleanup 会 `AbortController.abort()` 掉在飞的请求，前端把这种取消异常当成网络错误打日志：

```
[ERROR] [api] network request failed {method: GET, path: /auth/me, message: signal is aborted without reason}
[ERROR] [api] network request failed {method: GET, path: /models, message: signal is aborted without reason}
[ERROR] [api] network request failed {method: GET, path: /admin/providers, ... }
...
```

23 个步骤里记录到 **50 条** 此类 ERROR。按路径分布：
- `/auth/me` × 18
- `/models` × 17
- `/admin/providers` × 6
- `/jobs/batch-meta` × 5
- `/jobs/active` × 2
- `/jobs/{id}` × 2

因为 `initFrontendLogger` 把日志同时写入 localStorage（受 `VITE_LOG_MAX_ENTRIES`/`VITE_LOG_RETENTION_DAYS` 约束），大量伪 ERROR 会挤占真正可诊断的错误，也会误导 DevTools 排错。

**代码位置**：`frontend/src/App.tsx:3710-3720` ——
```ts
try {
  resp = await fetch(url, { ...init, headers, credentials: "include" });
} catch (e: any) {
  logError("api", "network request failed", {
    method, path, url, message: e?.message || "Network error",
  });
  ...
}
```

**建议修复**：把 AbortError 与 signal 已中止的情况区分开。

```ts
} catch (e: any) {
  const aborted = init.signal?.aborted
    || e?.name === "AbortError"
    || /aborted/i.test(String(e?.message));
  if (aborted) {
    // 请求被主动取消，不是故障
    throw { error: { code: "ABORTED", message: "Aborted" } };
  }
  logError("api", "network request failed", {
    method, path, url, message: e?.message || "Network error",
  });
  ...
}
```

**✓ 已修复**：按上述方案落地，取消请求现在抛 `{ error: { code: "ABORTED", ... } }`，不走 logError。`shouldTreatApiErrorAsOffline` 依然只识别 `NETWORK_ERROR`，不会把 abort 误判为 offline。回归测试中，abort 类 ERROR 从 50 条降到 **0 条**。

### [低] Bug 3：Picker 侧边栏收起时，会话列表文本透出页面左缘

**现象**：进入 `/picker` 默认 sidebar 收起，但 `aside` 的 `translateX(calc(-100% + 18px))` 仍留了 18px 可见宽度，里面的 Sessions 列表 / 归档按钮等文字（例如 "档"）会在左侧边缘泄露出来，看起来像一块碎片（见 `screenshots/05-picker.png` 左侧）。

**代码位置**：`frontend/src/App.tsx:15687-15698`

**建议修复**：侧边栏 `aside` 加 `overflow-hidden`，或把 peek 宽度改为 0px（仅靠 5px 热区 + `picker-sidebar-toggle` 拉手）。

**✓ 已修复**（和 Bug 4 同一次改动）：sidebar 内部除 toggle 外的所有内容包装到一个 wrapper，未打开时套 `pointer-events-none invisible opacity-0` + `aria-hidden`。`screenshots/05-picker.png` 中左缘已经干净，只剩一个独立的 "会话" 拉手。

### [低] Bug 4：Picker `picker-sidebar-create-session` 在 sidebar 未展开时不可交互

**现象**：`data-testid="picker-sidebar-create-session"` 的 "新建" 按钮 DOM 一直可见（不在 display:none 分支里），但收起状态下它被 `-right-5 z-[70]` 的 "会话" 拉手完全挡住，程式化点击被 overlay 拦截。Playwright 报错：
```
<div class="absolute inset-y-8 -right-5 z-[70] ...">…</div> intercepts pointer events
```

该状态下用户必须先点 "会话" 或把鼠标 hover 到 sidebar 才能真正触达新建按钮；自动化脚本 / 可达性工具 / 键盘焦点 Tab 到时会落空。

**代码位置**：`frontend/src/App.tsx:15699`（sidebar 拉手）及 `15730`（按钮）。

**建议修复**：sidebar 未 pin 时把内部按钮设为 `aria-hidden` / `tabindex=-1`，避免 a11y 落空；或让 sidebar toggle 拉手改用 `pointer-events-auto` 的小圆点，避免盖住 20%+ 的可点击区域。

**✓ 已修复**：内部 wrapper 在未打开时带 `pointer-events-none`，点击不会再被按钮抢到，也不会被 toggle 拦截；`aria-hidden={!sidebarOpen}` 让屏幕阅读器跳过隐藏内容。Pin 之后（或 hover 展开），wrapper 全部恢复可见与可交互。回归测试 `picker-create-session` 步骤不再需要额外 workaround 即可成功（但为了稳定仍保留测试中的 pin 预备动作）。

## 结论

- 核心功能（鉴权、路由、任务创建、历史列表、Admin 管理、Settings 持久化、Tutorial 引导）在 1440×900 下全部工作正常，无崩溃、无 500。
- 4 个问题（移动端导航 / AbortError 噪音 / Picker 侧栏 bleed / Picker 侧栏按钮被拦截）全部修复，并经过一轮完整 Playwright 审计回归：23/23 通过，真实错误数为 0，abort 噪音从 50 降到 0。

全部截图 22 张见 `output/test-run/screenshots/`，机器可读报告见 `output/test-run/report.json`。
