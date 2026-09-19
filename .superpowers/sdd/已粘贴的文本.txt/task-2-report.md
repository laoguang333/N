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

## T2 final fix round（2026-09-19）

本轮针对最后两项 reviewer 要求完成收口：

- periodic save completion 现在区分 originating reader ticket/book。A 在切换到 B 后失效时，晚到的 A completion 不会改变 B 的成功/失败状态或复用 A 的退避计数；它会为当前仍有效的 reader session 安排下一次 periodic attempt，避免 periodic loop 停止。
- `reader-races.spec.js` 新增可控 timer/deferred API 的 periodic-save 回归：A 的 periodic save 返回失败并在切书后完成，B 仍产生实际 periodic write，且 A failure 不显示在 B。
- `shelf-races.spec.js` 新增 debounce-window 回归：输入从 A 改为 B 后，A 响应在 B 的 180ms debounce 尚未发起期间返回；断言 A 从未可见，随后 B 正常可见。所有 `/api/**` 请求均由 route mock 处理。

### Final TDD / verification evidence

- RED/fixture checkpoint：periodic 回归首跑发现测试 fixture 未允许 A 的 background POST，报 `Unexpected API request: POST .../api/books/1/progress`；补齐 PUT/POST mock 后 GREEN。普通 Playwright Chromium 首跑因本机缺少 Playwright bundled executable；按要求改用 `PW_CHANNEL=chrome`，新增 debounce 用例和 periodic 用例均通过。
- `npm run test --prefix frontend`：6 个 Vitest 文件、27 个测试通过。
- `npm run build --prefix frontend`：通过；只有既有的大 chunk warning。
- `cargo clippy`：通过；未修改 Rust。
- `PW_CHANNEL=chrome npx playwright test --config frontend/playwright.config.js frontend/e2e/reader-races.spec.js frontend/e2e/shelf-races.spec.js frontend/e2e/shelf.spec.js --workers=1`：11/11 通过（reader races 4、shelf races 6、existing shelf 1）。
- 已恢复 tracked 的 `frontend/test-results/.last-run.json`，并清理本轮生成的 test-results artifacts；没有把生成物提交。

本轮仍未处理或弱化 `reader-regressions.spec.js` 的已知位置恢复失败；它属于 T5。T3/T4/T5/T7、Rust 文件和 T4 queue 均未修改。

## T2 reviewer fix round（2026-09-19，generation/query fences）

- 每次 `openBook` 创建 reader generation 时重置 `saveFailureCount` 和 `lastSaveSucceeded`，因此 B 不继承 A 的 periodic backoff/failure state。
- shelf 与 FolderOverlay 都记录当前 rating operation。query/tag/close invalidation 只清除属于被失效 operation 的 `ratingBookId`；旧 success/error/finally 不能留下禁用状态，也不能清除新 operation 的 loading marker。
- `loadBooks` 在读取 shelf state 的 Promise await 之后、发出 `getShelf` 之前再次检查 `shelfScope.isCurrent(ticket)`，满足每个 await 后的 fence 要求。
- shelf/folder race E2E 改为复用同一 book id 的新 query/folder 结果，并断言新视图中的 rating button 已重新 enabled；修改前两项断言均 RED，加入 operation invalidation 后 GREEN。

### Verification

- `npm run test --prefix frontend`：27/27 Vitest tests 通过。
- `npm run build --prefix frontend`：通过；仅有既有 chunk-size warning。
- `cargo clippy`：通过；未修改 Rust。
- `PW_CHANNEL=chrome npx playwright test --config frontend/playwright.config.js frontend/e2e/reader-races.spec.js frontend/e2e/shelf-races.spec.js frontend/e2e/shelf.spec.js --workers=1`：11/11 通过。
- 曾尝试增加独立 generation-backoff E2E；该测试在 reader restoration 尚未解除 `restoreSavingBlocked` 时等待 periodic write，无法形成有效的 backoff 断言，已删除而未弱化现有 periodic-loop race。实现重置仍由 build、全量 race suite 和 `openBook` 路径覆盖。
- 已恢复 tracked 的 `frontend/test-results/.last-run.json`，并清理本轮 artifacts；生成物未提交。

本轮未触碰 Rust、T3/T4/T5/T7；已知 T5 reader position regression 仍按前述报告保留。
