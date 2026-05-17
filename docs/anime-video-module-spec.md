# Anime Video Module Spec

## 目标

在现有 TXT Reader 中加入本机视频库模块，用于观看电脑里的动画和视频文件。模块代号为 Anime，对应现有底部 `A` 页面。

核心目标：

- 默认视频目录为 `D:\will\[A]`。
- 扫描本机视频文件并建立索引。
- 不在扫描阶段读取完整视频内容，不计算整文件 hash。
- 只读取文件系统元信息和轻量媒体元信息。
- 支持原文件播放，优先不转码、不降质。
- 支持评分、观看进度、观看历史、搜索、筛选和排序。
- 保持界面适合长期使用：信息密度合理、操作直接、状态清晰。

非目标：

- 不做预览图/封面生成。生成缩略图成本较高，先不纳入第一版。
- 不内置 ffmpeg 到安装包。个人使用场景优先复用系统已有 ffmpeg/ffprobe。
- 不实现复杂媒体中心能力，例如刮削番剧 metadata、自动识别季度集数、在线播放源聚合。

## 产品原则

### 播放策略

默认使用原文件播放：

- 后端按 HTTP Range 返回本地文件原始字节。
- 不调用 ffmpeg。
- 不重新编码。
- 不改变分辨率、码率、视频编码或音频编码。
- 适合 MP4、部分 MKV/WebM 等浏览器可直接解码的文件。

备用转码仅作为兼容兜底：

- 当原文件模式无法播放时，用户可切换到备用转码。
- 后端使用系统 ffmpeg 生成 HLS 缓存。
- 前端使用 `hls.js` 播放。
- 备用转码会重新编码，可能降低画质，UI 必须明确标注。

### 元信息扫描

扫描视频库时不得读取完整视频内容。允许读取：

- 文件路径。
- 文件名。
- 扩展名。
- 文件大小。
- mtime。
- 文件夹信息。
- 通过 ffprobe 读取的轻量 metadata，例如 duration、container、video codec、audio codec、resolution。

不允许在扫描阶段：

- 整文件读取。
- 计算完整 SHA-256。
- 解码视频帧。
- 生成缩略图。

文件去重第一版不做强保证。可用 `(normalized_path, size, mtime)` 判断是否变化。后续如果需要更稳定的移动识别，可以增加快速指纹，例如读取文件头尾少量字节，但第一版不做。

## 配置

新增配置字段：

```toml
anime_dirs = ["D:\\will\\[A]"]
anime_scan_recursive = true
anime_scan_on_startup = false
anime_transcode_cache_dir = "data/anime-hls"
```

说明：

- `anime_dirs` 默认值为 `D:\will\[A]`。
- `anime_scan_recursive` 默认 `true`，因为动画通常按文件夹分组。
- `anime_scan_on_startup` 默认 `false`，避免启动时阻塞。
- `anime_transcode_cache_dir` 存放备用 HLS 缓存，不进入数据库备份核心路径。

`GET /api/config` 应增加前端需要展示的字段：

```json
{
  "anime_dirs": ["D:\\will\\[A]"],
  "anime_scan_recursive": true,
  "anime_scan_on_startup": false
}
```

## 支持的文件类型

第一版扫描以下扩展名：

- `.mp4`
- `.m4v`
- `.mkv`
- `.webm`
- `.mov`
- `.avi`
- `.wmv`
- `.flv`
- `.rmvb`

扩展名大小写不敏感。

播放兼容性由浏览器决定。列表中可展示兼容性提示：

- `原文件可尝试播放`：所有视频都可尝试。
- `推荐原文件`：MP4/WebM。
- `可能需要备用转码`：MKV/AVI/WMV/FLV/MOV。



## 数据库

设计原则：

- 视频记录默认不物理删除。
- 扫描发现文件不存在时，只把记录标记为 `missing`。
- 评分、观看进度、观看历史必须保留。
- 文件重新出现时，恢复为 `available`，并刷新 `size`、`mtime`、元信息。
- 只有后续显式提供“清理已删除记录”功能时，才允许物理删除。

新增表：`anime_videos`

