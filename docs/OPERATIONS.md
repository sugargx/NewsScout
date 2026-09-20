# 运行与发布手册

适用环境：当前 Windows 本地运行方式；维护日期：2026-09-20。除明确说明外，命令从 ScoutNews 项目根目录执行。本文是操作说明，补充文档本身不启动服务、不改设置、不恢复数据库。

## 1. 先分清运行环境

| 环境 | Web / 入口 | API | Gateway | PostgreSQL |
| --- | --- | --- | --- | --- |
| 日常个人版 | 5173，Vite 开发服务 | 8080 | 8787 | 55433，`scoutnews` |
| 公开试读 | 5190，独立生产页面与只读网关 | 读取现有 8080 | 不直接访问 | 不直接访问 |
| 隔离真实 E2E | 15173 | 18080 | 18787 | 55432，每次新建 `scoutnews_e2e_<UUID>` |
| 页面替身验证 | 15173，Vite preview | 请求在浏览器内拦截 | 不需要 | 不需要 |
| 人工评审候选网关 | 示例 15190 | 只读访问现有 8080 | 不直接访问 | 不直接访问 |
| 手动 Docker 数据库 | 另行启动 Web/API | 另行配置 | 另行配置 | Compose 默认映射 5432 |

端口均以 loopback 为边界。**只允许专用 Dev Tunnel 转发 5190**；不要公开 5173、8080、8787、5432、55433 或隔离测试端口。只读网关不是全套后台的反向代理。

## 2. 首次启动与日常停止

需要 Node.js 22+、Rust stable、MSVC C++ Build Tools/Windows SDK，以及项目依赖。新 checkout 尚未安装依赖时运行 `npm.cmd ci`；启动器不会替你安装 npm 包。

系统 Node 不可用时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap-node.ps1
. .\scripts\runtime-common.ps1
Initialize-ScoutNewsNode
```

`Initialize-ScoutNewsNode` 优先使用项目专用运行时，并验证 Node 主版本。每个新终端需单独设置环境，不能假设上一个终端的 PATH 已继承。

```powershell
# 首次缺少项目 PostgreSQL 二进制时，显式允许下载
npm.cmd start -- -BootstrapPostgres
```

已有 PostgreSQL 运行时时使用 `npm.cmd start`。保持启动器终端运行，成功后访问 `http://127.0.0.1:5173`。阅读现有 Feed 不要求 OAuth；连接 Copilot 和启用自动摘要可能消费已授权账号的用量。

在另一个终端停止：

```powershell
npm.cmd stop
```

`-Demo` 使用明确标识的易失样本，不用于验收真实采集或跨重启保存。`-SkipBuild` 只跳过构建：API/Gateway 仍需已有构建，Web 仍是开发服务器；它不是公开发布命令。

运行记录与日志：

| 路径 | 用途 |
| --- | --- |
| `tmp\local-runtime.json` | 当前个人运行会话与进程身份 |
| `tmp\local-runs\<session-id>` | 个人运行日志 |
| `tmp\postgres-local\data` | 日常持久数据库，不因正常停止而删除 |
| `tmp\public-reader-runtime.json` | 当前公开运行会话、隧道 ID、实际 PublicUrl |
| `tmp\public-reader-runs\<session-id>` | 公开日志、停止请求及不可变 `site` |

`tmp` 被版本控制忽略，不等于可以删除。不要为了“清缓存”删除 `tmp` 根目录或数据库目录。运行记录缺失时，先判断是否有当前注册的启动会话，不用昨天的进程 ID 杀进程或宣称仍在线。

## 3. 手动运行与配置优先级

只有需要独立调试服务时才采用手动方式，不与一键启动的同端口实例并行。

1. 从 `.env.example` 建立本机 `.env`，配置实际数据库连接；OAuth 参数仅在主动采用该替代通道时填写。
2. 为 API 和 Gateway 配置**同一个**随机 `COPILOT_GATEWAY_SHARED_SECRET`。手动启动必须明确提供，不在多个终端各生成不同的值，也不把真实值写入文档。
3. 如使用项目 Compose：`docker compose -f .\infra\compose.yaml up -d`。其数据库端口是 5432，不是日常启动器的 55433。
4. 每个服务终端从项目根目录执行下面的共同准备，再执行该服务命令。

