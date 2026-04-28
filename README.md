# TXT Reader

家庭内网使用的 Web TXT 小说阅读器。后端使用 Axum + Rust + SQLite，前端使用 Vue + Vite。

## 开发运行

复制配置文件并修改小说目录：

```powershell
Copy-Item config.example.toml config.toml
```

后端：

```powershell
cargo run
```

前端开发服务器：

```powershell
cd frontend
npm install
npm run dev
```

生产构建：

```powershell
cd frontend
npm install
npm run build
cd ..
cargo run
```

然后在手机或 iPad 上访问：

```text
http://电脑局域网IP:3000
```

扫描只会读取 `library_dirs` 中每个目录最外层的 `.txt` 文件，不递归子目录。