```sql
CREATE TABLE anime_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    original_file_path TEXT,
    extension TEXT NOT NULL,
    folder_tag TEXT,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    duration_seconds REAL,
    container TEXT,
    video_codec TEXT,
    audio_codec TEXT,
    width INTEGER,
    height INTEGER,
    rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
    file_state TEXT NOT NULL DEFAULT 'available'
        CHECK (file_state IN ('available', 'missing')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    missing_since TEXT,
    missing_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

字段说明：

- `file_path`：当前规范化绝对路径。即使文件缺失，也保留最后一次路径。
- `original_file_path`：可空，保留首次入库路径；第一版可不使用，但字段为后续移动识别留余地。
- `file_state`：
  - `available`：本次或最近一次扫描确认文件存在。
  - `missing`：扫描发现文件已不存在。
- `last_seen_at`：最近一次扫描确认文件存在的时间。
- `missing_since`：首次发现缺失的时间。
- `missing_reason`：例如 `not_found`、`outside_library_scope`，第一版可只写 `not_found`。

新增表：`anime_progress`

```sql
CREATE TABLE anime_progress (
    video_id INTEGER PRIMARY KEY,
    position_seconds REAL NOT NULL DEFAULT 0,
    percent REAL NOT NULL DEFAULT 0,
    duration_seconds REAL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(video_id) REFERENCES anime_videos(id)
);
```

新增表：`anime_watch_history`

```sql
CREATE TABLE anime_watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    last_position_seconds REAL NOT NULL DEFAULT 0,
    watched_seconds REAL NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(video_id) REFERENCES anime_videos(id)
);
```

索引：

```sql
CREATE INDEX idx_anime_videos_title ON anime_videos(title);
CREATE INDEX idx_anime_videos_folder_tag ON anime_videos(folder_tag);
CREATE INDEX idx_anime_videos_rating ON anime_videos(rating);
CREATE INDEX idx_anime_videos_file_state ON anime_videos(file_state);
CREATE INDEX idx_anime_videos_last_seen_at ON anime_videos(last_seen_at);
CREATE INDEX idx_anime_videos_missing_since ON anime_videos(missing_since);
CREATE INDEX idx_anime_progress_updated_at ON anime_progress(updated_at);
CREATE INDEX idx_anime_watch_history_started_at ON anime_watch_history(started_at);
```

## 后端模块

建议新增：

- `src/anime_library.rs`：扫描视频目录、读取 ffprobe 元信息。
- `src/anime_api.rs`：Anime API。
- `src/anime_models.rs`：Anime 请求响应模型。

也可以先放在现有 `api.rs`，但最终应拆分，避免 `api.rs` 继续膨胀。

## API

所有接口以 `/api/anime` 开头。

### GET /api/anime/tools

返回 ffmpeg/ffprobe 检测结果。

```json
{
  "ffmpeg": "C:\\path\\ffmpeg.exe",
  "ffprobe": "C:\\path\\ffprobe.exe"
}
```

未检测到时字段为 `null`。

### POST /api/anime/library/scan

扫描 Anime 视频目录。

```json
{
  "scanned": 24,
  "added": 3,
  "updated": 2,
  "skipped": 19,
  "marked_missing": 1,
  "restored": 1,
  "errors": []
}
```

扫描行为：

1. 遍历 `anime_dirs`。
2. 根据 `anime_scan_recursive` 决定是否递归。
3. 只处理支持扩展名。
4. 如果路径已存在且 `size`、`mtime` 未变化，则跳过 ffprobe。
5. 新增或变化时运行 ffprobe 获取元信息。
6. 本次扫描见到的文件统一标记为 `available`，更新 `last_seen_at`。
7. 如果原来是 `missing` 的记录再次出现，计入 `restored`，清空 `missing_since` 和 `missing_reason`。
8. 对当前 Anime 库范围内已不存在的视频，不删除数据库记录，只标记为 `missing`，设置 `missing_since` 和 `missing_reason = 'not_found'`。
9. 默认列表不展示 `missing` 视频；历史页面和可选筛选仍可看到缺失视频。

### GET /api/anime/videos

查询视频库。

查询参数：

- `search`：标题和文件夹模糊搜索。
- `status`：`all`、`unwatched`、`watching`、`finished`。
- `availability`：`available`、`missing`、`all`，默认 `available`。
- `min_rating`：最低评分，`1..5`。
- `sort`：`recent`、`title`、`progress`、`rating`、`duration`、`size`。
- `folder_tag`：按文件夹筛选。

响应：

```json
[
  {
    "id": 1,
    "title": "[中文字幕]我的理想异世界生活 第3话",
    "file_path": "D:\\will\\[A]\\show\\ep03.mp4",
    "extension": "mp4",
    "folder_tag": "show",
    "size": 154222656,
    "mtime": 1780000000,
    "duration_seconds": 1000.458333,
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "video_codec": "h264",
    "audio_codec": "aac",
    "width": 1920,
    "height": 1080,
    "rating": 4,
    "file_state": "available",
    "last_seen_at": "2026-05-17T09:00:00.000Z",
    "missing_since": null,
    "progress": {
      "video_id": 1,
      "position_seconds": 300.5,
      "percent": 0.3,
      "updated_at": "2026-05-17T10:00:00.000Z"
    },
    "created_at": "2026-05-17T09:00:00.000Z",
    "updated_at": "2026-05-17T09:00:00.000Z"
  }
]
```

### GET /api/anime/shelf

返回视频和文件夹混排列表，类似现有 `/api/shelf`。

用于 A 首页：

- 文件夹默认只统计 `available` 视频。
- 文件夹展示视频数量、最高评分、最大进度、最近观看时间。
- 单个视频文件夹可折叠为视频项，逻辑沿用小说书架。
- 如果文件夹下全是 `missing` 视频，默认不展示；用户切换到缺失筛选时才展示。

### GET /api/anime/videos/{id}

返回单个视频详情。

### GET /api/anime/videos/{id}/file

原文件播放接口。

要求：

- 支持 HTTP Range。
- 返回 `206 Partial Content`。
- 设置 `Accept-Ranges: bytes`。
- 按扩展名返回合适 `Content-Type`。
- 不调用 ffmpeg。
- 不读取完整文件。
- 如果视频 `file_state = 'missing'` 或路径不存在，返回 404，并提示重新扫描或确认文件位置。

### GET /api/anime/videos/{id}/progress

返回视频进度。未保存时返回 `null`。

```json
{
  "video_id": 1,
  "position_seconds": 300.5,
  "percent": 0.3,
  "duration_seconds": 1000.458333,
  "updated_at": "2026-05-17T10:00:00.000Z"
}
```

### PUT /api/anime/videos/{id}/progress

保存视频进度。

```json
{
  "position_seconds": 300.5,
  "percent": 0.3,
  "duration_seconds": 1000.458333,
  "source": "timeupdate",
  "client_id": "...",
  "session_id": "..."
}
```

保存策略：

- `position_seconds` 小于 0 时按 0 保存。
- `percent` 限制在 `0..1`。
- 非有限数返回 400。
- 播放期间防抖保存，间隔建议 3-5 秒。
- pause、seeked、beforeunload、pagehide 时尽量立即保存。

### PUT /api/anime/videos/{id}/rating

保存或清除评分。

```json
{ "rating": 5 }
```

清除：

```json
{ "rating": null }
```

### POST /api/anime/videos/{id}/watch/start

开始一次观看会话。

```json
{
  "position_seconds": 0
}
```

返回：

```json
{
  "history_id": 10
}
```

### PUT /api/anime/watch-history/{history_id}/finish

结束观看会话。

```json
{
  "last_position_seconds": 800.0,
  "watched_seconds": 600.0,
  "completed": false
}
```

### GET /api/anime/watch-history

观看历史页面。

查询参数：

- `period`：`all`、`today`、`week`、`month`。
- `search`：标题搜索。
- `limit`：默认 100。

响应按 `started_at DESC` 排序。





## 前端页面

### A 首页

目标：像视频库而不是临时播放器。

主要区域：

- 顶部标题：Anime。
- 扫描按钮。
- 搜索框。
- 筛选：全部、未看、观看中、已看。
- 可选缺失文件筛选：默认隐藏缺失文件，可切换查看“缺失”。
- 评分筛选。
- 排序：最近观看、标题、进度、评分、时长、大小。
- 视频/文件夹混排列表。

视频行展示：

- 标题。
- 文件夹 tag。
- 时长。
- 分辨率和编码，例如 `1080p · h264/aac`。
- 进度百分比。
- 星级评分。
- 文件缺失状态：仅在缺失筛选或历史中展示，显示为“文件已不在原位置”。

空状态：

- 显示默认目录 `D:\will\[A]`。
- 显示扫描按钮。
- 如果目录不存在，提示用户创建目录或修改配置。

缺失文件 UX：

- 默认视频列表不显示缺失文件，避免干扰正常观看。
- 历史页面里如果某条记录的视频已缺失，仍显示历史记录，但播放按钮禁用。
- 缺失视频详情页应保留标题、进度、评分、历史，不直接删除。
- 后续可增加“从数据库移除该缺失记录”按钮，但第一版不做。

### 视频播放页

Hash 路由：

```text
#/anime/{id}
```

播放器要求：

- 默认原文件模式。
- 自定义控制条。
- 控制条按钮在同一层：播放/暂停、进度、时间、速度、画中画、下载/打开原文件流、全屏。
- 不依赖浏览器原生二级菜单。
- 显示当前播放模式：
  - 原文件：不转码、不降质。
  - 备用转码：重新编码，可能降质。
- 支持恢复上次进度。
- 接近结尾时标记完成，建议阈值为 `percent >= 0.95` 或剩余时间小于 60 秒。


### 历史观看页面

Hash 路由：

```text
#/anime/history
```

展示：

- 按时间倒序。
- 每条记录显示标题、观看时间、观看时长、最后位置、是否看完。
- 如果视频文件已缺失，记录仍显示，并标注“文件缺失”。
- 支持搜索。
- 支持按今天、本周、本月、全部筛选。
- 点击记录打开视频并恢复到该位置。

### 文件夹弹层

复用小说的 `FolderOverlay` 思路，但视频 item 更适合展示：

- 标题。
- 进度。
- 评分。
- 时长。

## 搜索

第一版后端 SQL LIKE 即可。

搜索范围：

- title。
- folder_tag。
- file_path 可选，不默认展示完整路径但可以参与搜索。

后续如果库很大，可增加 FTS5。

## 播放进度和历史策略

进度和历史是两个概念：

- `anime_progress`：每个视频只有一条当前进度。
- `anime_watch_history`：每次观看一条记录。

播放页行为：

1. 打开视频时读取 `anime_progress`。
2. 如果有进度且未完成，恢复到 `position_seconds`。
3. 第一次播放时创建 watch session。
4. `timeupdate` 防抖保存 progress。
5. pause/seeked/离开页面时保存 progress。
6. 离开播放页时 finish watch session。

观看时长计算：

- 前端可累计实际播放时间。
- 后端不要仅用 `ended_at - started_at`，因为用户可能暂停。
- 第一版由前端传 `watched_seconds`。

## 打包和 ffmpeg

安装包默认不包含 ffmpeg/ffprobe。

程序查找顺序：

1. 程序目录下的 `ffmpeg.exe` / `ffprobe.exe`。
2. 程序目录下的 `tools\ffmpeg\bin\ffmpeg.exe` / `tools\ffmpeg\bin\ffprobe.exe`。
3. 系统或用户 `PATH`。

UI 要显示检测状态：

- ffmpeg 已检测到 / 未检测到。
- ffprobe 已检测到 / 未检测到。

功能依赖：

- 原文件播放：不依赖 ffmpeg。
- 扫描 duration/codec/resolution：依赖 ffprobe；缺失时仍可索引文件，但 duration/codec/resolution 为空。
- 备用转码：依赖 ffmpeg。

## 错误处理

常见错误：

- 视频文件不存在：标记为缺失，保留评分、进度和历史。
- 原文件无法播放：提示尝试备用转码。
- ffmpeg 缺失：备用转码按钮禁用，并提示安装或加入 PATH。
- ffprobe 缺失：扫描可继续，但元信息不完整。
- Range 请求越界：返回 416 或按合法范围裁剪；实现需保持浏览器可用。

## 测试

后端测试：

- 扫描只读取 metadata，不读取完整文件。
- `size + mtime` 未变化时跳过 ffprobe。
- 扫描发现文件缺失时只标记 `missing`，不删除视频、进度和历史。
- 缺失文件重新出现时恢复为 `available`。
- Range 请求返回 206、Content-Range、Accept-Ranges。
- progress percent clamp。
- rating 校验。

前端单元测试：

- 时长格式化。
- 视频状态标签格式化。
- 搜索参数构造。

Playwright E2E：

- A 首页扫描后显示视频列表，API 用 route mock。
- 缺失视频默认不显示，切换缺失筛选后显示。
- 打开视频后恢复进度。
- 拖动进度后保存。
- 评分。
- 历史页面显示记录。
- 原文件/备用转码模式提示正确。

## 实施顺序

第一阶段：视频库骨架

1. 配置 `anime_dirs`，默认 `D:\will\[A]`。
2. 数据库迁移。
3. `/api/anime/videos`、`/api/anime/shelf`。
4. A 首页替换临时路径输入。

第二阶段：播放页

1. `#/anime/{id}`。
2. 原文件 Range 播放。
3. 进度恢复和保存。
4. 星级评分。
5. 自定义控制条。



第三阶段：历史

1. watch session API。
2. 历史页面。
3. 最近观看排序和筛选。

第四阶段：备用转码整理

1. HLS 缓存目录改为配置路径。
2. 转码状态和错误展示。
3. 清理过期 HLS 缓存。
4. 明确“备用转码可能降质”的 UI 状态。
