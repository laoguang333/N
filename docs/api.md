# API

所有接口默认以同源 `/api` 开头，响应体为 JSON。错误响应格式：

```json
{ "error": "message", "code": "optional_code", "current": null }
```

阅读进度冲突响应还会在 `current` 中返回服务端当前进度；没有当前记录时为 `null`。

## GET /api/health

健康检查。

```json
{ "ok": true }
```

## GET /api/config

返回前端可展示的运行配置。

```json
{
  "library_dirs": ["novels"],
  "scan_recursive": false,
  "scan_on_startup": false
}
```

## POST /api/library/scan

扫描书库目录。

```json
{
  "scanned": 10,
  "removed": 1,
  "added": 2,
  "updated": 3,
  "skipped": 5,
  "errors": []
}
```

`scanned` 表示本次遇到的 TXT/EPUB 文件数。`skipped` 表示 size 和 mtime 未变化的文件数。

## GET /api/books

查询书架。

查询参数：

- `search`：标题模糊搜索。
- `status`：`all`、`unread`、`reading`、`finished`。
- `min_rating`：最低评分，`1..5`。
- `sort`：`recent`、`title`、`progress`、`rating`。
- `folder_tag`：只返回指定文件夹分组内的小说。

示例：

```text
/api/books?status=reading&min_rating=4&sort=rating
```

响应：

```json
[
  {
    "id": 1,
    "title": "Book",
    "file_path": "C:\\books\\Book.txt",
    "file_hash": "sha256",
    "format": "txt",
    "size": 1024,
    "mtime": 1760000000,
    "encoding": "UTF-8",
    "rating": 5,
    "created_at": "2026-04-29T01:00:00.000Z",
    "updated_at": "2026-04-29T01:00:00.000Z",
    "progress": {
      "book_id": 1,
      "char_offset": 300,
      "percent": 0.35,
      "locator": null,
      "version": 4,
      "mutation_id": "client-mutation-4",
      "position_kind": "paragraph_utf16_lf_v1",
      "paragraph_fraction": 0.25,
      "updated_at": "2026-04-29T01:10:00.000Z"
    }
  }
]
```

## GET /api/shelf

查询混排书架。支持和 `GET /api/books` 相同的筛选参数：`search`、`status`、`min_rating`、`sort`。

响应：

```json
{
  "items": [
    {
      "type": "folder",
      "folder": {
        "name": "Author",
        "book_count": 3,
        "max_rating": 5,
        "max_progress": 0.8,
        "latest_activity": "2026-04-29T01:10:00.000Z"
      }
    },
    {
      "type": "book",
      "book": {
        "id": 1,
        "title": "Book",
        "file_path": "C:\\books\\Book.txt",
        "file_hash": "sha256",
        "format": "txt",
        "size": 1024,
        "mtime": 1760000000,
        "encoding": "UTF-8",
        "folder_tag": null,
        "rating": 5,
        "created_at": "2026-04-29T01:00:00.000Z",
        "updated_at": "2026-04-29T01:00:00.000Z",
        "progress": null
      }
    }
  ],
  "books": [],
  "folders": []
}
```

`items` 是前端应使用的混排列表。`books` 和 `folders` 保留用于兼容旧调用。

## GET /api/books/{id}

返回单本书的摘要，字段同 `GET /api/books` 的单项。

## GET /api/books/{id}/content

读取整本 TXT 内容。EPUB 使用 `GET /api/books/{id}/file` 由前端原生阅读器解析。

```json
{
  "book_id": 1,
  "title": "Book",
  "content": "全文内容",
  "length": 12345,
  "encoding": "UTF-8"
}
```

## GET /api/books/{id}/file

读取 EPUB 原文件流。仅支持 `format = "epub"` 的书籍，响应 `Content-Type: application/epub+zip`，支持 HTTP Range。

## GET /api/books/{id}/progress

返回阅读进度。未保存过进度时返回 `null`。

```json
{
  "book_id": 1,
  "char_offset": 300,
  "percent": 0.35,
  "locator": null,
  "version": 4,
  "mutation_id": "client-mutation-4",
  "position_kind": "paragraph_utf16_lf_v1",
  "paragraph_fraction": 0.25,
  "updated_at": "2026-04-29T01:10:00.000Z"
}
```

## PUT /api/books/{id}/progress

保存阅读进度。

请求：

```json
{
  "char_offset": 300,
  "percent": 0.35,
  "base_version": 4,
  "mutation_id": "client-mutation-5",
  "position_kind": "paragraph_utf16_lf_v1",
  "paragraph_fraction": 0.25
}
```

EPUB 进度使用 CFI：

```json
{
  "char_offset": 0,
  "percent": 0.35,
  "locator": "epubcfi(...)",
  "base_version": 4,
  "mutation_id": "client-mutation-5"
}
```

`base_version` 与非空 `mutation_id` 是必需字段；缺少任一字段返回 HTTP 428，错误码为
`progress_protocol_upgrade_required`。`base_version` 必须非负，`mutation_id` 长度为
1..128 字节。`position_kind` 当前只支持 `paragraph_utf16_lf_v1`；使用该格式时
`paragraph_fraction` 必须是有限的 `0..1` 数值。非法值返回 400。

`char_offset` 小于 0 时按 0 保存；`percent` 会被限制到 `0..1`，非有限数会返回 400。
服务端按 `base_version` 做条件更新，旧版本不会覆盖当前进度。相同 `mutation_id` 与完全相同
载荷的重试返回原确认记录（HTTP 200），不会递增 `version` 或 `updated_at`。`mutation_id`
是全局写入 ID：不能用于另一本文本、另一位置或另一载荷；违反时返回 HTTP 409、错误码
`progress_conflict`，并在 `current` 中标识已占用该 ID 的进度记录。
其他版本冲突同样返回 HTTP 409、错误码 `progress_conflict`，并带当前记录。
首次写入使用 `base_version: 0`。旧数据库记录的 `mutation_id`、`position_kind` 和
`paragraph_fraction` 保持为 `null`，直到新协议写入这些字段。

## PUT /api/books/{id}/rating

保存或清除评分。

请求：

```json
{ "rating": 5 }
```

清除评分：

```json
{ "rating": null }
```

评分必须是 `1..5`，否则返回 400。响应为更新后的 `BookSummary`。