```powershell
. .\scripts\runtime-common.ps1
Import-ScoutNewsEnvironment
Initialize-ScoutNewsNode
if ([string]::IsNullOrWhiteSpace($env:COPILOT_GATEWAY_SHARED_SECRET)) {
    throw '请先为手动运行配置一致的内部密钥。'
}
```

| 服务终端 | 命令 |
| --- | --- |
| Rust API | `.\scripts\rust.ps1 -CargoArgs @('run')` |
| Copilot Gateway | `npm.cmd run dev:gateway` |
| Web | `npm.cmd run dev:web` |

进程环境优先于 `.env`；一键启动器另外固定本轮的 loopback 端口、日常数据库 URL 和浏览器助手路径。摘要模型/额度及阅读日程保存在 `app_settings`，不是每次启动都从环境变量重置。新库额度默认 20，允许配置 1–5000；已有试用库的 5000 是已保存选择。

手动启用原始博客浏览器补全时，还需要 `SCOUTNEWS_BROWSER_NODE`、`SCOUTNEWS_BROWSER_CAPTURE_SCRIPT` 的绝对路径，以及明确的 `SCOUTNEWS_BROWSER_ARTICLE_HOSTS`。一键启动器会提供路径并默认仅允许 OpenAI 指定主机；空主机名单关闭该路径。不要为了某站失败扩大成无约束浏览器读取。

## 4. 公开试读的启动

先保证个人 API 可读，再安装、登录并按本机 `devtunnel --help` 准备专用隧道。以下 `$tunnelId` 的示例值必须替换为实际创建结果：

```powershell
devtunnel create --allow-anonymous
$tunnelId = 'replace-with-the-created-id.region'
devtunnel port create $tunnelId -p 5190 --protocol http
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-public-reader.ps1 -TunnelId $tunnelId
```

启动器要求完整的 `name.region` ID，并检查隧道恰好只有 5190 一个端口。它构建 Web，将 `apps\web\dist` 复制到本轮 `site`，启动只读网关与 tunnel host，输出实际 HTTPS 地址。

公开启动器必须持续运行；关闭电脑或相关服务后，固定地址不保证可访问。当前没有自动长期云托管、开机常驻或零停机发布的承诺。正常停止只使用：

```powershell
.\scripts\stop-public-reader.ps1
```

停止公开版不会停止个人版或删除隧道配置；停止个人版则会使公开内容读取失败。首次浏览器访问可能需要通过 Dev Tunnel 提醒页；自动化采集脚本会设置 `X-Tunnel-Skip-AntiPhishing-Page: 1`，该头不是账号授权机制。

## 5. 修改后的候选评审与发布

**改源码、更新 localhost 或重新构建 dist 都不等于公开版已发布。** 公共入口使用独立副本，只有启动新的公开会话才会切换。

### 构建与候选

先保留正在运行的公开版，在当前构建成功后评审：

```powershell
. .\scripts\runtime-common.ps1
Initialize-ScoutNewsNode
npm.cmd run build --workspace '@scoutnews/web'
if ($LASTEXITCODE -ne 0) { throw '前端构建失败，不替换公开版本。' }
```

仅前端变更不需要重建或重启个人 Rust API。`npm run build` 构建 Web/Gateway，不单独构建 Rust；完整本地启动器会调用 `rust.ps1`。

访客兴趣不属于纯样式更新：API 必须包含 `0024_visitor_interest_profiles.sql` 和请求内画像处理，再切换 Web/公开网关。新网关遇到忽略兴趣的旧 API 会明确失败，不降级成站主推荐。先通过隔离启动器验证候选 API 和受控备份，不把候选实验直接连到 55433；实际升级后再创建新的公开会话。

只有后端读取规则变化、Web 构建字节与已有公开副本一致且网关协议兼容时，可以复用现有不可变 `site`，不必为了 API 更新重新发布相同前端。例如组件分组 `v2` 由 API 生成标题与成员，前端继续使用已有分组组件。此时仍须用候选 EXE 和隔离备份演练，再通过现有生命周期切换个人 API，并从真实 HTTPS 读取具体的新分组结果；旧 JS 哈希或 `/health` 成功都不能单独证明后端已更新。

需要实际材料评审时，在**专用候选终端**启动命名副本，避免构建期间资源消失：

