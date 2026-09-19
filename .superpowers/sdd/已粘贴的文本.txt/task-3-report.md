# T3 后端进度协议报告

## 范围与提交

- 起始 commit：`33678a27a427bc1eb1a156fede9a52b907fc4d54`
- 本次只实施 T3；未修改 React/frontend queue、`App` 或 `docs/architecture.md`。
- 开始时工作区干净，没有需要保留的用户既有未提交修改。
- T1 的 `scan_lock` 与 `scan_in_progress` 保留；扫描相关测试继续通过。

## RED/GREEN 证据

先新增迁移、协议、映射、幂等、冲突、并发和缺失记录测试，再运行：

```text
cargo test migrate_progress_fields -- --nocapture
cargo test save_progress -- --nocapture
```

RED 结果：编译失败，出现预期的 `E0560`/`E0609`，因为生产模型尚未有
`mutation_id`、`position_kind`、`paragraph_fraction` 字段；同时请求未实现 `Clone`。
这证明新测试不是对旧实现的假通过。

GREEN 结果：

- `cargo test progress -- --nocapture`：10 passed, 0 failed
- `cargo test migrate -- --nocapture`：2 passed, 0 failed
- `cargo test -- --nocapture`：26 passed, 0 failed
- 并发首次写入测试额外重复 5 次：`[0, 0, 0, 0, 0]`
- `cargo fmt --all -- --check`：通过
- `cargo clippy --all-targets --no-deps -- -D warnings`：通过
- `git diff --check`：无 diff 错误

## 实际修改

### 数据库与模型

`reading_progress` 新增可空列：

- `last_mutation_id TEXT NULL`
- `position_kind TEXT NULL`
- `paragraph_fraction REAL NULL`

新库的建表语句和旧库的逐列迁移都支持这些字段。迁移重复执行不会重建表，保留已有
book、rating、char offset、percent、locator、version 和时间值；旧记录的新字段保持
`NULL`。

`ReadingProgress` 现在返回整数 `version`、`mutation_id`、`position_kind`、
`paragraph_fraction`。`SaveProgressRequest` 接受可选 `base_version`、`mutation_id`、
`position_kind`、`paragraph_fraction`，并保留原有字段。

### API 与错误语义

- list、shelf、book 和 progress 查询均映射完整进度字段。
- 缺少 `base_version` 或缺少/为空 `mutation_id` 返回 HTTP 428，code 为
  `progress_protocol_upgrade_required`。
- 负版本、超过 128 字节的 mutation、未知位置类型、不合法或缺失的段落比例返回 400。
- 当前支持的位置类型为 `paragraph_utf16_lf_v1`，其比例必须为有限的 `0..1`。
- 冲突返回 HTTP 409、code `progress_conflict`，并携带 `current`；没有当前记录时为
  `null`。缺书仍返回 404。`scan_in_progress` 的 HTTP 409 行为未改变。

### 原子保存与幂等

- `base_version = 0` 使用 `INSERT ... ON CONFLICT(book_id) DO NOTHING RETURNING`。
- 已有记录使用包含 `version = base_version` 和 mutation inequality 的条件
  `UPDATE ... RETURNING`。
- `RETURNING` 无行时读取当前记录：相同 mutation 且完整载荷一致返回原记录，不递增
  version 或 updated_at；相同 mutation 但载荷改变，或版本不同，返回结构化冲突。
- 没有 `INSERT OR REPLACE`、删除重插或成功后的猜测式 SELECT。
- SQLite 临时数据库并发测试证明首次竞争不会产生 UNIQUE 500；一方成功，另一方得到
  409。显式回退保存允许，不按历史最大百分比拒绝。
- 保存过程不使用 `expect`；写入期间记录消失会返回 404 或带 `current: null` 的冲突。

## 新增/更新回归测试

- `migrate_creates_progress_version_and_rating_columns`
- `migrate_preserves_legacy_progress_values_and_is_idempotent`
- `save_progress_requires_the_versioned_protocol`
- `save_progress_is_idempotent_and_conflict_safe`
- `save_progress_rejects_invalid_protocol_values`
- `progress_fields_are_mapped_by_all_book_endpoints`
- `concurrent_first_progress_writes_are_insert_or_conflict`
- `save_progress_missing_book_or_progress_returns_structured_error`
- 原有 `scan_lock_rejects_overlapping_scan` 仍通过。

## 未实施内容

T4 的 frontend queue、T5/T6 的位置捕获与恢复、T7 的搜索性能，以及 T0/T1/T2/T5/T6/T7
其他工作均未在本任务中实施。页面关闭时 pending 的本地确认语义、内容被修改后的定位、
挂载盘空目录识别等边界仍属于后续任务；本次没有加入章节识别、LLM、全文索引数据库、
软删除管理或全项目重构。
