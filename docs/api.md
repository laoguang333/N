# API

所有接口默认以同源 `/api` 开头，响应体为 JSON。错误响应格式：

```json
{ "error": "message" }
```

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

`scanned` 表示本次遇到的 TXT 文件数。`skipped` 表示 size 和 mtime 未变化，因此未重新读取内容的文件数。

## GET /api/books

查询书架。

查询参数：

- `search`：标题模糊搜索。
- `status`：`all`、`unread`、`reading`、`finished`。
- `min_rating`：最低评分，`1..5`。
- `sort`：`recent`、`title`、`progress`、`rating`。

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
      "updated_at": "2026-04-29T01:10:00.000Z"
    }
  }
]
```

## GET /api/books/{id}

返回单本书的摘要，字段同 `GET /api/books` 的单项。

## GET /api/books/{id}/content

读取整本 TXT 内容。

```json
{
  "book_id": 1,
  "title": "Book",
  "content": "全文内容",
  "length": 12345,
  "encoding": "UTF-8"
}
```

## GET /api/books/{id}/progress

返回阅读进度。未保存过进度时返回 `null`。

```json
{
  "book_id": 1,
  "char_offset": 300,
  "percent": 0.35,
  "updated_at": "2026-04-29T01:10:00.000Z"
}
```

## PUT /api/books/{id}/progress

保存阅读进度。

请求：

```json
{ "char_offset": 300, "percent": 0.35 }
```

`char_offset` 小于 0 时按 0 保存；`percent` 会被限制到 `0..1`，非有限数会返回 400。

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
