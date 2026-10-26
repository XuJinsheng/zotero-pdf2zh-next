# 开发维护笔记

这份笔记记录当前维护 `zotero-pdf2zh-next` 时比较容易踩坑的地方。README 面向使用者，这里面向开发和发版。

## 项目边界

当前仓库只保留两个运行面：

- `plugin/`：Zotero 插件，负责偏好页、右键菜单、任务面板、提交 PDF、导入结果。
- `server/`：本地 Python 服务，负责接收插件请求、准备工作目录、调用 `pdf2zh_next`、管理结果文件。

不要轻易恢复旧 runner、旧 server 或额外自动化路径。这个 fork 的维护目标是少入口、少分发差异、少隐式状态。

## Python 和服务端

Python 依赖和运行统一用 `uv`：

```bash
uv run --directory server python -m unittest discover -s tests
uv run --directory server zotero-pdf2zh-next
```

服务端依赖按 `server/pyproject.toml` 解析，不提交 `server/uv.lock`。本地、Docker、CI 和发布流程使用同一依赖声明。

面向用户的服务端分发优先使用 `uv tool`，命令名和插件名保持一致：

```bash
uv tool install --python 3.13 "git+https://github.com/XuJinsheng/zotero-pdf2zh-next.git@v5.6.0#subdirectory=server"
zotero-pdf2zh-next
```

本分支服务端通过 Git 源码安装；现有 PyPI 包属于上游分发。当前本分支发布使用 `scripts/release.sh 5.6.0 --no-pypi --no-tap`。取得发布权限后，可通过统一发版脚本和 GitHub Trusted Publisher 发布，也可以由 direnv 注入 token；token 不写进仓库。

服务端入口在 `server/server.py`，真正把插件参数转换为 `pdf2zh_next` 参数的是 `server/pdf2zh_next_service.py`。

PyPI 包内置固定的 `pdf2zh-next`、BabelDOC 和 RapidOCR 核心快照，避免
PyPI 解析到未验证的新版本，也避免安装上游 Gradio/FastAPI 前端。来源、
版本、SHA 和许可证见 `server/THIRD_PARTY_NOTICES.md`。更新快照时运行：

```bash
uv run python scripts/vendor_pdf2zh_runtime.py
```

生成目录和许可证必须提交。生成后核对 `server/pyproject.toml`，再跑 wheel/sdist
检查和 fresh-wheel 安装 smoke；不能只改版本字符串。

新增翻译选项时，通常要同时检查这些位置：

- 插件偏好默认值：`plugin/addon/prefs.js`
- 插件偏好类型：`plugin/typings/prefs.d.ts`
- 请求类型与请求体：`plugin/src/modules/pdf2zhTypes.ts`、`plugin/src/modules/pdf2zhHelper.ts`
- 配置检查请求：`plugin/src/modules/preferenceScript.ts`
- 服务端请求解析：`server/server.py`
- `pdf2zh_next` settings 映射：`server/pdf2zh_next_service.py`
- README 或 changelog 是否需要用户可见说明

参数命名可以在插件侧保持用户语义，例如 `disableTermExtraction`；服务端再映射到上游语义，例如 `no_auto_extract_glossary`。这样 UI 和上游参数不会互相污染。

## Zotero 大版本兼容

