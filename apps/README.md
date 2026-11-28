# 本地资料库：安装、配置和运行

管理服务、Vue 管理界面、只读观看端和 Python 进程桥统一在此 workspace；下载核心仍在仓库根目录。

## 首次安装（macOS / Linux）

准备 Python 3.10+、Node.js 24.12+ 和 Bun 1.4.2。Python 负责下载与建库，Node 运行服务，Bun 安装并构建前端。

```sh
git clone https://github.com/oft/douyin-downloader.git
cd douyin-downloader
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[browser]"
.venv/bin/python -m playwright install chromium
.venv/bin/python apps/admin/scripts/setup-library.py --init
# 按需编辑根目录 config.yml，再执行下面的检查；不会触发下载。
.venv/bin/python apps/admin/scripts/setup-library.py
cd apps
bun install --frozen-lockfile
bun run build
bun run --filter @zqdouyin/admin start
```

打开 [管理页](http://127.0.0.1:3001)。新库为零作品；在链接管理中添加自己的作者链接，通过侧栏打开抖音完成登录并保存登录信息，然后在更新页手动启动下载。示例配置不包含作者链接或 Cookie；仅浏览已有库时无需登录。封面默认不下载，需要列表缩略图时在 `config.yml` 中设置 `cover: true`，可同时设置 `json: true` 保存作品元数据。

另开终端，在仓库的 `apps/` 目录运行：

```sh
bun run --filter @zqdouyin/viewer start
```

打开 [观看页](http://127.0.0.1:3002)。管理服务默认仅监听本机；观看服务默认监听局域网地址，并且只转发读取请求。远程访问需要自行配置可信来源和反向代理，不依赖作者的域名或自启动服务。

## Windows（PowerShell）

```powershell
git clone https://github.com/oft/douyin-downloader.git
cd douyin-downloader
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[browser]"
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe apps/admin/scripts/setup-library.py --init
cd apps
bun install --frozen-lockfile
bun run build
bun run --filter @zqdouyin/admin start
```

## 配置和数据边界

初始化只复制缺少的 `config.yml`、创建媒体目录和新的空数据库；已有配置和作品记录不覆盖、不迁移。再次运行不带 `--init` 的命令只检查路径、数据库必要字段和 SQLite 完整性，不创建缺失库。检查通过不代表所有媒体文件都存在。缺少 Python 包会提示安装；缺少 Node/Bun 时先安装对应工具，缺少浏览器时下载任务会在开始前提示。

```yaml
path: ./Downloaded
database: true
database_path: ./data/dy_downloader.db
```

这两个相对路径都相对于配置文件目录解析。`CONFIG_PATH` 可指定配置文件；`DOWNLOAD_ROOT`、`DATABASE_PATH` 可分别覆盖媒体目录和数据库，环境变量中的相对路径相对于启动目录。`PYTHON_EXECUTABLE` 可覆盖解释器，默认优先选择仓库 `.venv`。端口分别默认 3001、3002，可用 `PORT` 覆盖；观看端通过 `LIBRARY_URL` 指向管理端。

每个资料库应有独立的数据库和媒体目录。复核记录默认在 `<数据库>.reviews.json`，导入/分享登记库在 `<数据库>.library.sqlite`，任务状态和导入断点在数据库目录下。因此**不同库也应使用不同数据库目录**。迁移前保存整个数据库目录，以及对应媒体；不要只拷贝一个 `.db` 文件。运行中的 SQLite 还可能有 WAL，复制备份前应停止所有写入任务并退出服务，或使用 SQLite 在线备份。

旧版管理端的 `apps/admin/data/catalog-reviews.json` 不自动归入新库。需要恢复旧库复核时，停止服务并把它复制到旧库的 `<数据库>.reviews.json`，或用 `CATALOG_REVIEW_FILE` 明确指定；不要将旧复核文件用于新库。

Cookie、配置、数据库、日志、临时文件、媒体和本机自启动 plist 不进入 Git。仓库中的部署脚本是可选的个人 homelab 集成，普通 clone 无需运行。

## 切换磁盘与配置页

当前路径在服务启动时读取，**修改后须重启管理端**。链接列表可以在页面保存，下次更新时读取；媒体目录和数据库不能只改一个就宣称迁移完成。外置盘断开时不要在原卷路径下创建一个同名空目录，也不要自动切到内置盘继续使用原下载记录。

- **临时使用内置盘**：新建媒体目录，配置独立数据库，例如 `path: ./Downloaded`、`database_path: ./data/internal/dy_downloader.db`，执行 `--init`，重启管理端。原库和媒体保持原样，新的下载记录只写新库。
- **打开另一个已有库**：停止更新、导入、分享、扫描和链接检测，检查目标库与媒体的对应关系，成对修改路径，运行检查，再重启。首版不自动合并两个库。
- **迁移同一个库**：停止全部写入并备份，完整复制数据库目录和媒体，校验后再改路径。相对媒体路径可继续使用；旧绝对路径需单独检查和转换，不能简单指向另一个根目录。数据库显示“已下载”不代表新位置真的存在文件。

配置页可实现，建议第一阶段采用“保存并重启”，不做仅改两个全局变量的热切换。实施前需要补充库身份登记（随机 libraryId 同时存数据库和媒体根标记），校验目标身份和路径、预览迁移/新库/已有库三种操作并保留原库。已有库无标记时需显式登记，不能猜测归属；移动同一库保留 ID，新建库生成新 ID。拷贝后两个库若独立发展，要显式分叉新 ID。

完整热切换还需在服务器侧检查所有任务和媒体响应、锁定写入口，关闭旧数据库 worker，切换更新器/分享器/导入器/诊断状态，清空媒体映射、复核、扫描结果与前端勾选，再刷新页面；预检失败维持原配置。浏览器旧请求需要携带库版本并被服务端拒绝，避免旧页面删除新库中同 ID 的作品。现有接口没有完整的库版本隔离，因此本轮只提供安全初始化与切库流程，配置页尚未实现。

## 开发与验证

```sh
# 仓库根目录；可选 server extra 用于 Python 服务测试。
.venv/bin/python -m pip install -e ".[dev,browser,server]"
.venv/bin/python -m pytest tests/
cd apps
bun run check
bun run test
bun run build
```

开发前端另开终端，在 `apps/` 执行 `bun run --filter @zqdouyin/admin-web dev`，访问 Vite 输出的 5173 地址；管理端仍需运行在 3001。构建后刷新管理页面即可加载新版本。

[管理功能与接口](admin/README.md) · [只读观看端](viewer/README.md)
