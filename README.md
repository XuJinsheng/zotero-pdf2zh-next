# zotero-pdf2zh-next

一个面向 Zotero 7–10 的 PDF 翻译插件，配套一个本地 Python 服务来调用 `pdf2zh_next` 完成翻译。

项目维护重点是：少一点配置负担，稳定地在 Zotero 里提交任务、查看进度、导入结果。

当前源码版本：<!-- release-version --> `5.6.2`，发布状态见 [更新记录](CHANGELOG.md)。

## 目录

- [和原项目的区别](#和原项目的区别)
- [效果预览](#效果预览)
- [安装插件](#安装插件)
- [安装并启动本地服务](#安装并启动本地服务)
- [更新](#更新)
- [在 Zotero 里使用](#在-zotero-里使用)
- [作者与上游致谢](#作者与上游致谢)
- [License](#license)

## 和原项目的区别

本项目基于 `guaguastandup/zotero-pdf2zh` 演化而来，但现在按更轻量的方向维护：

- 只保留 Zotero 插件和本地 Python 服务两部分。
- 服务端支持通过 `uv tool` 从本分支源码安装，也可使用 Docker 部署。
- 支持任务面板、进度显示、取消、重试和结果导入状态。
- 支持同时输出中文 PDF 和双语 PDF。
- 偏好页整合插件版本、服务端版本、连接检查和常用翻译选项。
- 去掉旧 runner、旧 server 和历史遗留自动化路径，减少维护成本。

更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 效果预览

![任务进度页面](assets/任务进度.png)

## 安装插件

从 [GitHub Releases](https://github.com/XuJinsheng/zotero-pdf2zh-next/releases) 下载最新的 `zotero-pdf2zh-next.xpi`，然后：

1. 打开 Zotero。
2. 进入 `工具 -> 插件`。
3. 点击右上角齿轮图标。
4. 选择 `Install Add-on From File...`。
5. 选择下载的 `.xpi` 文件。
6. 重启 Zotero。

开发版 XPI 可在 [CI 工作流](https://github.com/XuJinsheng/zotero-pdf2zh-next/actions/workflows/ci.yml)运行详情页的 `Artifacts` 中下载，解压后安装 `.xpi` 文件。

## 安装并启动本地服务

安装当前开发分支的服务端（仅支持 Python 3.14，需要 Git 和 uv）：

```bash
uv tool install --python 3.14 "git+https://github.com/XuJinsheng/zotero-pdf2zh-next.git@main#subdirectory=server"
zotero-pdf2zh-next
```

Docker 预构建镜像发布在 [GHCR](https://github.com/XuJinsheng/zotero-pdf2zh-next/pkgs/container/zotero-pdf2zh-next)，目前支持 `linux/amd64`，提供版本 tag 和 `latest`。已有 Dockge/Compose 部署可替换镜像地址，保留原有端口与数据挂载；生产部署建议固定镜像 digest。

开发版镜像使用同一地址的 `main` 或 `sha-<完整提交 SHA>` 标签，由 CI 在 `main` 分支检查通过后发布。

也可以从源码构建并启动 Docker 服务：

```bash
docker compose up --build -d
```

如需在构建时使用自定义 Python 包索引或推送到自己的镜像仓库，可以通过环境变量覆盖默认值：

```bash
UV_INDEX_URL=https://your-pypi-proxy/index/ \
PDF2ZH_IMAGE=your-registry/zotero-pdf2zh-next:latest \
docker compose up --build -d
```

默认服务地址是：

```text
http://127.0.0.1:8890
```

## 更新

插件更新：

- 在 Zotero 的插件管理页面直接检查更新。
- 按 Zotero 提示完成更新并重启。

`uv tool` 服务端更新：

```bash
uv tool install --reinstall --python 3.14 "git+https://github.com/XuJinsheng/zotero-pdf2zh-next.git@main#subdirectory=server"
```

## 在 Zotero 里使用

1. 打开 Zotero 设置里的 `zotero-pdf2zh-next`。
2. 把“Python 服务器地址”设为本地服务地址，例如 `http://127.0.0.1:8890`。
3. 在“翻译服务配置”列表中新增配置，填写自定义服务名称、提供商类型、模型、密钥和接口地址。
4. 在上方“LLM 配置”中选择要使用的配置，下拉显示“自定义名称 / 模型”。同一提供商或模型可以保存多条不同名称的配置，无需激活或置顶。
5. 点击“检查连接与配置”，确认服务端连通及所选配置有效。可勾选真实 API 测试，发送一条短翻译请求。
6. 选择输出中文 PDF、双语 PDF，或两者同时输出。
7. 在条目或 PDF 附件上右键，选择 `zotero-pdf2zh-next: Translate PDF`。

任务提交后，可以在右键菜单里打开 `zotero-pdf2zh-next: Task Manager` 查看进度、取消任务、重试失败任务和导入结果。

配置名称必填且不可重复。第一条配置保存后自动选中，之后新增配置不会改变当前选择；删除当前配置后需要重新选择。未选择配置时仍可检查服务端连通性，但不能验证模型或提交翻译。

升级时自动为旧配置生成名称，并优先恢复原提供商下已激活的配置；没有激活项时使用该提供商下第一条配置，没有匹配项则提示重新选择。

### 运行参数

每条配置可分别设置最大 QPS、并发线程数、额外重试次数和重试间隔，留空继承全局默认。`并发线程数 = 0` 表示由引擎决定，`重试次数 = -1` 表示采用引擎原有策略，与留空继承全局不同。配置检查和新任务使用同一套有效参数。并发线程数控制单篇 PDF 的翻译工作线程，QPS 控制请求发送速率。

偏好设置的运行参数中可配置“片段请求额外重试次数”和“重试间隔（秒）”：

- 次数默认 `-1`，保留引擎原有策略；`0` 禁用请求重试；`1–100` 表示首次请求失败后的额外尝试次数。
- 自定义间隔为固定秒数，范围 `0–300`，默认 `2` 秒。
- 自定义策略目前支持底层使用 OpenAI Python SDK 的翻译引擎，覆盖超时、连接错误、HTTP 408/409/429 和 5xx。其他引擎应保留 `-1`；自定义设置会报错，不会静默忽略。
- 策略作用于片段翻译及术语提取，并关闭 SDK 内层重试，避免次数叠加。上游初始化连接探测仍使用原有策略；BabelDOC 段落回退可另行发起请求，因此这里不是整段或整篇的请求总上限。
- 设置随新提交任务保存；任务面板重试已有任务沿用其原参数。插件和服务端均需包含此功能，旧服务端不会应用这些字段。

### 翻译附件标题

开启“重命名翻译附件标题”后，可选择标题后缀：

| 选项                   | 使用的内容                           |
| ---------------------- | ------------------------------------ |
| 自定义服务名称（默认） | 配置中填写的名称                     |
| 提供商类型             | 提供商标识                           |
| 模型名称               | 实际模型标识；未填写时使用提供商标识 |

标题格式为 `短标题-后缀-mono/dual`，没有短标题时为 `后缀-mono/dual`。此设置仅修改 Zotero 附件标题，磁盘上的 PDF 文件名保持原有规则。关闭重命名时，附件标题使用结果文件名。

批量提交开始时固定配置和后缀选项；之后切换、编辑或删除配置不会改变该批任务的请求参数和标题后缀。缺少标题快照的历史或远程任务使用任务自身的提供商标识。

## 作者与上游致谢

当前分支由 [XuJinsheng](https://github.com/XuJinsheng) 维护，发布仓库为 [XuJinsheng/zotero-pdf2zh-next](https://github.com/XuJinsheng/zotero-pdf2zh-next)。

本项目基于 [NightWatcher314/zotero-pdf2zh-next](https://github.com/NightWatcher314/zotero-pdf2zh-next)，其前身为 [guaguastandup/zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh)。感谢原作者及贡献者。

翻译、PDF 处理和 OCR 核心来自 [PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next)、[BabelDOC](https://github.com/funstory-ai/BabelDOC) 和 [RapidOCR](https://github.com/RapidAI/RapidOCR)。内置快照版本、来源哈希和许可证见 [第三方声明](server/THIRD_PARTY_NOTICES.md)。引用这些上游项目时，请遵循各项目提供的引用信息。

## License

本项目延续上游许可，采用 `AGPL-3.0-or-later` 发布，见 [LICENSE](LICENSE)。