- 兼容上限位于 `plugin/addon/manifest.json`，不能仅凭构建通过就放宽；先对照官方开发迁移说明，再用独立 profile/dataDir 启动目标 Zotero 验证。
- 2026-09-11 在 Zotero 10.0.2（Firefox 140）验证 v5.3.1 的加载、菜单、设置、任务窗口和 LLM 编辑器。旧 toolkit 有 `ChromeUtils.import()` 弃用警告，未阻断上述功能；没有据此升级依赖。原始 GitHub v5.3.1 XPI 另在全新 profile 验证：开始时 `appDisabled=true`；通过 `AddonManager.UPDATE_WHEN_USER_REQUESTED` 从已发布 URL 获得兼容更新后，`isActive=true`、`appDisabled=false`，上述窗口检查再次通过。真实 LLM 翻译尚未纳入本次验证。
- 若只改变兼容范围，可按 [Zotero 官方说明](https://www.zotero.org/support/dev/zotero_10_for_developers#updating_plugin_compatibility) 更新固定 `release/update.json` 中现有版本的 `applications.zotero.strict_max_version`，保留 `version`、`update_link` 和原 XPI；`update_hash` 必须校验为远端 XPI 的实际哈希，不能直接使用重新构建的包的哈希。先备份该更新元数据，发布后下载回读，并同步源码上限。无需为纯兼容更新重发 Python/Homebrew。

## Zotero 插件偏好页

偏好页是 `plugin/addon/content/preferences.xhtml`，行为在 `plugin/src/modules/preferenceScript.ts`。

维护经验：

- 先保留 Zotero/XUL 能稳定工作的控件，不要为了视觉效果引入新的前端框架。
- 偏好页可能被多次加载，动态插入选项前要清理旧内容。例如语言下拉初始化前要 `replaceChildren()`，否则会重复堆叠。
- Zotero 的 XHTML 会被 Prettier 用比较奇怪的方式格式化，尤其是内联 CSS。优先保证构建和 lint 通过，不要在这个文件里追求普通网页项目的格式体验。
- 偏好页状态可以从 `plugin/package.json` 读取插件版本；服务端版本来自 `/health`。
- 连接检查按钮要防重复点击。连接失败时同步更新页面状态；服务端已连通但尚未选择配置时，保留连通状态并提示选择配置。

### LLM 配置与本地化

- `llmApiManager.ts` 负责配置存储、旧数据迁移和按 `selectedLLMApiKey` 读取当前配置，是配置数据的唯一来源。`service` 字段继续表示提供商类型，与服务端协议兼容；`name` 是用户自定义名称。
- 偏好页只保留表格行索引缓存，不再维护第二份配置 Map。配置增删改后保存偏好，并刷新行索引和主选项下拉；表格行选择与当前翻译配置选择相互独立。
- `llmSelectionMigrated` 只用于首次恢复原提供商下的激活项。迁移后不再读取激活状态，不能因为当前选择为空而重复迁移，否则删除配置后可能意外切换到另一条。
- 批量提交固定配置和标题后缀快照；任务刷新时保留本地标题快照。结果导入只依赖任务的提供商和标题快照，不应重新读取当前 LLM 配置。插件当前仅在内存中维护本地任务关联，缺少快照时回退到任务提供商。
- LLM 编辑器、表格和动态提示使用 `addon.ftl`，偏好页静态标签使用 `preferences.ftl`。编辑器通过窗口参数接收现有 `getString`，不另建语言选择逻辑；新增文案要同时补齐中英文资源。
- LLM 配置行独占整行，语言选项在下一行。混用 HTML 与 XUL 时，需对配置标签和下拉框明确指定网格位置，避免 Zotero 原生样式导致右侧偏移。

## 任务与文件

服务端会为每个任务创建独立 workspace，位置在 `server/translates/<task-id>/`。任务记录由 `server/task_manager.py` 管理。

维护任务逻辑时要注意：

- 重试任务需要清理旧输出，但不能删输入 PDF。
- 删除任务时要避免删除正在运行的 workspace。
- 任务持久化只恢复 completed/failed 这类稳定状态，running/queued 不能盲目恢复。
- 多输出模式下，结果文件必须按 `mono`、`dual` 区分，否则插件导入时会混乱。

## 测试与验证

常规验证：

```bash
pnpm --dir plugin install --frozen-lockfile
pnpm --dir plugin lint:check
pnpm --dir plugin test
pnpm --dir plugin build
uv run --directory server python -m unittest discover -s tests
git diff --check
```

只改插件脚本时，可以额外跑：

```bash
pnpm --dir plugin exec eslint src/modules/preferenceScript.ts
```

只改服务端请求解析或 `pdf2zh_next` 参数映射时，优先补小范围 unittest。不要为了验证翻译流程去依赖真实 LLM 调用；真实调用慢、贵、也不稳定。

## 持续集成（CI）

[CI 工作流](../.github/workflows/ci.yml) 在推送 `main`、向 `main` 提交或更新 PR 时运行，也支持手动触发。插件 lint、构建与服务端测试、打包校验通过后，执行 Docker 构建。

插件构建产物可在 `Artifacts` 中下载，保留 30 天。仅 `main` 分支发布开发镜像（`main`、`sha-<完整提交 SHA>`）；其他分支和 PR 只验证构建。正式版标签和 `latest` 由发布流程维护。

### 依赖维护（2026-10-26）

- pnpm `12.15.0`、Node 24；CI 和发布脚本统一读取 `packageManager`。
- Zotero 的 EPUB/PDF 类型包作为直接开发依赖固定提交；定向移除重复 Git 子依赖，保留 pnpm 默认安全检查和发布冷却期。仅允许 SWC、esbuild 安装脚本。配置见 `plugin/pnpm-workspace.yaml`。
- toolkit 6 删除菜单接口，改用 `UITool.createElement`；TypeScript 保持 6.0，因 [typescript-eslint 要求 `<6.1`](https://typescript-eslint.io/users/dependency-versions/)。
- 清理无用直接依赖，补齐 `azure-core`、`regex`，提升服务端最低依赖版本。PyMuPDF 升至 2.0，附带 Layout/4LLM，安装体积增加。
- Azure SDK 保持 `<2`：[2.0 改用新版 HTTP 协议](https://github.com/Azure/azure-sdk-for-python/blob/main/sdk/translation/azure-ai-translation-text/CHANGELOG.md)，现有中国区 v3 端点尚未验证新版协议。内置运行时快照及 Python 3.12/3.13 范围保持不变。

## 发布与 changelog

开发期间在 `CHANGELOG.md` 标记“未发布”，发版前填写实际发布日期。发布脚本会检查是否存在对应版本章节：

```markdown
## v5.2.3 - YYYY-MM-DD

- ...
```

然后运行：

```bash
scripts/release.sh 5.6.0 --no-pypi --no-tap
```

按上述命令发布本分支时，脚本会做这些事：

- 同步 `plugin/package.json`、`server/pyproject.toml`、`server/server.py` 和 README 版本。
- 跑服务端与插件测试、插件构建。
- 构建服务端 Python wheel/sdist，确保 PyPI 包可发布。
- 创建主仓库 release commit 并推送。
- 用 `CHANGELOG.md` 对应章节生成 GitHub Release notes。
- 上传 Zotero `.xpi`，发布 Docker 镜像；跳过 PyPI 和 Homebrew。
- 等待所有启用渠道完成；任一失败时返回失败，不改自动更新清单。
- 全部启用渠道成功后，最后更新固定 `release/update.json`。

`plugin/pnpm-lock.yaml` 必须提交。CI 和发版都使用 `--frozen-lockfile`，依赖变化后要同步更新 lockfile。

`.github/workflows/publish-pypi.yml` 只接受手动指定的现有 tag，并从该 tag 构建。`scripts/release.sh` 在没有 `UV_PUBLISH_TOKEN` 时负责创建/校验 tag、触发该 workflow、等待 PyPI 可查询；不要直接从 `main` 构建旧版本。

本分支维护者为 `XuJinsheng`，发布目标为 `XuJinsheng/zotero-pdf2zh-next`。PyPI 包名属于上游既有分发；取得该包发布权限后，才可配置 owner `XuJinsheng`、repository `zotero-pdf2zh-next`、workflow `publish-pypi.yml`、environment `pypi` 的 Trusted Publisher。未配置时使用 `--no-pypi`，不能将上游已存在的同号版本视为本分支发布成功。GitHub `pypi` environment 不保存 token；`id-token: write` 只授予发布 job。

同一次 release commit 的 GitHub Release 或 PyPI 其中一端已存在时，脚本会校验 tag/commit 和 PyPI wheel/sdist 后补齐缺失步骤。旧版本 backfill 必须从对应 tag 构建，不能从已前进的 `main` 直接重发。不要恢复单独的 tag 发布 workflow；`scripts/release.sh` 是唯一发版入口。

脚本默认启用 XPI、PyPI、Docker 和 Homebrew；本分支须显式传入 `--no-pypi --no-tap`，取得对应渠道权限后再启用。

本分支不默认使用上游 Homebrew tap；发布时传入自己维护的 `--tap-path`，未建立 tap 时使用 `--no-tap`。历史验收记录中的 NightWatcher314 链接保留为上游记录。

Homebrew formula 必须继续 pin `python@3.13`。目前 `pdf2zh_next -> pydantic-core` 依赖链在 Python 3.14 上不应被假定可用。

发布脚本的 Docker 与 Homebrew 任务独立运行、统一等待并汇总失败。某渠道失败后，已完成渠道的版本资产保留，自动更新清单保持原版本；修复失败渠道后可从同一发布提交重新执行同版本发布。显式 `--no-docker` / `--no-tap` 排除的渠道不参与完成门槛。脚本内部并行不代表允许多个版本同时覆盖稳定更新清单，应保持单个发布操作。

离线编排测试：`uv run --no-project python -m unittest discover -s scripts/tests -v`。测试替代外部发布命令，验证并行启动、单/双渠道失败、等待完成、清单后置及跳过渠道；不会推送或上传任何产物。CI 同时运行这些测试。Homebrew 发布门槛按当前 PR head SHA 定位并等待整个 `tests.yml` run，再核对 PR checks，避免动态矩阵任务尚未登记时提前放行。

### Docker 镜像 CI

`.github/workflows/publish-docker.yml` 由 `scripts/release.sh` 在 GitHub Release 创建后触发并等待；也支持手动补发已有稳定版 tag。`--no-docker` 跳过镜像发布，`--no-push` / `--no-release` 同时跳过；预发布版本需使用 `--no-docker`。不会自动更新 NAS stack。

当前分支镜像仓库为 `ghcr.io/xujinsheng/zotero-pdf2zh-next`，通过仓库变量 `DOCKER_IMAGE` 配置；认证使用内置 `GITHUB_TOKEN`，不保存额外 registry secret。

2026-09-11 首次发布验收：[CI #34587406079](https://github.com/NightWatcher314/zotero-pdf2zh-next/actions/runs/34587406079) 成功；v5.3.1 的 OCR 初始化、运行版本和 HTTP 健康检查通过。包为 Public，匿名读取 manifest/config 成功；`5.3.1` 与 `latest` 均指向 `sha256:19e73ca31b631d1552f6719e281838934ab48d836a1cc1d8d0f69ea4c1b0ec07`（`linux/amd64`），源码 revision 为 `8beaab118cc90eca67e17f30ca3c795f7986552c`。此次仅发布镜像，未更新 NAS 的 Dockge stack。

仓库 Actions 配置：

- Variable `DOCKER_IMAGE`：完整且小写的镜像仓库路径，不含 tag。例如 `ghcr.io/xujinsheng/zotero-pdf2zh-next` 或 `docker.io/<username>/zotero-pdf2zh-next`；Harbor 使用实际 registry/项目路径。
- GHCR 使用内置 `GITHUB_TOKEN` 和 `packages: write`，无需另交凭据。首次发布后核验包可见性；面向匿名用户分发时设为 public。
- Docker Hub / Harbor 使用 Secrets `DOCKER_USERNAME` 和 `DOCKER_TOKEN`。Docker Hub 用有 push 权限的访问令牌，Harbor 用限定项目的 robot；不要使用账号密码或 OIDC 个人 secret，不要把令牌写进仓库或聊天。

CI 从指定 tag 构建 `linux/amd64` 镜像，先核对插件、服务端和 tag 版本，再运行已有 `check_installed_runtime.py`（含 OCR 初始化）及 HTTP `/health` 检查。通过后推送版本 tag；只有目标版本仍为 GitHub 最新稳定 Release 时才更新 `latest`，补发旧版不会覆盖它。发布摘要给出可供 Dockge 固定部署的 digest。

手动补发：

```bash
gh workflow run publish-docker.yml --repo XuJinsheng/zotero-pdf2zh-next --ref main -f tag=v5.6.0
```

### 上游 Homebrew bottle 发布与瘦身记录

Formula 的源码回退路径必须忽略用户或 Host 的 uv/pip 镜像配置，并显式使用公共 PyPI。否则 bottle 覆盖范围之外的机器仍可能被锁到私有镜像。

可以从 bottle 中删除依赖包里目录名恰好为 `test` 或 `tests` 的测试数据、Ruff 可执行文件，以及 `cv2/data`、`skimage/data` 示例数据。不要删除名为 `testing` 的目录：SciPy 导入会经过 `numpy.testing`，误删会让运行时 smoke 失败。裁剪后至少验证：

- `pdf2zh_next`、BabelDOC、RapidOCR、OpenCV、scikit-image 和 SciPy 可导入。
- RapidOCR 能完成模型加载 smoke。
- Formula test 确认被裁剪路径不存在。

`v5.3.0` 的等价 locked build 从 692180 KiB 降到 574520 KiB，减少约 114.9 MiB。不要把这个未压缩对比直接和 bottle 下载体积或 `brew` 的安装摘要混用。

CI job 成功不等于该平台一定生成了 bottle。例如 Intel macOS runner 可能因为某个依赖没有 bottle 而正常跳过构建。发布完成需要同时确认：

- workflow artifacts 确实包含目标平台的 `*.bottle.*`。
- tap `main` 的 Formula `bottle do` 已写入对应平台 SHA。
- GitHub bottle release 已有对应资产；本机验证时 `brew info --json=v2` 显示 `poured_from_bottle: true`。

v5.4.0 发布覆盖 Apple Silicon Tahoe 和 Linux x86_64。Sonoma 因依赖缺少 bottle，被 test-bot 跳过；Sonoma 与 Intel macOS 回退到源码构建。

## README 的边界

README 保持给使用者看的内容：

- 这个项目做什么。
- 和原项目有什么区别。
- 怎么安装插件。
- 怎么启动或更新服务端。
- 在 Zotero 里怎么用。

服务接口、请求体、内部任务结构、发布脚本细节都放到 `docs/` 或源码附近，不放 README。

## 上游 v5.4.0 发布验收（2026-09-19）

- 源码与 tag：`878ab2c116297aaa3512793b1b67acacd689aa9d`；[Release](https://github.com/NightWatcher314/zotero-pdf2zh-next/releases/tag/v5.4.0) 已发布 XPI，固定更新清单版本及 SHA-512 与产物一致。
- 本次加入请求重试及每 API 配置的运行参数覆盖。默认继承保持兼容；初始化连接探测与 BabelDOC 段落回退仍有独立请求行为。
- 验证：服务端 50 项测试、插件 2 项配置测试、完整 lint/typecheck/build、独立 wheel 安装及运行检查通过。配置编辑器在浏览器中验证回填、保存、零值与非法值处理；未在真实 Zotero 中验收。
- [PyPI CI](https://github.com/NightWatcher314/zotero-pdf2zh-next/actions/runs/35418145867) 与 [Docker CI](https://github.com/NightWatcher314/zotero-pdf2zh-next/actions/runs/35418207467) 成功。PyPI wheel/sdist 已可查询；GHCR `5.4.0` / `latest` 匿名读取均为 `sha256:27f855e8bab931d29cb4e9af0388440f0ef121d3261cd986f30331f2693965ab`。
- Homebrew [PR #13](https://github.com/NightWatcher314/homebrew-formula/pull/13) 经测试及 [bottle 发布](https://github.com/NightWatcher314/homebrew-formula/actions/runs/35418704660) 完成，tap 主分支已更新，Tahoe ARM 与 Linux x86_64 资产存在。
- 发布从最新远端 main 的隔离副本完成，原工作目录的既有未提交改动保留。此次未升级 NAS 或其他 Host 的运行服务。
