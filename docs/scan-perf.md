# 扫描性能分析

## 测试环境

- 库目录: `E:\Videos\小说`
- 文件数量: 7797 个 `.txt` 文件
- 数据库: SQLite (WAL 模式)

## 第二次扫描耗时分解

第二次扫描即所有文件 size + mtime 均未变更，理论应只做 metadata 比对。

| 阶段 | 耗时 | 说明 |
|---|---|---|
| `collect_txt_files` | ~170ms | 文件系统递归遍历，正常 |
| `prepare_scan_file` 循环 | **~3.1s** | 瓶颈所在，逐文件处理 |
| `read_pending_content` | ~76µs | **完全跳过**（无新增/修改文件） |
| `remove_missing_books` | ~30ms | 遍历 DB 检查文件是否存在 |

**总耗时约 3.3 秒。**

## 瓶颈分析

`prepare_scan_file` 对每个文件做了 3 件事，单文件约 400µs：

1. **`fs::metadata(path)`** — 系统调用读文件属性（与 `collect_txt_files` 中的 `entry.metadata()` 重复）
2. **`path.canonicalize()`** — 系统调用解析规范路径
3. **`existing_book_by_path()`** — SQL `SELECT` 按 `file_path` 查库

7797 个文件累积 = ~3.1s。

## 结论

第二次扫描**没有**读文件内容、算 SHA-256、或检测编码——这些在检查 size+mtime 匹配后被正确跳过。慢的主要原因是逐文件做**两次系统调用 + 一次 SQL 查询**，文件数量大时累积明显。

如果后续想优化，思路是：
- `collect_txt_files` 已读到 `metadata`，可以传下去避免重复 `fs::metadata`
- `canonicalize` 可以在收集阶段统一做
- 将 `prepare_scan_file` 中 7797 次单独 SQL 查询合并为**批量查询**（一次查出所有 path 的 size/mtime）
