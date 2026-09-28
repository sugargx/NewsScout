# 运行与发布手册

适用环境：Windows 可信本地、旧 Dev Tunnel 与 Azure 开放预览；维护日期：2026-09-28。除明确说明外，命令从 ScoutNews 项目根目录执行。本页保留现有本地/隧道操作；云端 what-if、Linux 构建、digest 部署、恢复与轮换使用 [Azure 运行手册](AZURE-PREVIEW.md)。更新文档本身不启动服务、不改设置、不恢复数据库。

**当前状态（2026-09-28，以 `release-status.json` 为准）：r15 revision `newsscout--0000012` Ready，云端schema仍为30。** Single/min=max=1；20项环境变量、7项Key Vault引用，已移除 `SCOUTNEWS_INVITED_READERS`，新增固定客户OIDC provider/issuer。AuthConfig同时保留AAD与 `newsscout-account`，Microsoft或邮箱身份认证后即时建号；匿名、未知provider和错误issuer仍401。r14 GitHub App凭据继续通过零推理探针。日常本地实例保持停止，未重启或迁移，日常库仍为27；已有本地备份不等于已执行27→30恢复演练或切版。旧Dev Tunnel已退役，本页命令不授权重放历史操作。

## 1. 先分清运行环境

| 环境 | Web / 入口 | API | Gateway | PostgreSQL |
| --- | --- | --- | --- | --- |
| 日常个人版 | 5173，Vite 开发服务 | 8080 | 8787 | 55433，`scoutnews` |
| 旧匿名公开试读（已退役） | 历史端口5190，独立只读网关 | 历史配置读取8080 | 不直接访问 | 不直接访问 |
| Azure 认证开放预览 | 平台HTTPS → Node3000；公开登录200，私有API需AAD或固定External ID issuer的真实身份，首次访问即时建号 | 容器内 `127.0.0.1:8080` | 容器内 `127.0.0.1:8787` | 独立云端私网5432、TLS `verify-full`，不连接本机库 |
| 隔离真实 E2E | 15173 | 18080 | 18787 | 55432，每次新建 `scoutnews_e2e_<UUID>` |
| 页面替身验证 | 15173，Vite preview | 请求在浏览器内拦截 | 不需要 | 不需要 |
| 人工评审候选网关 | 示例 15190 | 只读访问现有 8080 | 不直接访问 | 不直接访问 |
| 手动 Docker 数据库 | 另行启动 Web/API | 另行配置 | 另行配置 | Compose 默认映射 5432 |

本地端口以loopback为边界；若另获授权复现旧隧道，也只能转发5190，不能公开5173、8080、8787、5432、55433或测试端口。当前旧隧道已退役。Azure只公开平台到Node3000的HTTPS入口，不能把localhost可信模式直接上线，旧只读网关也不是完整后台代理。

云端保持1 CPU/2 GiB、min=max=1；调度器未可横向扩展，不能加副本或缩为0来节省费用而声称日程语义不变。云端仅阅读/模型管理设置不开放，主题、来源、自定义来源、采集、完整分享和账号隐私/导出不能因“公开版”一词被一并关掉。

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

进程环境优先于 `.env`；启动器固定本轮loopback端口、日常数据库URL与助手路径。模型/额度/日程保存在 `app_settings`，重启不重置。新库默认20、可配置1–5000；本地原5000保持，当前云端则由20经200调整到5000（按最终安全聚合），不是云端新库默认，也不授权自动复制/提高其他环境预算。

手动启用原始博客浏览器补全时，还需要 `SCOUTNEWS_BROWSER_NODE`、`SCOUTNEWS_BROWSER_CAPTURE_SCRIPT` 的绝对路径，以及明确的 `SCOUTNEWS_BROWSER_ARTICLE_HOSTS`。一键启动器会提供路径并默认仅允许 OpenAI 指定主机；空主机名单关闭该路径。不要为了某站失败扩大成无约束浏览器读取。

## 4. 公开试读的启动

**旧Dev Tunnel已退役；本节及第5节保留历史/受控复现程序，不是当前启动待办。** 若要恢复须另行授权。Azure的登录、完整页面及私有操作在同一镜像，不使用此启动器；第6节的个人备份/恢复仍有独立用途。

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

云端运行新镜像会执行增量迁移，不能将其连接指向55433做部署验证。本机日常库本次已在最终无writer冻结备份、第二次完整隔离恢复通过后安全升级至27；20表原指纹不变，14份briefs、3份shares、64个sources、6168个events保留，Terra/enabled=true/5000设置不变，5173/8080响应正常，未把本地历史导入云端。今后升级仍须另行授权、匹配版本的备份与隔离演练；Azure PITR另见 [云端恢复步骤](AZURE-PREVIEW.md)。

### 个人库升级前的隔离预检

`services\api\tests\run-owner-upgrade.ps1` 是本次24→27安全升级所用的私有备份检查器，**脚本本身不写正在使用的个人数据库**。它只接受成功迁移最高版本为24的PostgreSQL custom-format `pg_dump`，不是当前27库未来升级的通用入口；不得篡改迁移版本绕过守卫。使用已配置PG17与现有Rust环境；备份保留在私有本地/批准的离线存储，**不得上传Azure、Blob、ACR/CI、聊天或提交Git**，不打印数据、设置或凭据。

从项目根目录执行以下独立PowerShell进程，将占位符替换为已存在的私有备份绝对路径。若55490已被占用，停止本次预检，不能杀掉他人的实例、改用日常55433或绕过目标保护：