```powershell
. .\scripts\runtime-common.ps1
Initialize-ScoutNewsNode
Assert-ScoutNewsPortsFree @(15190)
$candidate = Join-Path (Get-Location).Path ('tmp\ui-candidates\' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $candidate | Out-Null
$site = Join-Path $candidate 'site'
Copy-Item -LiteralPath .\apps\web\dist -Destination $site -Recurse
$env:SCOUTNEWS_PUBLIC_PORT = '15190'
$env:SCOUTNEWS_PUBLIC_API_ORIGIN = 'http://127.0.0.1:8080'
$env:SCOUTNEWS_PUBLIC_DIST = $site
node .\services\public-reader\server.cjs
```

在另一个终端读取 `/health` 确认 `readOnly=true`，然后按 [UI 评审流程](UI-DESIGN.md) 采集并审阅。候选网关不连接 Dev Tunnel。改完再次构建后，停止旧候选并用新副本启动，不能让旧 HTML 引用已删除的新旧混合资源。

### 切换同一公开地址

完成当前范围的测试和独立评审后，确保 dist 仍是评审过的构建。读取新鲜运行记录，再用相同 TunnelId 重启；下面命令会在新启动器中持续运行：

```powershell
$ErrorActionPreference = 'Stop'
$runtime = Get-Content -LiteralPath .\tmp\public-reader-runtime.json -Raw | ConvertFrom-Json
$tunnelId = $runtime.TunnelId
.\scripts\stop-public-reader.ps1
.\scripts\start-public-reader.ps1 -TunnelId $tunnelId -SkipBuild
```

没有当前运行记录时，不能复制旧 PID 或推断已停止的实例；首次/重新启动需使用已确认的专用 TunnelId。`stop-public-reader.ps1` 会验证会话、可执行文件和进程启动时间；不要绕过脚本按 `node`、`pwsh` 或浏览器名称批量终止进程。

### 发布后的另一个终端

```powershell
$ErrorActionPreference = 'Stop'
. .\scripts\runtime-common.ps1
$runtime = Get-Content -LiteralPath .\tmp\public-reader-runtime.json -Raw | ConvertFrom-Json
if (-not $runtime.PublicUrl -or -not (Test-ScoutNewsProcessIdentity $runtime.Supervisor)) {
    throw '公开启动器尚未注册一个有效的运行会话。'
}
foreach ($process in $runtime.Processes) {
    if (-not (Test-ScoutNewsProcessIdentity $process)) { throw '公开子进程身份不匹配。' }
}
$headers = @{ 'X-Tunnel-Skip-AntiPhishing-Page' = '1' }
$health = Invoke-RestMethod ($runtime.PublicUrl + '/health') -Headers $headers
if ($health.readOnly -ne $true) { throw '该入口不是预期的只读网关。' }
$runtime.PublicUrl
```

还需比较实际 HTTPS 入口的 JS/CSS 资源标识、截图和交互，不能只测 localhost。完成后停止候选和 preview，保留正式公开启动器；同步交付记录，不把某次地址可用写成永久承诺。

### 失败与回退

候选失败时不替换旧版。已经切换后出现问题，应先保留失败日志和实际资源标识，再决定停止公开入口或重新发布已确认的兼容版本。旧 `site` 可用于核对，但当前没有一键回滚按钮；前端和网关契约必须配套，回退也要重新建立会话。不要覆写旧 `site`、倒退数据库 migration 或恢复个人数据库来回退一个 CSS 修改。

## 6. 备份与恢复

一键运行的日常数据库仅监听 55433。运行中备份使用匹配的 PostgreSQL 工具，不把直接复制活动数据目录当作可靠备份：

```powershell
$ErrorActionPreference = 'Stop'
$bin = Resolve-Path .\tmp\postgres-e2e\runtime\pgsql\bin
$folder = Join-Path (Get-Location).Path 'tmp\backups'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$backup = Join-Path $folder ('scoutnews-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.dump')
& (Join-Path $bin.Path 'pg_dump.exe') -w -h 127.0.0.1 -p 55433 -U scoutnews -d scoutnews -Fc -f $backup
if ($LASTEXITCODE -ne 0) { throw '数据库备份失败，不把输出文件当作可用备份。' }
& (Join-Path $bin.Path 'pg_restore.exe') --list $backup
if ($LASTEXITCODE -ne 0) { throw '备份目录不可读取。' }
```

能列出备份目录不等于已做恢复演练。需要恢复验证时，按 [测试指南](TESTING.md) 使用 `-DatabaseBackup`，只恢复到新建的隔离数据库。正式恢复会覆盖个人资料，必须另行确认目标、备份与迁移兼容性；此处不提供可误执行的原地覆盖命令。

