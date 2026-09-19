# T4 实施报告：按书籍同步进度，进度故障不挡正文

## 范围与提交

- 起始 commit：`48a769f2363af3aaa9a9c7668ffc0d42ae7611ef`（T3 已批准版本）。
- 实现 commit：`f10b127`，`fix: retain pending progress and reconcile saves per book`。
- 报告将作为后续独立提交保存。
- 未修改 Rust/backend、数据库迁移、API/architecture 文档，也未启动子代理。
- `frontend/test-results/` 为 Playwright 临时产物，未纳入提交。

## T0—T7 状态

- T0：本次未改动；新增 E2E 全部使用 `page.route()` mock，不连接真实后端或用户书库。
- T1：本次未改动；既有扫描/书架能力保持原状。
- T2：保留现有 request scope、reader ticket 和换书 fence。为 route-change 最终捕获增加有界恢复后检查，避免恢复窗口内的迟到 scroll 丢失；不改变 T2 的异步身份隔离。
- T3：后端保持不变。前端 normalize/save payload 保留 `version`、`mutation_id`、`base_version`、`position_kind`、`paragraph_fraction`，PUT/keepalive/Beacon 使用同一版本化载荷。
- T4：已实现并验证，见下文。
- T5：未实现坐标算法、段落锚点或恢复重设计；仅透传可选位置字段。
- T6：未实施；关闭时 Beacon/keepalive 仍是尽力发送，未确认记录会继续留在 v2 缓存。
- T7：未实施；未引入全文索引数据库或大范围重构。

## T4 实现摘要

- 新增纯依赖注入 `createProgressSync()`，状态按书籍维护：`confirmed`、不可变 `submitted`、最新 `pending`、`conflict`。
- `txt-reader-progress-v2` 按 `book_id` 持久化；旧 `txt-reader-progress` 仍可读取并迁移，不清空旧 key。
- 每书单飞，A 的慢请求不阻塞 B；M1 成功只确认 M1，期间的 M2 保留并使用返回的版本继续发送。
- 失败只结束本次 flush；submitted 重试复用同一 mutation/base/payload，不在一次 flush 内无限重试。
- submitted 在网络调用前先持久化；localStorage 失败保留内存状态并给出安全提示，不递归重复写入。
- 409/428 保存冲突保留 local/remote 两份，UI 提供“继续本地位置”和“使用服务器位置”。
- 正文与进度 GET 解耦；进度 GET 失败不会伪造 `reconcile(bookId, null)`，正文仍可打开。
- App.tsx 的滚动、定时、交互结束、route-change、EPUB 保存均进入队列；响应按 book/session reader fence 使用，不把旧书响应应用到当前书。

## RED → GREEN 与验证

初始 RED：

- `npx vitest run src/progress-sync.test.js src/progress.test.js`：progress-sync 模块尚不存在，且新增 progress 字段断言 2 项失败。
- 初次 Playwright 使用 bundled Chromium 时因本机缺少 `chrome-headless-shell` 无法启动；随后按项目约定改用系统 Chrome。

最终 GREEN：

- `npm run test --prefix frontend`：8 个测试文件、40/40 通过。
- `npm run build --prefix frontend`：成功；仅有既有的 bundle >500 kB 警告。
- `PW_CHANNEL=chrome npx playwright test e2e/progress-sync.spec.js e2e/reader-races.spec.js e2e/reader-regressions.spec.js --config frontend/playwright.config.js --reporter=line`：12/12 通过。
- T4 新增 E2E 覆盖：两书独立队列、进度 GET 失败正文可读、reload 后 submitted 使用相同 mutation 重试。
- Rust/cargo 未运行，因为 backend 未修改。

## 边界与未验证范围

- 退出路径的 Beacon/keepalive 不会把记录标成 confirmed；若浏览器在退出时中断请求，pending/submitted 仍需下次打开恢复。
- 内容被修改后的精确定位仍属于 T5；本次没有引入新的坐标或段落恢复算法。
- 仅验证 Windows 系统 Chrome；未运行 WebKit、移动真机或真实后端联调。
- 未加入章节识别、LLM、全文索引数据库、软删除管理或全项目重构。