```powershell
pwsh -NoProfile -File .\services\api\tests\run-owner-upgrade.ps1 `
    -BackupPath 'D:\<private-backup-directory>\<owner-backup>.dump'
```

执行边界：

1. 在 `services\api\target\owner-upgrade-validation\<run-UUID>` 下建立本次隔离数据/日志目录，使用PG17 loopback `127.0.0.1:55490` 和唯一数据库 `scoutnews_upgrade_check_<UUID>`。恢复原备份的副本，不覆盖原备份；不指向日常库或Azure。
2. 脚本只给子进程设置专用 `SCOUTNEWS_OWNER_UPGRADE_DATABASE_URL`，由Rust再次检查loopback、固定端口和数据库前缀；恢复后的版本必须为24。不要为了通过检查而改写迁移记录或目标守卫。
3. `services\api\tests\owner_upgrade\mod.rs` 是经main的 `cfg(test)` 引入的嵌套ignored Rust binary test，脚本显式使用 `--bin scoutnews-api` 选择并执行，不重启正在运行的API。不要绕过包装器直接对个人连接运行ignored测试或迁移，也不要再把该模块作为独立integration-test入口发现。
4. 迁移到当前latest前后，比较20张原有表（含 `app_settings`）原字段的行数/指纹，并逐项比较设置；新加的owner/发布快照列不混入原字段指纹。随后运行来源目录导入，允许三个目录表刷新，但继续核对私人历史/设置及local读者对原晨报、草稿、状态、兴趣的RLS可见性。
5. `finally` 清除专用环境变量并关闭本次拥有的PG；确认进程身份已退出后，只删除本次data目录。原备份保留，私有日志保留在本次 `logs` 目录；不能扩大清理范围或按进程名称停止其他PG。失败日志可能含私有恢复信息，不上传或粘贴原文。

通过必须有ignored用例**实际执行且成功**、`Restored owner database upgraded 24->...` /20表指纹和设置保留结果及Rust成功结论；脚本结束、零条用例或清理目录本身不算通过。最终交接确认：最终冻结、无writer备份再次完整恢复到隔离PG并通过24→27检查，随后才应用日常库前向迁移；目录刷新后私人历史/local RLS检查通过，隔离PG已停且仅owned data删除。当前日常库已为27，不再是“尚未升级”；原数据/设置保留的实际范围见 [Azure手册第1节](AZURE-PREVIEW.md#1-带日期的-rollout-状态)。此结果不自动授权任何后续升级。

本次后端修复是新增 `0027_legacy_evidence_realms.sql`；`0026_reader_role_membership.sql` 已负责角色membership，不能把它重新当作本次修复。Azure已应用的 `0025` 保持字节不变。

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

## 8. Azure 开放预览操作入口

完整命令以 [Azure 运行手册](AZURE-PREVIEW.md) 为准，不能混用旧隧道命令与云端生命周期。

| 操作 | 实施边界 |
| --- | --- |
| 目标与费用 | 仅用户指定的 Visual Studio/MSDN 订阅/租户；显式 `--subscription`，不改变全局 CLI context、spending cap 或自动升级规格；非生产、无生产 SLA |
| 基座 what-if/验证 | `azure-infra*.ps1`；基础设施与应用运行时分开。基座 verifier 包含“无运行时应用”检查，应用上线后不能将其当作全站健康检查 |
| 构建/部署 | `Dockerfile.azure` → 私有 ACR → digest；`cloud-app.bicep` 先阻断公众流量、配置/核对 EasyAuth，再受控开启现场验收 |
| 凭据与模型 | Azure通过GitHub App Device Flow初始化、Key Vault保存并由UAMI自动轮换 `ghu_`/`ghr_` bundle；不读取本机keyring、不接受旧PAT；精确Terra。新库默认滚动24小时20次，当前云端已保存5000，失败计入；不静默换模型，后续额度变更须另行授权 |
| 日常诊断 | 区分进程/数据库健康、Microsoft 登录、Origin/CSRF、RLS/所有权、采集/摘要和 Blob 权限；只保留去敏错误、有限路由、时间与 trace ID |
| 恢复与回退 | 云端 PITR 恢复到新私网服务器；镜像回退用已确认 digest 并核对 schema 兼容，不回滚迁移文件或覆盖个人数据库 |
| 轮换 | access token到期前自动轮换并把新的refresh token写成Key Vault新版本；账号由独立数字ID固定，`ready=false`、`accountVerified=false`、`durable=false`、refresh失败或14天内到期必须告警。切换验收必须对当前Key Vault版本做不改token值的元数据写入并读回，不能把旧bundle另写为最新版本。授权撤销或refresh token完全过期时用一次性Device Flow重新初始化，不能回退PAT |

采集取消、自助账号删除和完整使用分析面板仍未提供。开放预览保留Microsoft登录，并新增External ID邮箱+密码自助注册；两种受支持provider认证后立即创建独立应用账号，不再维护批准名单。运行参数必须固定客户provider别名、exact issuer、discovery endpoint、client ID与Key Vault secret名；回退旧镜像也不得重新注入邀请名单逻辑。手机号目前不能作为External ID第一登录因子，只能在明确启用付费短信能力后作为MFA。第二真实账号及私有偏好/编辑/发布/导出live覆盖仍有限，见 [第1节](AZURE-PREVIEW.md#1-带日期的-rollout-状态)；文档命令不表示已执行。
