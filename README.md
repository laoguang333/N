# TXT Reader

家庭内网使用的 Web TXT 小说阅读器。后端使用 Axum + Rust + SQLite，前端使用 Vue + Vite。

## 功能

- 扫描一个或多个本地书库目录中的 `.txt` 文件。
- 自动识别常见中文 TXT 编码并在浏览器中阅读。
- 保存阅读进度，刷新或重新打开后恢复到最近位置。
- 支持书架搜索、阅读状态筛选、评分筛选，以及最近阅读、标题、进度、评分排序。
- 每本书支持 1-5 星评分，点击当前评分星级可清除评分。
- 阅读页支持字号、行距、段距和纸色/夜间主题。

## 首次运行

复制配置文件：

```powershell
Copy-Item config.example.toml config.toml
```

编辑 `config.toml`，把 `library_dirs` 改成 TXT 小说所在目录。默认配置会创建 `novels` 目录和 `data/reader.sqlite` 数据库。

## 开发运行

推荐使用 Python 脚本同时启动后端和前端：

```powershell
python scripts/dev.py
```

脚本会在缺少 `frontend/node_modules` 时先执行 `npm ci`，然后启动：

- 后端：`cargo run`
- 前端开发服务器：`npm run dev`

也可以手动运行：

```powershell
cargo run
cd frontend
npm ci
npm run dev
```

## 常用命令

以下命令默认在项目根目录 `C:\Users\nillouise\Music\rust\N` 执行。

只构建前端静态文件：

```powershell
python scripts/codex.py build-frontend
```

安装或更新前端依赖：

```powershell
python scripts/codex.py install-frontend
```

只构建后端可执行文件：

```powershell
python scripts/codex.py build-backend
```

生产模式构建并启动后端，后端会直接托管 `frontend/dist`：

```powershell
python scripts/codex.py build-all
python scripts/codex.py start-backend
```

使用已编译的后端可执行文件启动：

```powershell
cargo build
.\target\debug\txt-reader.exe
```

开发模式同时启动后端和 Vite 前端：

```powershell
python scripts/codex.py dev
```

检查端口是否被占用：

```powershell
python scripts/codex.py port
```

运行完整检查：

```powershell
python scripts/codex.py check
```

`build-frontend` 在已有 `frontend/node_modules` 时不会重装依赖，只执行前端构建，避免 Windows 上依赖文件被占用时 `npm ci` 删除失败。需要主动更新依赖时再运行 `install-frontend`。

## 生产构建

```powershell
cd frontend
npm ci
npm run build
cd ..
cargo run
```

后端会在存在 `frontend/dist/index.html` 时直接托管前端静态文件。

## 局域网访问

默认监听地址是：

```text
0.0.0.0:234
```

在手机或 iPad 上访问：

```text
http://电脑局域网IP:234
```

如果无法访问，检查 Windows 防火墙是否允许当前 Rust 程序或 234 端口入站连接。`234` 不是常见 Web 服务端口；在 Windows 上普通用户通常可以监听，Linux/macOS 上低于 1024 的端口可能需要管理员权限或额外授权。

## 局域网 HTTPS

PWA 的 Service Worker 需要可信 HTTPS。固定设备内网使用时，可以用项目脚本生成一个本地 CA 和局域网服务证书：

```powershell
python scripts/codex.py setup-https
```

脚本会：

- 生成 `certs/local-ca.cer`、`certs/local-ca.pem`、`certs/server-cert.pem`、`certs/server-key.pem`。
- 把本地 CA 安装到当前 Windows 用户的受信任根证书。
- 自动把本机当前 IPv4 地址写入服务证书的 SAN。

然后在 `config.toml` 中启用：

```toml
tls_cert_path = "certs/server-cert.pem"
tls_key_path = "certs/server-key.pem"
```

重新启动后端后，用手机或 iPad 访问：

```text
https://电脑局域网IP:234
```

其他设备也需要信任同一个 CA。把 `certs/local-ca.cer` 或 `certs/local-ca.pem` 传到手机上安装：

- iOS / iPadOS：安装描述文件后，到“设置 -> 通用 -> 关于本机 -> 证书信任设置”中开启完全信任。
- Android：在系统安全设置中安装 CA 证书。不同浏览器对用户 CA 的支持略有差异，Chrome 通常可以使用系统已安装的用户 CA。

证书已经生成后，日常构建和启动不需要再运行这个命令。只有电脑的局域网 IP 变了，或证书过期时，才需要重新生成并重启后端。

## 手机或 iPad 全屏阅读

普通浏览器标签页不能被网页强制隐藏地址栏、前进后退栏或底部工具栏。项目已加入移动端 Web App/PWA 元信息；在 iPhone 或 iPad 上用 Safari 打开站点后，使用“分享”里的“添加到主屏幕”，之后从主屏幕图标启动，就会以独立窗口方式打开，阅读时不显示 Safari 的地址栏和底部导航栏。

Android 上也可以通过浏览器菜单里的“添加到主屏幕”或“安装应用”获得类似效果。局域网 HTTP 站点在不同浏览器上的安装能力不完全一致；iOS 的主屏幕方式通常最适合家庭内网阅读。

## 配置

```toml
listen = "0.0.0.0:234"
database_path = "data/reader.sqlite"
library_dirs = ["novels"]
scan_recursive = false
scan_on_startup = false
# cors_allowed_origins = ["http://127.0.0.1:5173"]
# tls_cert_path = "certs/server-cert.pem"
# tls_key_path = "certs/server-key.pem"
```

- `library_dirs`：书库目录列表。
- `scan_recursive`：默认 `false`，只扫描每个书库目录最外层 `.txt` 文件；设为 `true` 后递归扫描子目录。
- `scan_on_startup`：启动后是否自动扫描书库。
- `cors_allowed_origins`：默认未设置时允许任意来源，便于开发；需要收紧时配置允许的来源列表。
- `tls_cert_path` / `tls_key_path`：同时配置后，后端直接以 HTTPS 方式监听。

## 检查

运行完整检查：

```powershell
python scripts/check.py
```

脚本会执行 Rust 格式化、Clippy、Rust 测试、前端依赖安装、前端测试和前端构建。

## 数据与备份

阅读进度、评分和书籍索引保存在 `database_path` 指定的 SQLite 数据库中。备份时复制 `.sqlite` 文件即可；如果服务正在运行，也一并保留同目录下可能存在的 `-wal` 和 `-shm` 文件。

## 常见问题

- 书架为空：确认 TXT 文件放在 `library_dirs` 指定目录；默认非递归扫描，子目录文件需要开启 `scan_recursive`。
- 前端开发服务器无法请求 API：确认后端正在 234 端口运行，Vite 会把 `/api` 代理到 `http://127.0.0.1:234`。
- `cargo` 无法下载依赖：检查网络、代理和系统证书；依赖缓存完整后可再次运行 `python scripts/check.py`。
- 修改配置后无效：重启后端服务。

更多接口和结构说明见 [API 文档](docs/api.md) 与 [架构文档](docs/architecture.md)。