数据库包含历史、配置和个人状态，备份需复制到受控存储，不能只依赖同一台机器的 `tmp`。`.env`、账号凭据和浏览器收藏分别有不同保留边界；不要把它们混进公开分享包，也不要把数据库恢复当作访客浏览器收藏恢复。

SQLx 会校验已应用迁移的内容校验和。不要格式化或改写旧迁移，包括改变换行符；`.gitattributes` 对 `services/api/migrations/*.sql` 关闭文本换行转换，确保 Git checkout 保留原始字节。后续数据库调整新增迁移，不修改已应用文件。

## 7. 故障排查

| 症状 | 排查顺序 / 处理边界 |
| --- | --- |
| 端口占用、已有运行记录 | 先检查对应会话及其日志，使用配套 stop 脚本；不要删除元数据后另起同端口服务 |
| Rust 缺少 `msvcrt.lib`、`link.exe` | 用 `rust.ps1` 或已配置的 Developer PowerShell；修复 C++ Build Tools/SDK，不把本机库路径硬写进项目 |
| localhost 已更新，公开页面没变 | 比较正式 `site` 与 dist 的资源标识；只有新公开会话才复制构建，单独构建不发布 |
| 空白页、动态 import/静态资源 404 | 检查入口 HTML 与资源文件是否同一构建；候选网关启动时缓存 HTML，重建 dist 后必须换副本并重启候选 |
| 浏览器日志 `ERR_NO_BUFFER_SPACE` | 记录失败请求和运行环境，停止自己多余的临时浏览器/候选后定向复现；不能直接断言是业务分页失败或增加产品超时 |
| 公开内容比本地少 | 按 `PUBLIC-READER.md` 对齐视图、日期、筛选、排序、批次和已加载页数；检查本浏览器隐藏项 |
| 某公开能力整个缺失 | 核对能力矩阵、发布版本与两端实现；不能用“清缓存”代替修复真实缺口 |
| `/health` 正常但内容 503 | 健康检查只表示网关进程可响应；检查个人 API、上游时间/并发/响应大小及网关日志 |
| localhost 正常，外网 TLS 成功却一直没有 HTTP 响应 | 分开查看本地只读网关、实际 HTTPS 请求和 tunnel host 连接；进程活着不代表连接有效。先保存日志与运行身份，不改权限或另建公开端口 |
| 晨报为空或条数较少 | 检查实际保存日期、摘要积压/失败、资格和日程状态；不为凑数重写历史版 |
| 原站 403、429、robots 拒绝 | 遵守实际限制与退避；不自动换镜像、登录账户或用浏览器绕过平台限制 |
| Copilot 队列暂停 | 核对账号能力、精确模型、已保存额度和恢复时间；不换模型或账户掩盖问题 |
| 公开收藏消失 | 确认浏览器、域名和存储权限；不把写入失败提示当保存成功，不用站主数据库覆盖访客记录 |

日志与截图可能包含材料及本地上下文。向同事反馈问题时只提供必要的页面、窗口宽度、主题、筛选、操作步骤和已去敏错误，不发送 `.env`、数据库或完整账号日志。

### 已发生的“进程存活但隧道断连”

2026-09-20 的故障中，本地 API 与5190网关正常，实际 HTTPS 在 DNS/TCP/TLS 成功后超时；旧 host 进程仍在，但远端 host 连接数为零。旧日志包含 `Refreshed tunnel access token is not valid` 与 `Unauthorized`。这证明 host 会话失去有效授权，不证明用户登录缓存过期，也没有确定是服务端还是 CLI 的具体缺陷。

处理时先保留旧会话证据，再执行本文“切换同一公开地址”的 identity-safe stop/start，使用原 TunnelId 与 `-SkipBuild`。该次已有登录仍可用，不需要新建隧道、改变匿名连接权限、扩大端口范围、重启个人数据库或触发采集。若重新连接仍被拒绝，应先处理明确的登录/服务错误，不通过关闭授权要求或无限重启掩盖它。

恢复完成必须从实际 HTTPS 检查 `/health` 的 `readOnly=true`、文章读取与入口资源；只检查进程 ID、本地端口或 TLS 握手不够。当前启动器没有针对“活着但失联”的自动重连保证，仍需保持宿主电脑和附着式启动器运行。连接复发时沿用上述诊断边界，不把一次恢复写成长期托管。
