# T2 实施报告

日期：2026-09-19

## 提交与范围

- 起始 commit：`64e3644210b9b2bbc229a6217b56d07515d7fa9d`（`fix: address T1 scan review findings`）。
- 结束状态：本报告与下列 T2 文件一起提交；最终 commit hash 在本次交付回复中给出。
- 起始工作区没有既有未提交修改；没有改动用户既有修改。
- 未触碰 Rust 文件、数据库 schema、T3/T4/T5/T7 实现。

## T2 完成内容

- 新增 `frontend/src/request-scope.js`：`begin()`、`isCurrent(ticket)`、`invalidate()`，新世代会 abort 旧 signal，离开时会使旧 ticket 失效。
- `frontend/src/api.js` 的 shelf、book、content、progress 及相关保存调用支持可选 options/signal；保留旧调用形状。
- HTTP 错误保留 `status`、`code`、`current`；Fetch 的 `AbortError` 原样传播。
- `App.tsx` 使用独立 shelf/reader scope；输入/筛选变化在 180ms debounce 前立即失效旧 shelf 查询。
- `FolderOverlay.tsx` 使用独立 folder scope；旧 folder 响应不能覆盖当前 folder，也不能在关闭后重新显示。
- reader open 每次创建新 generation；load、catch、恢复、RAF、timeout、seek、滚动保存和保存响应均按 route/book/generation 保护。
- 保存响应先验证 `saved.book_id`，按保存所属书更新缓存；只有仍处于同一书、同一 reader generation 时才更新当前 reader 状态。
- 新增 `frontend/e2e/reader-races.spec.js`、`frontend/e2e/shelf-races.spec.js`，所有 `/api/**` 请求都由 route mock 处理，未知 API 直接抛错。

## TDD 证据

1. `request-scope.test.js` 先运行 RED：因 `./request-scope` 不存在而失败；加入最小实现后 GREEN。
2. `api.test.js` 先运行 RED：signal 未透传且 HTTP error 没有 `status/code/current`；加入兼容层后 GREEN。
3. 新 race E2E 在旧实现上先出现 2 个失败（慢 shelf 查询覆盖新结果，以及保存 race fixture 未能建立隔离响应）；完成 scope/fence 后对应 T2 focused suite GREEN。

## 验证命令与结果

- `npm run test --prefix frontend`：6 个 Vitest 文件、27 个测试通过。
- `npm run build --prefix frontend`：通过；Vite 仅报告既有的大 chunk warning。
- `cargo clippy`：通过；本次没有 Rust 变更。
- `PW_CHANNEL=chrome npx --prefix frontend playwright test --config frontend/playwright.config.js frontend/e2e/reader-races.spec.js frontend/e2e/shelf-races.spec.js frontend/e2e/shelf.spec.js --workers=1`：5/5 通过。
- `reader-regressions.spec.js`：5 项中 4 项通过，`saves the paragraph reached by scrolling and restores it after reload` 失败；单独重跑该用例仍失败。失败表现是刷新后目标段落 `p[data-offset="2258"]` 未出现在 viewport，当前页面停在约 59% 位置。该回归未被本轮继续扩展处理，不能宣称 reader 全部回归通过。
- WebKit、真实设备未运行；未连接真实后端，所有 focused E2E 均使用 mock API。

## T0–T7 状态

- T0：本任务未修改；未重新验收。
- T1：起始 commit 中已有；本任务未修改，`cargo clippy` 通过。
- T2：已实现并通过 request-scope/API 单测、focused race E2E 和现有 shelf E2E；reader 位置恢复存在上述已知 blocker。
- T3：未实现。
- T4：未实现；本次只加入 T2 保存响应 fence，不加入进度队列。
- T5：未实现。
- T6：未实现。
- T7：未实现。

## 数据与协议说明

本轮没有新增进度协议字段，没有数据库迁移，也没有改变服务端版本协议。新增的只是浏览器请求 options/signal 和前端错误元数据读取。

## 已知边界与排除项

- 已发出的保存请求不会因切书被当作回滚；晚到响应只按其原 book id 处理。
- reader 位置恢复的既有回归仍未解决，见验证结果。
- 本轮没有章节识别、LLM、全文索引数据库、软删除管理、全项目重构，也没有实现 T3/T4/T5/T7。

## T2 reviewer fix round（2026-09-19）

本轮修复并验证了以下 reviewer findings：

- reader save race 现在在 A 响应完成后强制 B 真实滚动并等待 B 的实际写请求；断言 B 至少产生一笔写入，且最后一笔不包含 A 的 `char_offset=999`。
- shelf rating 保存捕获独立 rating ticket 和查询 key；查询变化、更新操作变化、旧错误/成功响应都不能污染当前 shelf。
- FolderOverlay rating 保存捕获独立 rating ticket、folder tag 和 folder query key；切换 folder 或关闭后旧响应/错误不再修改当前弹层。
- `saveEpubProgress` 在 `cacheProgress` 和 `updateReader` 前验证 captured book/ticket；异步响应仍验证 `saved.book_id`。
- periodic save 的 timer、completion、成功/失败退避都按 originating reader ticket/book id fence；旧 A save completion 不会按 A 状态安排或影响 B 的下一轮。
- 新增了可控延迟的 shelf 旧查询 error、stale shelf rating error、stale folder rating error，以及 requestAnimationFrame hold/release 的 stale restore 回归。

### Fix-round TDD evidence

- RED：更新后的 8 项 race suite 先得到 5 passed / 3 failed；两个失败是 shelf/folder stale rating error，另一个是 stale-restore 测试 fixture 未 mock 生产代码会发出的 progress POST。补齐 fixture 后单独运行 stale-restore 用例通过，rating 失败保持为预期生产缺陷证据。
- GREEN：同一 focused race suite 在生产 fences 加入后 8/8 通过。
- 最终 focused suite（race + existing shelf）：9/9 通过，使用 Chrome 与 controllable mock delays。
- `npm run test --prefix frontend`：6 个 Vitest 文件、27 个测试通过。
- `npm run build --prefix frontend`：通过；仍只有既有 chunk-size warning。
- `cargo clippy`：通过；没有 Rust 变更。
- 清理了 Playwright 生成的 `frontend/test-results/.last-run.json` 与本轮 artifacts；未将生成物纳入提交。

本轮仍未重跑并未弱化已知的 `reader-regressions.spec.js` 位置恢复失败；该问题属于 T5，原报告中的 blocker 状态保留。
