# Architecture

TXT Reader 是一个单机自托管应用，后端负责扫描本地文件、读写 SQLite 和提供 JSON API，前端负责书架、阅读页和本地阅读设置。

## 后端

主要模块：

- `src/main.rs`：加载配置、连接数据库、执行迁移、可选启动扫描、组装 Axum 路由和静态文件托管。
- `src/config.rs`：读取 `config.toml`，缺省字段使用内置默认值。
- `src/db.rs`：创建 SQLite 连接池，执行内嵌迁移。
- `src/library.rs`：扫描 TXT/EPUB 书库、读取 TXT 内容、提供书籍路径给 API。
- `src/api.rs`：HTTP API、查询参数校验、评分和进度保存。
- `src/models.rs`：API 请求与响应结构。

## 数据库

`books` 保存书籍索引：

- `title`：由文件名 stem 得到。
- `file_path`：规范化后的绝对路径，唯一。
- `file_hash`：文件内容 SHA-256。
- `size`、`mtime`：用于判断文件是否未变化。
- `encoding`：扫描时识别的编码名。
- `format`：`txt` 或 `epub`。
- `rating`：可空的 1-5 星评分。

`reading_progress` 保存阅读进度：

- `book_id`：对应 `books.id`，级联删除。
- `char_offset`：前端当前段落偏移。
- `percent`：滚动进度，范围 `0..1`。
- `locator`：EPUB CFI 位置，TXT 为空。

## 扫描流程

1. 确保 `library_dirs` 中的目录存在。
2. 根据 `scan_recursive` 决定只扫描最外层还是递归扫描子目录。
3. 遇到 TXT/EPUB 文件后先比较已有记录的 `size` 和 `mtime`，未变化则跳过更新。
4. 新文件或变化文件按路径更新数据库元数据，不再计算内容 hash 或用 hash 匹配移动文件。
5. 扫描结束后删除书库中已不存在的记录。

扫描只会删除当前配置书库范围内的记录。修改 `scan_recursive` 会改变“书库范围”的定义。

## 前端

`frontend/src/App.tsx` 负责顶层路由和页面组合：

- Hash 路由：`#/` 为书架，`#/reader/{id}` 为阅读页。
- 书架筛选排序直接映射到 `GET /api/shelf` 查询参数。
- 评分按钮调用 `PUT /api/books/{id}/rating`。
- 阅读页滚动后防抖保存进度，离开页面时用 `keepalive` 尝试发送最后进度。

TXT 纯逻辑在 `frontend/src/reader.js`：

- 阅读设置解析和边界限制。
- TXT 段落拆分。
- 书架尺寸和进度标签格式化。

EPUB 阅读在 `frontend/src/EpubReader.tsx`：

- 使用 `epubjs` 在前端解析和渲染 `/api/books/{id}/file`。
- 目录来自 EPUB navigation。
- 阅读位置保存为 EPUB CFI，百分比继续用于书架进度。

React 迁移后的辅助组件：

- `frontend/src/FolderOverlay.tsx`：文件夹分组弹层、分页和评分。
- `frontend/src/AutoScroll.tsx`：阅读页自动滚屏和速度拨盘。

## 开发脚本

- `python scripts/dev.py`：启动后端和前端开发服务器。
- `python scripts/check.py`：执行格式化、Lint、测试和前端构建。

脚本只编排工具，不吞掉失败；任何一步返回非零状态都会停止。
