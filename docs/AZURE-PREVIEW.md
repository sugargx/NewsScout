# Azure 认证开放预览运行手册

维护日期：2026-09-29。适用于独立仓库 `sugargx/NewsScout` 的完整应用，不是旧5190只读网关。命令从项目根目录在 PowerShell 中执行；基座脚本需要 PowerShell7。**第1节记录带时间的维护者交接，其余操作步骤不表示已经全部执行；实际运行结果须按记录时间区分。**

## 1. 带日期的 rollout 状态

本仓库公开，ACR登录服务器和应用地址只保存在私有记录 `tmp\azure-preview-20260920`（不入库），文中分别写作 `<ACR>` 和 `<应用FQDN>`。

**最新发布（2026-09-29）：r17已部署，Ready revision为 `newsscout--0000014`。** ACR `ckm` 于09:56:46–10:04:57（+08）成功，唯一tag `preview-20260929-r17-editorial-095534`，镜像为 `<ACR>/scoutnews@sha256:297356d6fa94851068a739d9c280f75ea75ee0f6e84ee2f9e312871774520aaa`。本轮新增迁移31，修复长篇阶段回顾漏选；同仓库、同scope、同精确版本的 scoped npm 协调发布按一个 `release-family-v2` 组展示。最终Single/min=max=1、r16退出、公开 `/health` 200，API在迁移之后监听，据此确认云端schema31。认证、GitHub App凭据、Terra/low、5000共享额度和资源规格未改。

维护切换于10:07:51停用r16，10:08:42确认其0副本，10:08:49开始部署，10:10:27确认r17唯一Healthy副本。Bicep恢复Single时控制面有一次短暂读数同时列出r16/r17各一副本，随后r16为inactive且replica列表为空，因此本轮不宣称新旧Worker零重叠。r17启动日志记录2026年9月29日三个保存作用域按 `editorial-significance-v1-ranked-v2` 沿用原截止时刻重选一次，条数为12、15、15；往期不变。

本轮Rust 177/12、空库1→31迁移与精选契约、SQL策略5/5、MCP同形态live E2E 1/1、Node生产构建、ACR Linux构建、Bicep what-if、公开健康和真实登录页通过。what-if与已接受的r16变化形状相同，0 delete；目标镜像和release ID已核对。Azure CLI容器 `exec` 仍因WebSocket 404失败，Azure Monitor MCP查询也超时，因此未完成登录态内容的第二次行级投影，不把启动日志冒充私有页面验收。交接为 `tmp\azure-preview-20260920\release-r17-20260929.json`、`runtime-parameters-r17.json`、`r17-what-if.json` 与维护时间线。

### 2026-09-28：r16记录（历史）

**r16当日部署为Ready `newsscout--0000013`，现已由r17替代。** ACR `ckk` 构建唯一tag `preview-20260928-r16-copy-f0d32ba`，镜像为 `<ACR>/scoutnews@sha256:0a109331c0458fd79305edfde98d90c426a7088f73e0cd5b8b11ac43df90b4d4`。本轮只将登录说明精简为“登录后即可创建自己的阅读空间。”；实际页面确认旧申请/人工批准措辞不存在，Microsoft和邮箱入口保持。最终Single/min=max=1、r15退出、公开 `/health` 200；认证、云端schema30、数据库、新闻、5000共享额度和资源规格未改。

本轮Web typecheck、定向Playwright 1/1、ACR Linux构建、Azure validate/what-if及真实部署页面验证通过。what-if有效容器变化只有镜像digest与 `SCOUTNEWS_RELEASE_ID`，0 delete。交接为 `tmp\azure-preview-20260920\release-r16-20260928.json`、`runtime-parameters-r16.json` 及 `tmp\customer-auth\what-if-r16.json`。

### 2026-09-28：r15记录（历史）

**r15当日部署为Ready `newsscout--0000012`，现已由r16替代。** ACR `ckj` 构建唯一tag `preview-20260928-r15-auth-fd5e02de65c3`，镜像为 `<ACR>/scoutnews@sha256:9b9f46de4d2f6605a298ea7f9d3c5a789a5d4687eac2edd2b9d9d5d58a98db2b`。最终Single/min=max=1、r14退出、公开 `/health` 200且deployment为 `customer-preview`；云端schema仍为30，数据库、新闻、读者状态、5000共享额度和资源规格未改。

r15删除维护者邀请名单、申请编号与403 `invitation_required` 流程。EasyAuth同时保留AAD并新增 `newsscout-account` External ID provider；Microsoft账号或邮箱账号认证后按稳定issuer/subject即时创建独立 `app_users`。20项环境变量中不再有 `SCOUTNEWS_INVITED_READERS`，新增客户provider和exact issuer；7项Key Vault引用新增 `customer-auth-client-secret`。AAD与客户OIDC可信代理探针均返回session 200且user ID不同，错误issuer、未知provider和匿名均401。登录页真实部署验证两个入口、无邀请文案，并明确手机号当前不能作为第一登录因子。

本轮本地验证为Node全仓typecheck/生产构建、Rust 175通过/12忽略、云端会话28/28、Bicep编译、Azure validate及全新隔离PostgreSQL合同。what-if只有Container App/AuthConfig预期修改和同一UAMI role assignment的引用渲染、0 delete；零推理Copilot探针继续 `accountVerified/durable=true`、16模型及精确Terra。External ID真实授权页显示邮箱输入和Create one，但没有可安全使用的备用邮箱，因此完整真人注册仍由用户完成。

交接为 `tmp\azure-preview-20260920\release-r15-20260928.json`、`runtime-parameters-r15.json` 及 `tmp\customer-auth` 下的构建/what-if证据。

### 2026-09-28：r14记录（历史）

**r14当日部署为Ready `newsscout--0000011`，现已由r15替代。** ACR `ckh` 构建唯一tag `preview-20260928-r14-oauth-53fb2ddb3c6c`，镜像为 `<ACR>/scoutnews@sha256:af61d1c5e43c3628db98147db4b2d44e221d4632cd93538f0affaf0029564276`。16:34（+08）完成第二次部署，最终Single/min=max=1、旧r13归零、公开 `/health` 200；云端schema仍为30，数据库、来源、读者状态、5000共享额度和资源规格未改。

r14将Azure Copilot从 `copilot-github-token` fine-grained PAT迁移到专用GitHub App Device Flow。Gateway要求显式 `github-app` 模式、公开Client ID、独立固定的数字账号ID和无版本bundle URL；bundle存放 `ghu_`/`ghr_`、generation与两类到期时间。UAMI在vault范围继续只读，只对该bundle secret取得Secrets Officer；应用配置从7项secret降为6项，不再注入 `COPILOT_GITHUB_TOKEN`。GitHub返回新token对后，Gateway先保留并持久化新一代，再核验同一账号；瞬时 `/user` 或Key Vault故障不会重用已消费的旧refresh token。

首次Device Flow核对专用账号并立即refresh后，第二代bundle写入Key Vault。容器内零推理探针确认 `accountVerified=true`、`persistenceWriteVerified=true`、`credentialDurable=true`、16个可用模型及精确Terra；真实摘要调用返回HTTP200、`gpt-5.6-terra` / `low`和非空内容。随后由运行镜像强制执行一次refresh，Key Vault版本从1增至2、generation变化、账号不变、refresh有效期更新到2027-03-28 16:40（+08）；revision重启后常驻Gateway仍为 `ready/accountVerified/durable=true`，再次模型探针通过。最终300行日志中0个初始化、refresh、持久化或进程退出错误。

第一次部署被Azure拒绝，因为模板使用了East Asia不支持的Managed Identity稳定API `2025-01-31`；自动回滚重新激活r13且前门 `/health` 保持200。模板改为已注册的 `2024-11-30` 后重新编译，第二次what-if只有Container App/Auth deploy和bundle secret级role create、0 delete，随后切换成功。旧fine-grained PAT随后通过GitHub官方凭据吊销接口撤销并实测 `/user` 返回401；吊销后再次运行容器零推理探针，账号、持久化写回、16个模型与精确Terra仍全部通过。遗留Key Vault `copilot-github-token` 于16:47再次软删除，`Recoverable` 90天且未purge，计划于2026-12-27 16:47（+08）清除。

本轮本地验证为Gateway 12/12、Node全仓typecheck/生产构建、Rust 176通过/12忽略、Bicep编译、PowerShell AST和diff检查；ACR Linux构建成功。GitHub App初始化脚本现场修正了企业/托管式登录名中的下划线以及PowerShell secret URL插值，均另行提交。r14无迁移或数据变化；回退旧镜像也不得重新注入旧PAT，必要时只能恢复旧secret作为短时应急且须记录风险。

交接为 `tmp\azure-preview-20260920\release-r14-20260928.json`、更新后的 `release-status.json`、`runtime-parameters-r14.json` 及 `tmp\oauth-r14` 下的构建/what-if/部署/探针证据。

### 2026-09-28：r13记录（历史）

**r13已由r14替代；其Ready revision为 `newsscout--0000010`。** ACR `cke` 于12:35:53–12:44:24（+08）成功，唯一tag为 `preview-20260928-r13-526c47f6`，镜像为 `<ACR>/newsscout@sha256:2a990ebb968d1fd4fc846cad21d86cf1042208fc4ee4d95f5559877cab97f3e5`。12:46:40确认r12副本归零，12:47:44新revision Ready，12:48:36完成Single/min=max=1交接；其间约63秒无可用副本。r13只修改窗口激活、页面保留与恢复层；完整记录保留在 `release-r13-20260928.json`。

### 2026-09-24：r12记录（历史）

**r12当日部署为Ready `newsscout--0000009`，现已由r13替代。** ACR `ckd` 于18:10:50–18:19:32（+08）成功，唯一tag为 `preview-20260924-r12-0295afd2`，镜像为 `<ACR>/newsscout@sha256:ef75f1ee489279da26fb630c9d3f8104c59350e9057fc91c279e82a82e014dad`。18:22:02确认r11副本归零，18:23:06新revision Ready，18:24:04完成Single/min=max=1交接；其间约64秒无可用副本，没有并行两个Worker。16项环境变量名、7项secret、唯一批准身份、0条IP规则及资源规格保持：环境变量只有 `SCOUTNEWS_RELEASE_ID` 不同，7项secret的Key Vault引用和身份不变，资源、扩缩和入口配置一致；滚动只更新镜像和发布ID，没有改AuthConfig。Terra/low/5000 保存在数据库设置中，本轮未改。资源tag与私有参数已同步为 `preview-20260924-r12`。

本轮内容：补上r11留下的缺口。选文规则版本变化后，当天已保存的晨报按当前规则重选一次并写审计；晨报3小时准备宽限期跨过北京时间零点时仍按当期计算；迁移30修复0029丢掉的读者范围来源状态；事件重要性SQL和晨报流程新增数据库契约；焦点环改为不透明并不低于3:1；分享图降低高度上限以适应iOS画布，修正手机上的按钮布局、生成期间的键盘焦点和系统分享失败提示；登录页和隐私页不再提已移除的分享草稿，隐私页新增“每日分享图”一节。规则见 [架构说明](ARCHITECTURE.md)，测试见 [测试指南第16节](TESTING.md#16-r12-晨报按新规则重选焦点可见性与分享图设备验证2026-09-24)。

本轮记录168项源码/上下文哈希，清单SHA-256以 `0295afd2` 开头：较r11新增1项、修改17项、无删除。web以外是 `services\api\src` 下的 `edition.rs`、`postgres_store.rs`、`store.rs` 和新增的 `0030_reader_source_status.sql`；Gateway和cloud-host未改。记录时复核168项输入与构建时一致。

**迁移30**：只在 `reader_editorial_features` 里重新套用0025的读者范围来源状态表达式，不改表结构和数据。滚动前确认PITR可用（保留7天，最早恢复点为9月20日21:04 +08），滚动前的恢复点为18:20:51 +08。API在监听前执行内嵌迁移，失败就不会监听；18:22:43的启动日志显示已监听，据此推断云端已为30，没有现场读取 `_sqlx_migrations`。回退限制见第8节。

**今天这一期按新规则重选**：9月24日6点的晨报由r10选出。r12启动后的第一次调度检查了两期当天已保存的晨报，都按 `editorial-significance-v1-ranked-v1` 重选：18:22:48全局晨报14条，18:22:52唯一受邀读者的晨报13条；日志中没有重选失败、调度失败或错误。原选文保存在 `admin_audits`（`edition_reselect`），往期晨报不变。r11记录中“新规则从9月25日6点那一期开始生效”的说法由此不再成立。重选结果以日志为准，没有登录查看页面，也没有现场读取审计行。

**18:26前门与18:27复查：**

| 项目 | 结果 |
| --- | --- |
| 健康、登录页、匿名私有session | 200 / 200 / 401；`no-referrer`；HTML `no-store`；未知路径由宿主回落到应用（200） |
| `/share`、匿名 `/api/v1/briefs/latest` | 200 / 401 |
| 入口脚本 `/assets/index-CAyAB5W2.js` | 与本机构建一致；原始529,704字节；br 136,014、gzip 160,373；`public, max-age=31536000, immutable` |
| 样式 `/assets/index-BTWQCIf9.css` | 与本机构建一致；原始44,730字节；br 7,473、gzip 8,428 |
| 启动顺序 | 18:22:39 Gateway与宿主启动；18:22:43 API开始监听；18:22:48、18:22:52两次晨报检查 |

**冷启动**（本机、匿名登录页、1440px、3次）：第0次TTFB/FCP/应用绘制为3626/4532/4624ms，其后FCP为1392、1268ms，应用绘制为1709、1698ms，传输约142KB，与r11相当。

日常本地实例保持停止，本轮没有启动、停止或迁移它，本地数据仍为schema27。

交接为 `tmp\azure-preview-20260920\release-r12-20260924.json`、更新后的 `release-status.json`（r11快照另存为 `release-status-r11-20260924.json`）与 `runtime-parameters-r12.json`；部署证据位于 `tmp\r12-deploy`。

### 2026-09-24：r11记录（历史）

**r11当日部署为Ready `newsscout--0000008`，现已由r12替代。** ACR `ckc` 于14:17:30–14:26:25（+08）成功，唯一tag为 `preview-20260924-r11-476dc152`，镜像为 `<ACR>/newsscout@sha256:9b106c8585dbe5107be4fcfbe02d6eccc8e8b04fa2591e98c9909771ab947cb1`。14:31:48确认r10副本归零，14:32:50新revision Ready，14:33:44完成Single/min=max=1交接；其间约62秒无可用副本，没有并行两个Worker。16项环境变量名、7项secret、AuthConfig、唯一批准身份、0条IP规则、Terra/low/5000及资源规格保持。前后配置对比只有revision名称、revision FQDN、image、`SCOUTNEWS_RELEASE_ID` 与 `lastModifiedAt` 不同；资源tag与私有参数已同步为 `preview-20260924-r11`。

本轮内容：精选按事件重要性和价值重新排序，并加入来源、版块和同一模型版本的配额；晨报在北京时间6点固定为一期，下一期之前直接返回保存的快照；分享改为一键下载当天约10条新闻的图片；修复Anthropic News解析。规则见 [架构说明](ARCHITECTURE.md)，测试见 [测试指南第15节](TESTING.md#15-r11-精选价值排序固定晨报与每日分享图2026-09-24)。

本轮记录167项源码/上下文哈希，清单SHA-256以 `476dc152` 开头：较r10新增6项、删除5项、修改20项。web以外是 `package-lock.json`、`services\api\src` 下6个Rust文件和新增的 `0029_editorial_significance.sql`；Gateway和cloud-host未改。记录时复核167项输入与构建时一致。

**迁移29**：新增1个、替换2个SQL函数，不改表结构和数据。滚动前确认PITR可用（保留7天，最早恢复点为9月20日21:04 +08），滚动前的恢复点为14:16:06 +08。API在监听前执行内嵌迁移，失败就不会监听；14:32:31的启动日志显示已监听，据此推断云端已为29，没有现场读取 `_sqlx_migrations`。回退限制见第8节。

**14:34前门与14:49复查：**

| 项目 | 结果 |
| --- | --- |
| 健康、登录页、匿名私有session | 200 / 200 / 401；`no-referrer`；HTML `no-store`；未知路径由宿主回落到应用（200） |
| `/share`、匿名 `/api/v1/briefs/latest` | 200 / 401 |
| 入口脚本 `/assets/index-C_bkQdnb.js` | 与本机构建一致；原始529,425字节；br 135,844、gzip 160,251；`public, max-age=31536000, immutable` |
| 样式 `/assets/index-608u5Ypa.css` | 原始44,182字节；br 7,398、gzip 8,354 |
| 启动顺序 | 14:32:28 Gateway与宿主启动；14:32:29有一次API就绪前的502；14:32:31 API开始监听 |

**冷启动**（本机、匿名登录页、1440px、3次）：第0次TTFB/FCP/应用绘制为3783/4244/4689ms，其后FCP为1528、1580ms，应用绘制为1578、1621ms，传输约142KB，与r10相当。r11改的是登录后的精选路径，匿名前门不变。

**精选耗时**：本机生产构建连本机API时，`latest` 中位约17ms；此前云端精选接口p50约3.9秒。记录时（14:43）云端只有匿名401探测，还没有登录后流量，云端改善要等真实使用后在App Insights确认。

**今天这一期**：9月24日6点的晨报在r10上运行（06:00:21开始）。已保存的当期仍按r10规则选出，r11不改写；新规则从9月25日6点那一期开始生效。该次运行有5个来源失败：3个自定义来源、Google DeepMind Blog和另一个内置来源。

日常本地实例保持停止，本轮没有启动、停止或迁移它，本地数据仍为schema27；评估使用55441端口上的隔离副本，结束后已停止。

交接为 `tmp\azure-preview-20260920\release-r11-20260924.json`、更新后的 `release-status.json`（r10快照另存为 `release-status-r10-20260924.json`）与 `runtime-parameters-r11.json`；部署证据位于 `tmp\brief-r11\deploy`。

### 2026-09-24：r10记录（历史）

**r10当日部署为Ready `newsscout--0000007`，现已由r11替代。** ACR `ckb` 于00:06:18–00:15:12（+08）成功，唯一tag为 `preview-20260924-r10-cdfbdd27`，镜像为 `<ACR>/newsscout@sha256:8ced46b489b5ec3562bf70c0d123a90e17f94d928c13c1eb52576d7a9310e42c`。00:29:05确认r9副本归零，00:30:06新revision Ready，00:30:58完成Single/min=max=1交接；其间约61秒无可用副本，没有并行两个Worker。16项环境变量名、7项secret、AuthConfig、唯一批准身份、0条IP规则、Terra/low/5000及资源规格保持。前后配置对比只有revision名称、revision FQDN、image、`SCOUTNEWS_RELEASE_ID` 与 `lastModifiedAt` 不同；资源tag与私有参数已同步为 `preview-20260924-r10`。

本轮记录166项源码/上下文哈希：较r9新增5项、修改44项，web以外只有 `services\cloud-host\src\app.ts` 的压缩改动。无Rust、迁移或Gateway改动，云端schema仍为28；记录时复核166项输入与构建时一致。

**00:31前门与01:08复查：**

| 项目 | 结果 |
| --- | --- |
| 健康、登录页、匿名私有session | 200 / 200 / 401；`no-referrer`；HTML `no-store`；未知路径由宿主回落到应用（200） |
| 入口脚本 `/assets/index-CScu4ZTh.js` | 原始528,365字节；br 135,395、gzip 159,660；`public, max-age=31536000, immutable`，`Vary: Accept-Encoding` |
| 样式 `/assets/index-BksjoJFF.css` | 原始44,004字节；br 7,365、gzip 8,323 |
| 启动框架 | HTML内联启动框架存在，脚本到达前不是空白页 |

**冷启动测量**：本机、匿名登录页、1440px。每次使用新的浏览器上下文，第0次同时是新的网络连接。

| 指标 | r9（9月23日21:08，3次） | r10（9月24日00:32，5次） |
| --- | --- | --- |
| 第0次 TTFB / FCP / 应用绘制 | 3579 / 4728 / 4670 ms | 3616 / 4272 / 4428 ms |
| 其后各次 TTFB | 858、930 ms | 872、881、863、858 ms |
| 其后各次 FCP | 1988、2132 ms | 1380、1680、1372、1236 ms |
| 其后各次应用绘制 | 1937、2086 ms | 1684、1728、1676、1586 ms |
| 传输字节 | 约608.9KB | 约145.1KB（−76%） |

TTFB前后基本不变：curl测得DNS约110ms、TLS约450ms，复用连接的 `/health` 往返仍约290ms，主要是本机到东亚区域的网络成本，不是服务器处理时间。

**登录后的服务端耗时**来自App Insights 36小时窗口。9月23日真实使用中，`GET /api/v1/briefs/:date`（含latest）p50为3897ms、p90为4465ms；`GET /api/v1/events` p50为2075ms、p90为2467ms。session约21ms，阅读状态PUT约123ms，曝光约40ms。记录时r10只有本机匿名session探测，没有新的登录后流量。Postgres 26小时CPU平均约8%、峰值49%，CPU credits由17升至176，不是credit耗尽。

精选每次请求都会重新组版：读取7天候选，执行编辑推荐SQL，补全全部合格候选，计算14天覆盖，再选文。这是剩余的主要延迟。缓存/预计算或只补全Top-K候选需要先确定新鲜度语义并单独验证，本轮未改后端。前端还可让当前路由代码与session检查并行加载，约省一次往返。

测试范围与失败归因见 [测试指南第14节](TESTING.md#14-r10-codesign-11重构与前端性能2026-09-24)。日常本地实例（5173/8080/8787/55433）于01:00左右发现已停止：最后一条Postgres日志为9月23日18:14:29的例行checkpoint，没有关机记录。本轮未启动、停止或迁移它，本地数据仍为schema27。

交接为 `tmp\azure-preview-20260920\release-r10-20260924.json`、更新后的 `release-status.json`（r9快照另存为 `release-status-r9-20260923.json`）与 `runtime-parameters-r10.json`；部署、前门与延迟证据位于 `tmp\ux-refactor-r10\deploy` 和 `tmp\ux-refactor-r10\latency`。

### 2026-09-23：r9记录（历史）

**r9当日部署为Ready `newsscout--0000006`，现已由r10替代。** ACR `cka` 成功，唯一tag为 `preview-20260923-r9-caf8f571`，镜像为 `<ACR>/newsscout@sha256:4b6c68e4a770f32486e815982a336a5b523215a2d9df4acb9ace771d215d9ff5`。16:51:15（+08）确认r8副本归零，16:52:24新revision Ready，16:53:07完成Single/min=max=1交接，没有并行两个Worker。完整运行配置、凭据引用和AuthConfig保持，唯一批准身份、Terra/low/5000及资源规格未改；仅更新image/release及对应资源tag/私有参数交接。

本轮只改变三个Rust源文件，161项源码/上下文哈希已记录；前端入口仍为 `/assets/index-CjqHQehz.js`，无新迁移，1–28迁移字节保持，云端schema仍为28。日常本地后端未重启或迁移，仍为27。16:54前门健康/登录页200、匿名私有session401及`no-referrer`保持。

**17:12的定向采集与材料结果：**

| 范围 | 实际结果与边界 |
| --- | --- |
| LangGraph发布归组 | `langgraph==1.2.12` 与 `langgraph-sdk==0.4.5` 在列表及各自详情均属于同一个`release-family-v2`双成员组；标题为“langgraph 同批更新：核心包 1.2.12 / SDK 0.4.5”，保留各自版本与材料 |
| 单来源补采 | 仅提交既有Anthropic News一次；完成后成功1、失败0、新增3、更新0，没有刷新其他来源或新增重复来源 |
| 官方Opus 5.5 | 已收录`Introducing Claude Opus 5.5`，原始日期2026-09-22、精度`day`、官方身份保持；72小时可见，严格24小时不可见。数据库的午夜日期表示不等于已知发布时刻，不用补采时间冒充新闻时间 |
| 材料深度 | 该时点摘要类型为`feed`；这些结果不证明取得文章全文或AI摘要已经完成，自动摘要沿原队列处理 |
| 数据保护 | 15:57发布前、17:11补采前、17:12补采后，应用设置、兴趣、阅读状态、来源覆盖/定义及获批读者作用域的3份晨报/21项快照指纹一致；不与9月22日的3/19历史样本混用 |
| 调用口径 | 复用真实已批准profile，经容器内Node3000、精确Origin与该会话CSRF提交并等待任务；不是新一次浏览器/EasyAuth交互或第二账号验收 |

维护exec最后一块传输曾返回429，退避后核对原4200字节前缀，仅续传剩余字节；完整载荷验SHA后才执行，没有重复提交采集。收集意图在POST前排他保存，成功后的私有回执保留用于防重，临时远端脚本及独立诊断依赖已清理。

交接为 `tmp\azure-preview-20260920\release-r9-20260923.json` 与更新后的 `release-status.json`；来源、回归、独立复审及跨发布保护记录位于 `tmp\source-fixes-r9`。全历史探索慢路径、其余私有live流程及独立恢复/轮换演练未在本轮解决。以下性能数值属于9月22日，不是本轮新的性能测量。

### 2026-09-22：r8记录（历史）

**r8当日部署为Ready `newsscout--0000005`，现已由r9替代。** 修正版ACR `ck9` 成功，唯一tag为 `preview-20260922-r8-8d0c1746`，镜像为 `<ACR>/newsscout@sha256:da2d7a76cae53af35cc9ea12d08b11fe54b97daaf39d03b002671dfefb2db22a`，线上入口脚本为 `/assets/index-CjqHQehz.js`。20:06:08确认r7副本归零后才启动新版本，20:13完成Single/min=max=1交接；没有并行两个Worker。唯一批准身份、其他环境、凭据引用、资源规格及完整私有运行参数保持，仅替换image/release。控制面返回的secret数组顺序有变化，排序后完整对象相同，不是凭据轮换。

新鲜度方面，24小时原本就是“今日重点”的硬边界；本次先为北京时间截止日期当天发布的合格内容预留最多3席，再按原分数补足最多8篇，并共享原多样性限制。没有合格当天内容时不凑数。9月22日16:15的实际9条当日材料全部不符合精选资格，不能将它们的缺席说成被旧高分新闻挤掉。界面显示真实截止点及来源日期精度，保存版仍不可改写。

反馈改为正常鼠标与局部待确认标签，保留乐观图标、防重复、失败回滚和重试；缓存原本已是 `refetchType: "none"`，不是通过取消“整页网络重拉”提速。数据库改为受限候选范围、批量补全和轻量状态存在性检查；bootstrap连接池关闭后才建立runtime pool，Node传播弃读取消，不改变写入、身份校验或模型预算。

**20:21:58 +08的第一轮同形维护GET：**

| 请求口径 | r7 17:14前后 | r8 20:21 | 结果 |
| --- | --- | --- | --- |
| 单篇详情 | 30.90秒 / 500 | 0.11秒 / 200 | 不再全窗口关联扫描 |
| 24小时、40条、未启用分组的推荐列表 | 34.40秒 / 200 | 1.48秒 / 200 | 此行不是UI的 `coverage=true` 请求 |
| 不传时间参数的全历史探索 | 30.29秒 / 500 | 19.06秒 / 200 | **仍慢，未视作已完成性能优化** |
| 最新精选 | 30.16秒 / 500 | 2.77秒 / 200 | 返回3篇24小时重点与4篇补读 |

调用在容器内使用已建档的获批profile，经Node3000和真实权限链路，只做GET；不含外网/EasyAuth，不是浏览器或真实收藏PUT。裸 `/explore` 查询全部历史，UI主题地图则带24/72小时和固定 `asOf`，不能混用其耗时。第一轮24小时窗口及全部3个重点成员的时间均符合响应字段。云端schema从27升至28，应用设置指纹、3份晨报/19个快照条目保持；新增迁移仅建部分索引，1–27不改写，回退限制见第8节。

**20:31:42 +08补测了实际UI使用的请求形状，全部200：**

| UI对应请求 | 云端应用内单次耗时 |
| --- | --- |
| 单篇详情 | 0.112秒 |
| 最近24小时 / 最新 / 40条 / `coverage=true` | 1.513秒 |
| 默认72小时 / 推荐 / 40条 / `coverage=true` | 1.686秒 |
| 24小时 / 72小时主题地图 | 1.498秒 / 1.629秒 |
| 72小时主题结果 / 24条 / `coverage=true` | 1.686秒 |
| 最新精选 | 2.841秒 |

该轮使用共同固定 `asOf` 和实际空搜索参数，直接对应 `RadarPage` / `TopicWorkspace`，没有为了提速缩短其窗口或丢弃分组。仍是串行维护GET，不是浏览器整页并发耗时。两轮11个维护读取在对应请求遥测中均成功，未取得新的真实收藏PUT样本；不能宣称收藏已达到某个端到端毫秒数。证据为 `r8-reader-routes-after.json`、`r8-reader-routes-ui-after.json` 和 `r8-app-requests-after.json`。

数据库CPU的独立分钟样本为19:17的87.68%、20:17的8.62%、20:32的20.56%；CPU credit在20:28采样为3。这不是同并发压测、当前余额或持续容量保证。未升级B1ms、应用CPU/内存或其他收费规格，也没提高5000应用预算。新增runtime重复读取契约与独立审查范围见测试指南；本轮本地只更新源码、保留私有备份，没有重启或升级日常27库，不把候选EXE当成本地已切版。

初版 `ck8` 虽构建成功，但复审发现隐藏关联重现和发布批次重组回归；两项均先复现、修正并独立关闭，**ck8从未部署**。本轮前门登录页/健康200、匿名私有session401、`no-referrer`及EasyAuth精确本站origin保持。仍不是第二真实账号或所有分享/导出live工作流验收。

### 同日较早的r7记录

r7为Ready `newsscout--0000004`、ACR `ck7`，镜像为 `<ACR>/newsscout@sha256:11d12dcfce40baa882ed2e5a6832c2d383c545fae20db67f06ac54ddeafdedaa`，入口 `/assets/index-D8ByvOsd.js`。12:19恢复Single、min=max=1，切换前旧副本为0；现在已由r8替代。

r7修复了账号复核打断和浏览器曝光POST的403。快速复核保持公开占位布局，不立即打开确认/退出卡片；500ms后才显示轻量状态，持续8秒或确实出错才显示恢复操作。50ms只合并重复的激活请求，不延迟私有请求、响应、DOM与portal的安全门禁。同账号保留未保存编辑、位置和焦点，切号仍销毁旧document并重新载入。

用户刷新后明确确认403不再出现。前门遥测从12:23:14开始记录真实 `POST /api/v1/events/exposures` 200，至13:40:50累计15次；未使用维护principal冒充浏览器。这只证明对应曝光保存流程，不扩大为所有分享/导出或第二真实账号已完成。匿名及伪造身份的私有session仍为401。独立代码review未发现重大问题；32个session/API场景、宿主与同源浏览器契约及有范围限制的UI Critic证据保存在 `tmp\ui-reviews\auth-calm-20260922`。当前仍为邀请预览，不是生产SLA或全功能真人验收。

### 2026-09-21：初次邀请上线交接（历史快照）

**r6当时部署为Ready `newsscout--0000003`；公开登录入口200，`approved_accounts` 仅有1个经用户明确批准的身份。真实Microsoft OAuth和读取已验证，维护通道完成了有界采集与真实Terra摘要。**

`tmp\azure-preview-20260920\release-status.json` 已更新为r9；r8交接另保留在 `release-status-r8-20260922.json`，r7交接保留在 `release-status-r7-20260922.json`，9月21日原交接保留在 `release-status-r6-20260921.json`。其中初始内容、本地升级与首次OAuth仍是有日期的历史证据，不是当前实时计数。只公开汇总，不在文档中公布读者GUID、身份名单、申请编号、私有参数或备份指纹。

| 项目 | 事实 / 证据边界 |
| --- | --- |
| 构建 / 部署 | `preview-20260921-r6`，ACR `ck6` 与部署均Succeeded；Ready revision `newsscout--0000003` |
| 运行image | `<ACR>/newsscout@sha256:f22c6716e093e7035f9afe9d72138e1252e679f51c18b65c8ba57ce4f2382a13` |
| 公开登录入口 | `https://<应用FQDN>`（地址见私有记录）；`openToUsers=true`，登录页200，桌面/移动资产检查无失败。公开入口不等于私有业务匿名开放 |
| 准入 / 外部边界 | 仅1个明确批准的不可变Microsoft身份；匿名和伪造principal的私有session请求均401。控制探测中的有效但未批准principal为403 `invitation_required`，不是第二个真人账号的OAuth验收 |
| 真实浏览器证据 | 用户完成Microsoft OAuth并复制自己的申请编号；`AppRequests` 在2026-09-21 06:57:09.332 UTC记录真实前门session/runtime/briefs/interests/events请求200，早于维护API调用，不能将其归因为维护脚本代替登录 |
| 有界维护采集 | 两个采集任务由维护通道使用**已经真实登录建档并获批准的profile**调用，不声称是浏览器点击。实际HTTP200带job对象；GitHub AI博客10条、Hugging Face博客200条，共210条真实存储事件，无本地历史导入 |
| 初始内容验证快照 | 当时完成15条 `gpt-5.6-terra` 摘要，20次尝试达到初始20次上限；当天不可变晨报快照1项，briefs/Radar返回200且有内容。210不表示全为近期内容，也不表示全为AI生成或已摘要 |
| 当前云端应用预算 | 新鲜聚合记录上限已由20经200调整至**5000次/滚动24小时**，持久化于云端 `app_settings.summary_settings.dailyLimit`。最近调整为2026-09-21 08:28:25.639 UTC，当时已用183次尝试，失败计入；上游计费设置未变更 |
| 模型与摘要证据边界 | live model probe200、17个模型且精确Terra可用；该元数据探测本身0推理，不代表整个发布0推理。200额度阶段观察完成数从15增至16；聚合未给最新完成摘要总数，不把初始15或后续183次尝试当作当前完成总数 |
| Blob / 遥测 | UAMI的合成Blob写入/读回并清理已通过；实际AppRequests摄入及真实浏览器请求已确认。仍不是本人导出端到端、全部保留策略或完整使用分析面板的live验收 |
| 代码与限定验证 | 独立review已关闭原前端High和两个后端finding，邀请准入review通过；4个auth单元、3个隔离PG契约、23个session/API、14个mock-only工作流通过，邀请页critic接受1440/1024/390。不同范围不合并成“全量真人验收” |
| 本地安全升级 | 最终冻结、无writer备份再次完整隔离恢复通过后，本机日常库已安全升级至27；20张原表指纹、私人历史和模型/阅读设置保持。隔离PG已停且只删除owned data |
| 本地保留数据 | 14份briefs、3份shares、64个sources、6168个events保留；模型Terra、处理enabled=true、已保存限额5000不变，5173/8080响应正常。个人历史未迁入云端 |
| 收尾 | 聚合确认旧Dev Tunnel已退役、临时候选UI已停止、临时云端诊断已移除；不再将退役当作待文档放行事项 |

**尚未接受为live用户流程的范围：** 第二个真实Microsoft账号、私有偏好写入、编辑/发布/撤回分享、名单撤销及本人导出。对应隔离PG与真实浏览器mock契约测试不能替代这些live证据；维护通道采集也不证明浏览器采集交互已完成。Azure PITR、凭据轮换和独立回退演练仍须单独记录。

**数字的时间范围：** `initialNews` 的210/15/20是初始采集快照；较新的 `cloudSummaryPolicy` 才是当前5000应用限额的依据。5000不是新库默认值，也不是本次文档操作作出的额度调整或费用承诺。完整部署参数包含私有准入名单，必须受控保存；安全聚合不替代私有参数，也不披露名单内容。

### 2026-09-22：定时采集与浏览器 POST 排查

10:49:59（Asia/Shanghai）的云端只读数据库快照确认，计划仍为每日06:00；本轮实际于06:00:05启动，59个来源成功、4个失败，最后成功采集结束于06:05:06。当天入库4138条原始材料、形成4133个新事件，包含首次全量来源采集带来的历史材料，不能称为4138条当天新闻。个人晨报于07:54:37保存9条；快照不会因后台继续处理而改写。

同一时点共995条AI摘要、180条失败任务、3168条待处理任务；过去滚动24小时用了1602次尝试，上限仍为5000，Terra和自动处理保持启用。这些都是带时点的统计，不是持续监控值。此次操作只读，没有手动重跑采集或重写晨报；先前未取得统计是维护查询失败，不是日调度没有执行。

浏览器出现“浏览记录未保存（HTTP403）”时，真实GET/PUT已到达应用并返回200，但POST未出现在Node的对应路由遥测中。浏览器契约确认请求有同源Origin及CSRF token；`no-referrer`有意省略Referer。11:02:59只为EasyAuth的 `login.allowedExternalRedirectUrls` 补入应用自身的精确HTTPS origin，并同步到Bicep；该次配置调整未关闭平台或Rust的CSRF校验、未添加通配CORS、未扩大邀请名单，也未重启应用。匿名私有GET/POST仍为401。随后r7部署及真实浏览器POST200证据见本节顶部，不以服务健康或隔离模拟请求替代。

### 简要历史（非当前状态）

早期Linux构建的coverage排除错误、Gateway就绪竞态及本地升级测试发现方式均已修复。r6上传后的测试模块路径整理只影响 `cfg(test)`；r4/r5封闭bootstrap和“尚未OAuth”的排队记录不是当前状态。历史失败不作为重新构建、重放部署或退回旧鉴权版本的指令。

### 已授权的用途与目标

| 项目 | 已确认值 |
| --- | --- |
| 用途 | 用户选择的邀请测试，非生产服务；不承诺生产 SLA |
| 订阅 | Visual Studio/MSDN 个人订阅；ID 只记录在本地 `tmp\azure-preview-20260920\target.json`（不入库） |
| 租户 / 部署账号 | 同上，仅本地记录；脚本启动时核对当前 CLI 的订阅、租户、账号与 token 的 tid/oid |
| 资源组 / 区域 | `rg-newsscout-preview` / `eastasia` |
| 费用边界 | 保留现有 spending cap；不改变订阅 offer，不请求提额或自动切换昂贵 SKU |

Visual Studio 月度 Azure credit 面向个人开发/测试，不附带生产财务 SLA。测试邀请本身不授权更改订阅用途或费用限制；扩大使用范围前须另行确认资格与预算。平台规则与费用边界见末尾官方资料。

## 2. 产品、身份和数据边界

- **同一完整应用**：可信本地与云端共用阅读、主题/兴趣、来源、自定义来源、采集、每日分享图。云端隐藏并在 API 拒绝阅读/模型管理设置；公共分享基础地址也是服务配置，不能由试用者改写。账号隐私、退出和本人数据导出仍开放。
- **Microsoft EasyAuth**：工作、学校、个人 Microsoft 账号使用 `/.auth/login/aad`；组织策略可能要求管理员同意。注册的 `AzureADandPersonalMicrosoftAccount` 与 `common/v2.0` 是支持范围，不是所有组织账号均已登录成功的保证。
- **批准账号准入是必需门槛**：已部署的 `approved_accounts` 只允许用户明确批准的账号，当前仅1个。`invitedReaders` 数组默认 `[]`、最多100项，以JSON传入Rust的 `SCOUTNEWS_INVITED_READERS`；缺失/格式错误使启动失败，`[]`可启动但拒绝全部私有API。每项来自用户真实认证后显示的 `<tenant UUID>:<object UUID>`，不匹配邮箱、显示名或整个租户，也不从Azure CLI guest OID推断；文档不发布实际条目。
- **每请求授权**：有效但未获邀的principal在创建 `app_users` 前收到403 `invitation_required`，响应仅给出其本人的 `invitationKey`；每个私有请求都检查成员资格。撤销后收到该403，前端清除旧document、mutation和缓存并重载，不沿用旧账号界面。显式发布快照和健康检查保持匿名例外，名单不把整站新闻变成匿名API。
- **待批准页面**：显示“这个账号还未获邀。”与只读、可选中的“申请编号”。用户手动把该编号发送给维护者，**不会自动提交申请**；页面还提供“已获批准，重新进入”、切换账号及隐私链接。重新进入只重验授权，不自行批准账号。新环境的bootstrap名单必须为 `[]`，所有者也必须真实OAuth登录后提供实际显示的编号；当前已批准身份不重置，操作见第6.5节。
- **可信代理链**：EasyAuth → Node3000 → Rust loopback。Rust 校验内部 proxy token、平台 principal；写请求再校验精确 Origin 与每用户 CSRF，带 Origin 的读取也须同源。浏览器不得自行提供可信用户标识。前端能力隐藏不是安全边界。
- **浏览器POST来源**：EasyAuth的 `login.allowedExternalRedirectUrls` 显式列出且仅列出应用自身的精确HTTPS origin。平台的Cookie POST校验发生在Node之前；不能仅凭GET或PUT成功判断POST也已接通。保留 `Referrer-Policy: no-referrer`，不要通过泄露私有页面URL、放行任意Origin或关闭CSRF来排错。
- **账号复核体验**：切回窗口、恢复可见、联网或bfcache恢复时先同步封锁私有内容及请求，再合并50ms内的激活请求。公开占位不使用缓存中的姓名、标题、数量或其他私有数据；500ms提示、8秒恢复框不改变权限校验时点。错误重试和换号不能移除document身份绑定或复用旧账号在途写入。
- **数据库隔离**：每次用户操作进入事务，设置事务内 actor 并 `SET LOCAL ROLE scoutnews_reader`；RLS隔离用户状态、兴趣、草稿、来源、晨报、任务及可选事件。不是在连接池会话上永久 `SET ROLE`。系统后台连接与匿名分享投影另有窄用途。
- **共享与私有**：公共 Feed 内容/来源种子可共享，启用、确认、间隔等选择为本人覆盖；自定义来源与其衍生材料按 owner 隔离。“私有来源”只表示用户可见性，仍遵守公共 HTTPS、robots、大小和退避限制，不允许私网抓取或第三方登录绕过。
- **发布快照**：r11 起 `/share` 在浏览器本地生成每日分享图，不上传、不创建公开链接；`/shares`、`/share/:id` 重定向到 `/share`。此前已发布的 `/p/:id` 只读取显式选中的不可变 `published_document`，可在 `/share` 页撤回；未选材料、编辑状态、账号和反馈不公开。撤回后不能重新发布同一快照。已被别人下载的副本不能收回。
- **匿名例外**：登录/隐私页、静态资源、`/health` 和 `GET/HEAD /api/v1/public/shares/{id}`。EasyAuth 的 `AllowAnonymous` 服务于这些例外，私有 API 仍由应用强制认证；不能把它改成整站匿名新闻 API。

对试用者的完整说明见 [访问契约](PUBLIC-READER.md)，实现细节见 [架构](ARCHITECTURE.md)。

## 3. 固定资源与运行契约

| 部分 | 当前 IaC / 实现 |
| --- | --- |
| Container Apps | Consumption，1 CPU/2 GiB，min=max=1、Single revision；不允许扩副本或 scale-to-zero 来保留同样调度语义 |
| 公共端口 | 平台强制 HTTPS，唯一 targetPort 为 Node3000；Rust `127.0.0.1:8080`、Copilot `127.0.0.1:8787` 不做 ingress |
| 镜像 | `Dockerfile.azure` 多阶段构建，同一完整 Web + Gateway + cloud-host + Rust；非 root `node`、`tini`、CA trust/OpenSSL。启动入口为编译后的 `services\cloud-host\dist\server.js` |
| ACR / 身份 | ACR Basic，禁止 admin 与匿名拉取，UAMI 的 `AcrPull`；不使用 registry 密码。私有访问授权不等于 ACR private endpoint |
| Key Vault | RBAC、purge protection、UAMI读取；应用使用 secret references，不用构建参数或镜像内凭据 |
| PostgreSQL | 17 / Burstable B1ms / 32 GiB，委派私有 VNet 与私有 DNS，公网禁用；`require_secure_transport=on`、客户端 `sslmode=verify-full` |
| 数据库备份 | 7天本地冗余备份、无 HA、无自动存储扩容；配置存在不等于恢复已演练 |
| 扩展与角色 | `PG_TRGM` 已 allowlist；迁移仍需 `CREATE EXTENSION` 与建角色/显式 `SET ROLE` membership。请求角色无登录、superuser、`BYPASSRLS` 或受保护表所有权 |
| Blob 导出 | Standard_LRS `exports` 私有容器，禁止匿名与 shared key；UAMI Blob Data Contributor 仅作用于该容器；7天生命周期清理 |
| 网络表述 | Blob、Key Vault、ACR 的端点可从公共网络到达，数据访问受身份/RBAC保护；不声称这些服务都有 private endpoint |
| 监控 | 手动、有限路由模板的 OTel/console；Insights/Log Analytics Entra访问，保留30天。Log Analytics `dailyQuotaGb=0.25`，不是账单硬上限 |
| 可选浏览器补全 | 仅打包助手，未装 Linux 浏览器；`SCOUTNEWS_BROWSER_ARTICLE_HOSTS` 为空。不能将本机 Edge 成功当作云端能力已验证 |

Node 先等待 Gateway 就绪再启动 API，内部进程失败时结束宿主。ACA模板显式配置 `/health` 的 startup/readiness/liveness probes；Docker HEALTHCHECK 不能代替平台 probes。健康只说明内部 API 可响应，不证明账号、导出或模型能力。

Single revision 更新会先启动新 revision，旧进程可能暂时保留；**它不是调度器排他锁**。首次空环境部署没有旧 Worker，后续更新/回退须采用经过验证的单 Worker 维护窗流程，接受短暂停机，不能宣传零停机或水平扩容。

### 运行配置

| 环境变量 | 来源 / 约束 |
| --- | --- |
| `SCOUTNEWS_AUTH_MODE` | `azure`，不得改成本地模式或 demo/public-only |
| `SCOUTNEWS_INVITED_READERS` | Bicep `invitedReaders`（array，新部署默认 `[]`、最多100项）序列化为JSON；每项是实际申请编号 `<tenant-uuid>:<object-uuid>`。缺失/格式错误拒绝启动；`[]`拒绝全部私有API。当前名单1项，仅保存在私有参数中 |
| `DATABASE_URL` | Key Vault `database-url`，仅云端目标、`verify-full` |
| `SCOUTNEWS_PROXY_TOKEN` | Key Vault `proxy-token`，至少32字节；由Node写入上游头 |
| `SCOUTNEWS_CSRF_SECRET` | Key Vault `csrf-secret`，至少32字节；用于每用户 token |
| `COPILOT_GATEWAY_SHARED_SECRET` | Key Vault `gateway-shared-secret`；API/Gateway必须同值 |
| `SCOUTNEWS_COPILOT_AUTH_MODE` | `disabled` 或 `github-app`；必须显式选择，不接受PAT回退 |
| `SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID` | GitHub App公开Client ID，仅 `github-app` 模式设置 |
| `SCOUTNEWS_COPILOT_GITHUB_ACCOUNT_ID` | 预期专用GitHub账号的数字ID；独立于可写bundle固定，仅 `github-app` 模式设置 |
| `SCOUTNEWS_COPILOT_OAUTH_BUNDLE_SECRET_URL` | Key Vault `copilot-github-oauth-bundle` 的无版本URL，仅 `github-app` 模式设置 |
| `WEB_ORIGIN` | 实际应用的精确 HTTPS origin，无尾随 `/`、路径或 query |
| `AZURE_CLIENT_ID` | 资源访问用 UAMI client ID，**不是** Microsoft 登录注册的 client ID |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | 同名 Key Vault secret `applicationinsights-connection-string`；导出器同时使用 ManagedIdentityCredential |
| `SCOUTNEWS_EXPORT_STORAGE_URL` | 基座 Blob endpoint，应用固定使用私有 `exports` 容器 |
| `SCOUTNEWS_RELEASE_ID` | 本轮非敏感版本标识，与镜像 digest/现场证据一起记录 |

基座 `database-url` 当前用于 bootstrap 管理员连接；应用启动会迁移并导入版本化公共来源目录，不是导入个人数据库。请求角色降权不代表迁移/系统登录已拆分为最小权限。收紧登录权限时要同时核验启动迁移、后台 Worker 和角色 membership，不通过给请求角色 superuser/BYPASSRLS 解决问题。基座重放不会覆盖现有 `database-url`。

## 4. 指定上下文与基座操作

以下 ID 使用占位符，按第1节授权目标和受控交接填写；不要照抄其他项目的 CLI 默认值。先确认已有目标账号登录可用，不在此流程运行 `az account set`、全局 logout 或切换全局 CLI context。

```powershell
$ErrorActionPreference = 'Stop'
$subscription = '<authorized-preview-subscription-id>'
$tenant = '<authorized-preview-tenant-id>'
$deployer = '<authorized-deployer-object-id>'
$account = '<authorized-deployer-account>'
$artifact = Join-Path (Get-Location).Path 'tmp\azure-preview-20260920'
$handoff = Get-Content -LiteralPath (Join-Path $artifact 'infra-handoff.json') -Raw | ConvertFrom-Json
$f = $handoff.foundation
if ($f.subscriptionId -ne $subscription -or $f.tenantId -ne $tenant) {
    throw '交接记录不属于本次授权目标。'
}
$rg = $f.resourceGroupId.Split('/')[-1]
az account show --subscription $subscription --only-show-errors `
    --query '{subscription:id,tenant:tenantId,state:state}' --output json
if ($LASTEXITCODE -ne 0) { throw '目标订阅上下文不可用；不更改全局 context。' }
```

读到的仅是非敏感资源交接。不要查看、复制或输出 secret 值、token、加密凭据文件内容、环境 dump、完整认证响应；不要启用含请求正文的 debug/transcript。资源 ID、secret 名称/引用和有限状态才可写入交付记录。

**只在基座阶段**使用以下脚本；当前基座已完成，不需要为发布应用重建一次：

```powershell
$scope = @{
    SubscriptionId = $subscription
    TenantId = $tenant
    DeployerPrincipalId = $deployer
    ExpectedAccount = $account
}
# 不带 -Provision：编译 Bicep 并执行 what-if，不部署资源。
.\scripts\azure-infra.ps1 @scope
# 仅经批准的新基座/基座变更；每阶段先 what-if，再部署。
.\scripts\azure-infra.ps1 @scope -Provision
# 尚无应用时检查基座控制；不会输出 secret 值。
.\scripts\azure-infra-verify.ps1 @scope -FoundationPath (Join-Path $artifact 'foundation.json')
```

脚本显式校验订阅、租户、部署者及资源组标签，拒绝越界或昂贵规格替代；基座准备过程在进程内处理 Key Vault 凭据，不需要操作者读取其值。`azure-infra-verify.ps1` 包含 `no-runtime-container-deployed` 检查：**应用部署后不要把它当日常健康探针，更不能为通过此检查删除应用**。它也未执行 VNet 内实际 SQL。

如果确需单独修复扩展 allowlist，使用已有窄范围脚本，先不带、再经批准带 `-Provision`；它保留其他扩展，只改 `azure.extensions`，不执行 SQL、不改密码/角色：

```powershell
.\scripts\azure-infra-postgres-extensions.ps1 @scope -FoundationPath (Join-Path $artifact 'foundation.json')
.\scripts\azure-infra-postgres-extensions.ps1 @scope -FoundationPath (Join-Path $artifact 'foundation.json') -Provision
```

## 5. 登录配置与应用 secret references

基座手册、登录注册、应用运行时是三个独立步骤。由基座输出计算待用 origin，仅用于配置，**不代表该地址此时可访问**：

```powershell
$appName = 'newsscout'
$origin = "https://$appName.$($f.containerEnvironment.defaultDomain)"
.\scripts\register-azure-login.ps1 -SubscriptionId $subscription -TenantId $tenant `
    -ExpectedPrincipalId $deployer -OutputDirectory $artifact -SiteOrigin $origin
.\scripts\prepare-cloud-secrets.ps1 -SubscriptionId $subscription -TenantId $tenant `
    -VaultName $f.keyVault.name -IdentitySecretFile (Join-Path $artifact 'identity-secret.dpapi')
$login = Get-Content -LiteralPath (Join-Path $artifact 'identity.json') -Raw | ConvertFrom-Json
if ($login.subscriptionId -ne $subscription -or $login.tenantId -ne $tenant) {
    throw '登录注册不属于本次目标。'
}
```

`identity.json` 仅含注册元数据；DPAPI 文件内容不得查看或放入源码/构建上下文。注册脚本复用已有记录，设置准确的 `/.auth/login/aad/callback`、退出和隐私地址；新建凭据有效期为90天，需维护到期提醒。`prepare-cloud-secrets.ps1` 只补缺失的应用 secret，保留现有值，**不是轮换命令**。丢失注册记录或凭据文件先找回受控交接，不删除记录来强迫脚本生成新注册/新密码。

Copilot不再使用 `copilot-github-token` PAT。先在维护者账号创建专用GitHub App，开启Device Flow和到期的user-to-server token，不授予NewsScout不使用的仓库、组织或Webhook权限。只记录公开Client ID；不要创建、下载或部署client secret/private key作为此流程的依赖。

完成App设置后，由预期的专用GitHub账号执行一次授权。脚本只显示GitHub验证URL和一次性user code；token响应仅保存在进程内。它会核对登录名及数字账号ID，立即刷新一次以证明无client secret的续期路径可用，再把第二代 `ghu_` / `ghr_` bundle直接写入Key Vault。保存脚本输出的非秘密 `accountId`，部署时将它作为独立账号固定值传入，不能只信任bundle中的同名字段：

```powershell
.\scripts\initialize-copilot-github-app.ps1 `
    -SubscriptionId $subscription -TenantId $tenant `
    -VaultName $f.keyVault.name `
    -GitHubClientId '<public-github-app-client-id>' `
    -ExpectedGitHubLogin '<dedicated-github-login>' `
    -OpenBrowser
```

已有bundle时脚本默认拒绝覆盖；只有明确重新授权才使用 `-ReplaceExisting`。正常运行中Gateway在access token剩余90分钟时刷新。GitHub返回新token对后旧refresh token已经失效，所以Gateway先保留并尝试持久化新一代，再对同一新access token核对独立配置的数字账号ID；瞬时 `/user` 失败只能重试新一代，不能再次使用旧refresh token。`probe-cloud-copilot.mjs` 必须在已构建镜像/受控Azure运行环境中执行，它通过UAMI读取同一bundle、对当前secret版本执行不改token值的元数据写入并读回、核对账号并列出模型能力，但不发起推理。固定版本元数据探针不会把并发刷新前的旧token重新写成最新版本。任何输出都不得包含token或secret值。

## 6. Linux 构建、digest 部署与入口开放

第1节记录已开放的受控预览。以下是新环境/后续版本的运行程序，**不是要求重放本次已完成构建、部署或登录开放**。接续部署须核对实际ready revision与完整私有参数，保留当前凭据引用、入口状态及批准名单；不得用首轮 `invitedReaders=[]` 示例覆盖现有1个批准身份。新环境仍从封闭bootstrap开始，后续开放只变更经批准的入口参数并保持同一已核对digest。

### 6.1 构建受审查的完整镜像

先审查工作树与 `.dockerignore`，确认上传到本人私有 ACR 的上下文只含允许的源码/manifest，不含 `.env`、本地数据库、`tmp`、DPAPI、keyring、日志或已构建输出。不要将其他目录拼进上下文，不传 secret build args。记录真实构建输入；dirty tree 的镜像不能只用 HEAD SHA 声称可复现。

`coverage` 也是真实 Rust 模块名，不可用 `**/coverage` 排除所有同名目录。当前仅排除生成的 `/coverage`、`apps/*/coverage`、`services/*/coverage`，必须保留 `services\api\src\coverage`。r3的npm/Vite成功只证明相应阶段，不能据此认定完整Linux镜像成功。

**Windows ACR日志的UTF-8入口：** 本机安装的 `az.cmd` 以隔离模式调用其自带Python，忽略 `PYTHONUTF8` 等环境变量；只设置环境变量不能可靠修复Unicode日志流。下面从 `Get-Command az` 推导已安装的解释器，显式使用 `-I -X utf8 -m azure.cli`，不复制某次构建输出中的D盘路径，也不安装另一套Python。若不是该MSI布局，使用已确认支持UTF-8的CLI宿主，不猜解释器路径。

```powershell
$azLauncher = Get-Command az -CommandType Application -ErrorAction Stop | Select-Object -First 1
$azPythonCandidate = Join-Path (Split-Path $azLauncher.Source -Parent) '..\python.exe'
if ([IO.Path]::GetExtension($azLauncher.Source) -ne '.cmd' -or
    -not (Test-Path -LiteralPath $azPythonCandidate -PathType Leaf)) {
    throw '不是预期的 Windows MSI CLI 布局；请使用已确认支持 UTF-8 的 CLI 宿主。'
}
$azPython = (Resolve-Path -LiteralPath $azPythonCandidate).Path
$release = 'preview-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$tag = "newsscout:$release"
& $azPython -I -X utf8 -m azure.cli acr build --subscription $subscription --registry $f.registry.name `
    --platform linux/amd64 --file .\Dockerfile.azure --image $tag --only-show-errors .
if ($LASTEXITCODE -ne 0) {
    Write-Warning '本机 CLI 未正常结束；不能据此判定远端构建失败。先查询原 task run，不重复提交。'
}
```

记录本轮实际ACR run ID。**CLI日志流的codec/Unicode错误不等于远端构建失败**，远端任务可能继续运行。若没有保留run ID，只列出目标registry的有限近期记录，结合本轮提交时间、唯一tag和镜像元数据人工确认；不能直接挑“最新一次”，也不能反复build来重试日志输出：

同样不能把 `--no-wait` 的空stdout当作未提交：9月23日本机CLI在成功排队后没有返回所查询的JSON。该轮通过有限近期run、提交时间及最终输出的唯一tag/digest确认同一个任务，没有再次提交构建。

```powershell
& $azPython -I -X utf8 -m azure.cli acr task list-runs --subscription $subscription `
    --registry $f.registry.name --top 10 `
    --query '[].{runId:runId,status:status,startTime:startTime,finishTime:finishTime,images:outputImages}' `
    --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '无法确认原远端任务，保持构建状态未确认。' }
$runId = '<confirmed-run-id-for-this-build>'
$runJson = & $azPython -I -X utf8 -m azure.cli acr task show-run --subscription $subscription `
    --registry $f.registry.name --run-id $runId `
    --query '{runId:runId,status:status,startTime:startTime,finishTime:finishTime,images:outputImages}' `
    --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '无法读取原 task run 状态，禁止部署。' }
$buildRun = ($runJson -join "`n") | ConvertFrom-Json
if ($buildRun.status -ne 'Succeeded') {
    throw "远端任务状态为 $($buildRun.status)；尚不能部署。运行中只继续查询此 run，不重复提交。"
}
$digest = & $azPython -I -X utf8 -m azure.cli acr repository show --subscription $subscription --name $f.registry.name `
    --image $tag --query digest --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw '没有可确认的镜像 digest。'
}
if (-not @($buildRun.images | Where-Object { $_.repository -eq 'newsscout' -and $_.digest -eq $digest }).Count) {
    throw '标签 digest 与已确认 task run 的输出不一致，禁止部署。'
}
$image = "$($f.registry.loginServer)/newsscout@$digest"
```

以该run的远端状态区分 `Queued`/`Started`/`Running` 与 `Failed`/`Error`/`Timeout`/`Canceled`；只有 `Succeeded` 且输出digest与唯一tag匹配才进入部署。需要读取该run日志时也使用上面的UTF-8解释器与明确run ID，不改成抓取未经确认的最后一次任务日志。

不使用 `latest` 部署。保留已验证旧 digest，别在验收前清理 ACR。ACR构建也可能产生费用；失败不等于获准改订阅、放宽策略或扩大 SKU。Windows 编译/前端构建成功不能代替这一步 Linux 镜像与运行验证。

### 6.2 先部署流量封闭的认证应用

**首次部署必须使用 `openToUsers=false`，不提供直接以 `true` 首次上线的路径。** 该参数默认就是 `false`。保留外部HTTPS ingress配置以满足EasyAuth要求，同时用bootstrap IP allowlist阻断真实公众流量，再创建子资源 `authConfigs`；不能改成最初直接开放。

首轮可先不把已经保管的 Copilot token 注入运行时，避免健康/登录验证时自动摘要消费；这不改变 Key Vault 现有凭据。其余配置仍是完整应用，不是 reduced public build：

```powershell
$appParameters = @(
    "image=$image"
    "location=$($f.location)"
    "appName=$appName"
    "environmentName=$($f.containerEnvironment.name)"
    "environmentDomain=$($f.containerEnvironment.defaultDomain)"
    "identityName=$($f.identity.id.Split('/')[-1])"
    "identityClientId=$($f.identity.clientId)"
    "registryHost=$($f.registry.loginServer)"
    "vaultName=$($f.keyVault.name)"
    "vaultUri=$($f.keyVault.uri)"
    "exportStorageUrl=$($f.storage.blobEndpoint)"
    "loginClientId=$($login.clientId)"
    "customerAuthEnabled=true"
    "customerAuthProviderName=newsscout-account"
    "customerAuthClientId=<external-id-client-id>"
    "customerAuthIssuer=<exact-external-id-v2-issuer>"
    "customerAuthWellKnownConfiguration=<external-id-openid-configuration-url>"
    "customerAuthClientSecretName=customer-auth-client-secret"
    "copilotAuthMode=disabled"
    "copilotGitHubClientId="
    "copilotGitHubAccountId="
    "releaseId=$release"
)
az deployment group what-if --subscription $subscription --resource-group $rg `
    --template-file .\infra\cloud-app.bicep --parameters @appParameters openToUsers=false `
    --mode Incremental --result-format ResourceIdOnly --no-pretty-print --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '应用 what-if 失败。' }
```

**人工核对 what-if 的资源范围与模板后，才执行下一段。** 拒绝非预期删除、规格/副本增加、非目标资源和安全边界变化。参数只保存External ID公开client ID、固定issuer/discovery URL及Key Vault secret名称，不把client secret值写入参数。

```powershell
az deployment group create --subscription $subscription --resource-group $rg `
    --name "app-$release" --template-file .\infra\cloud-app.bicep `
    --parameters @appParameters openToUsers=false --mode Incremental `
    --query '{state:properties.provisioningState,outputs:properties.outputs}' --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '认证应用部署失败，保持流量封闭。' }
```

`openToUsers=false` 仍保持 `external=true`、HTTPS-only、targetPort3000；名为 `authentication-bootstrap` 的 ingress Allow 规则只接受不可用于真实公众访问的文档保留地址 `192.0.2.1/32`，阻断真实公众流量，避免 app 与 auth 子资源创建之间的匿名窗口。这不是关闭后台 Worker。先检查 Key Vault/UAMI、私网 DNS/证书、启动迁移/角色、`/health` probes 和实际运行 digest。没有真实 SQL 成功时，不以基座 VNet 配置作为替代，也不临时打开数据库公网或降低 TLS 模式。

#### 6.2.1 启用可自动轮换的GitHub App凭据

只有第5节的Device Flow初始化成功、Key Vault中已存在bundle后，才把同一份私有运行参数切换为托管模式。Client ID是公开标识，可以进入部署参数；access token、refresh token和bundle JSON绝不能进入参数文件：

```powershell
$appParameters = @($appParameters | Where-Object {
    $_ -notlike 'copilotAuthMode=*' -and
    $_ -notlike 'copilotGitHubClientId=*' -and
    $_ -notlike 'copilotGitHubAccountId=*'
})
$appParameters += 'copilotAuthMode=github-app'
$appParameters += 'copilotGitHubClientId=<public-github-app-client-id>'
$appParameters += 'copilotGitHubAccountId=<verified-numeric-github-account-id>'

az deployment group what-if --subscription $subscription --resource-group $rg `
    --template-file .\infra\cloud-app.bicep --parameters @appParameters openToUsers=false `
    --mode Incremental --result-format ResourceIdOnly --no-pretty-print --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'GitHub App cutover what-if failed.' }
```

what-if必须只包含预期的新revision配置、移除旧PAT引用及
`copilot-github-oauth-bundle` secret范围的Secrets Officer角色；不得出现vault范围写权限。部署后先等待RBAC传播，再从容器内运行 `node scripts/probe-cloud-copilot.mjs` 或调用内部服务探测，确认 `gpt-5.6-terra`、`accountVerified=true`、`persistenceWriteVerified=true`、`credentialDurable=true` 和0次推理。这里的持久化通过必须来自当前Key Vault secret版本的真实元数据写入与读回，不能仅因“当前没有待写内容”判定，也不能通过把旧bundle写成新版本来探测。随后执行一条真实摘要并核对 `gpt-5.6-terra` / `low`。只有这些检查成功后，才撤销旧PAT并删除Key Vault中的遗留 `copilot-github-token`；回退镜像不得重新注入该PAT。

### 6.3 核对 EasyAuth，再做受控 live 验证

只读取非敏感控制面字段，避免输出 secrets、环境变量或完整登录响应：

```powershell
$appId = "$($f.resourceGroupId)/providers/Microsoft.App/containerApps/$appName"
$authId = "$appId/authConfigs/current"
az resource show --subscription $subscription --ids $authId --api-version 2026-01-01 `
    --query 'properties.{enabled:platform.enabled,https:httpSettings.requireHttps,anonymous:globalValidation.unauthenticatedClientAction,allowedOrigins:login.allowedExternalRedirectUrls,aadEnabled:identityProviders.azureActiveDirectory.enabled,aadClientId:identityProviders.azureActiveDirectory.registration.clientId,aadSecretSetting:identityProviders.azureActiveDirectory.registration.clientSecretSettingName,aadIssuer:identityProviders.azureActiveDirectory.registration.openIdIssuer,aadAudiences:identityProviders.azureActiveDirectory.validation.allowedAudiences,customerEnabled:identityProviders.customOpenIdConnectProviders."newsscout-account".enabled,customerClientId:identityProviders.customOpenIdConnectProviders."newsscout-account".registration.clientId,customerSecretSetting:identityProviders.customOpenIdConnectProviders."newsscout-account".registration.clientCredential.clientSecretSettingName,customerDiscovery:identityProviders.customOpenIdConnectProviders."newsscout-account".registration.openIdConnectConfiguration.wellKnownOpenIdConfiguration}' `
    --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '不能确认 EasyAuth 配置，禁止开放。' }
az resource show --subscription $subscription --ids $appId --api-version 2026-01-01 `
    --query "properties.configuration.secrets[?name=='entra-client-secret'||name=='customer-auth-client-secret'].{name:name,keyVaultUrl:keyVaultUrl,identity:identity}" `
    --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '不能确认登录 secret references，禁止开放。' }
az containerapp show --subscription $subscription --resource-group $rg --name $appName `
    --query '{fqdn:properties.configuration.ingress.fqdn,revision:properties.latestReadyRevisionName,external:properties.configuration.ingress.external,targetPort:properties.configuration.ingress.targetPort,ipRules:properties.configuration.ingress.ipSecurityRestrictions,image:properties.template.containers[0].image}' `
    --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '不能确认应用运行配置。' }
```

从ARM返回的投影核对平台、AAD和客户OIDC provider都已enabled、HTTPS、两个client ID与各自issuer/discovery配置正确；secret setting须分别为 `entra-client-secret` 与 `customer-auth-client-secret`，对应Key Vault引用和UAMI必须匹配本次基座，**不读取secret值**。`allowedOrigins`须恰好包含自身的精确HTTPS origin，不加通配符或第三方域名。确认bootstrap规则仍在、3000端口和digest正确、实际FQDN与两个redirect URI及 `WEB_ORIGIN` 一致，并审查运行健康及迁移结果；缺字段、引用不符或内部尚未就绪时禁止开放。`AllowAnonymous` 必须配合第2节私有 API fail-closed边界，不能单凭该字段判定成功或关闭认证。

**当前预览已完成上述引导并开放登录，实际证据见第1节。** 后续新环境必须重新核对；不能因已有一个成功环境而跳过控制面、issuer和身份验证。

新环境先以 `openToUsers=false` 部署经测试/复审的不可变镜像，核对两个认证入口、健康、迁移和应用内401边界。随后保持同一digest及其余参数，what-if后只改 `openToUsers=true`。一旦开放，所有通过受支持provider认证的用户都可即时建立独立NewsScout账号；不再存在维护者批准名单。下面仅是首次引导示例，不用于重置已开放预览：

```powershell
az deployment group what-if --subscription $subscription --resource-group $rg `
    --template-file .\infra\cloud-app.bicep --parameters @appParameters openToUsers=true `
    --mode Incremental --result-format ResourceIdOnly --no-pretty-print --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '开放入口 what-if 失败。' }
# 审查通过后执行；这是维护者的受控现场验证窗口，不是已验收的试用发布。
az deployment group create --subscription $subscription --resource-group $rg `
    --name "open-$release" --template-file .\infra\cloud-app.bicep `
    --parameters @appParameters openToUsers=true --mode Incremental `
    --query properties.provisioningState --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '入口配置失败。' }
```

此时网络入口公开，并非只允许维护者IP；私有访问仍须完成AAD或固定External ID issuer认证。扩大试用前确认External ID用户流与费用策略，并如实说明第1节未覆盖的live流程，不能把有限预览宣传为全量验收。若出现认证绕过、串号或数据泄露疑点，以**当前版本完整参数和相同digest**先what-if再将 `openToUsers` 改回 `false`，保留去敏证据；不以本地模式、跨源放行或关闭CSRF排错。

### 6.4 验收证据与扩大试用的门槛

当前已接受的是第1节列出的有限预览范围；下列未完成项不是已通过的用户流程：

1. **已验证身份/读取**：真实Microsoft OAuth及真实session/runtime/briefs/interests/events读取200；匿名、未知provider、错误issuer和伪造principal私有请求401。External ID授权页、应用绑定与回调已验证；完整备用邮箱注册仍须真人完成。
2. **已验证维护业务**：已登录批准profile的两次有界维护采集和真实Terra摘要、晨报/Radar内容；不是浏览器采集按钮证据。记录HTTP200的job对象与后续任务结果，不能将返回任务等同完成。
3. **已验证的辅助范围**：隔离PG、真实浏览器mock契约、独立登录页review、UAMI合成Blob与实际遥测；隔离库验证AAD与客户OIDC即时建号、三账号独立状态/RLS及错误provider/issuer拒绝，只接受对应范围。
4. **仍需live双账号/写入**：一个真实External ID邮箱账号，以及本人偏好、来源覆盖/自定义来源、账号切换和跨账号所有权。不得用UI隐藏或合成principal替代真实账号证据。
5. **仍需live分享/撤销/导出**：私有编辑、只公开所选不可变快照、撤回与禁止重发、本人JSON归档/返回及限额；当前均无完整用户流程验收。
6. **仍需独立运维演练**：Azure备份恢复、两个登录client secret轮换及兼容版本回退；保留有限错误码、版本和时间，不记录凭据、身份subject或正文。本地私有副本恢复成功不替代Azure灾备演练。

旧Dev Tunnel已由最终聚合确认退役，临时UI候选与云诊断已清理，不需为文档再启动它们。后续服务变更仍须单独授权，不因预览开放而自动停止个人API、Gateway或数据库。

### 6.5 自助账号、身份隔离与访问阻断

开放预览没有逐用户批准名单。平台先验证AAD或固定External ID provider，Node只把平台principal送到loopback API，Rust再严格检查provider、issuer和稳定subject。首次成功请求即时建立 `app_users`；邮箱、显示名和浏览器提交的用户ID都不参与授权。

- AAD账号以Microsoft tenant/object稳定标识映射；客户账号以部署时固定External ID issuer下的 `sub` 映射。两种身份默认是两个账号，不按相同邮箱自动合并。需要账号合并时必须另行设计双方重新认证、冲突与回滚流程，不能直接更新subject。
- External ID用户流只启用邮箱+密码注册登录。手机号在当前平台不能作为第一登录因子；短信仅是可选付费MFA，不得在界面或文档中宣传为手机号账号。NewsScout不自建密码、短信OTP或找回系统。
- `customer-auth-client-secret` 只保存在Key Vault并由UAMI引用。当前凭据到期为2028-09-27 23:59:59Z；最迟于2028-08-28开始轮换演练。轮换时先新增凭据和Key Vault新版本，再用同一镜像what-if/部署并验证邮箱入口，最后删除旧凭据；不把secret值写入参数、日志或发布记录。
- 禁用单个客户账号应在External ID目录完成；禁用Microsoft账号由其上游目录负责。应用当前没有逐用户封禁或自助删除接口，禁用登录也不会删除已有数据或撤回公开快照。数据删除仍由维护者按明确请求执行并保留最小审计。
- 若怀疑provider误配、issuer漂移、认证绕过或跨账号数据泄露，先用当前完整参数与同一digest将 `openToUsers=false`，核对旧revision退出；再修复AuthConfig或应用验证。不要临时信任邮箱、关闭CSRF、暴露Rust端口或改成本地身份。

每次身份配置或secret轮换后至少验证：

1. AuthConfig同时存在AAD和 `newsscout-account`，客户provider的client ID、secret setting及discovery URL与受控参数一致。
2. `/.auth/login/aad` 与 `/.auth/login/newsscout-account` 分别进入正确身份页面，回调只允许应用自身HTTPS origin。
3. 匿名、未知provider、错误issuer和伪造principal的私有session均401，且不会创建 `app_users`。
4. 两个受支持provider可各自建立session，user ID不同；兴趣、状态、曝光、来源、晨报、分享、导出和任务保持RLS隔离。
5. 健康、显式公开快照与私有API的匿名例外范围不因开放注册扩大。

## 7. 日常运行、限额与隐私

| 能力 | 实际限额 / 处理方式 |
| --- | --- |
| 云端手动采集/正文补全 | 异步任务，实际HTTP200带job对象，前端也兼容202；不承诺服务器统一返回202。最多100来源/批、每用户6次/小时、一个pending/running任务、全局同源claim间隔2分钟；无取消API |
| 重复/中断任务 | 可返回已有job；重复/失败提交也可能消耗提交额度。运行租约过期标为`worker_interrupted`，查看结果后再决定重试，不能无界自动重提 |
| 模型预算 | 新库默认全站滚动24小时20次；当前部署已保存5000，见第1节的更新时点。自动/手动共享、失败计入、单请求并发；手动摘要另有每用户30次/小时限制，不增加全站预算 |
| 模型选择 | 精确`gpt-5.6-terra`，支持时用`low`；缺模型/凭据时明确阻塞，原始材料仍可读，不换模型、账号或Azure OpenAI |
| 预算管理 | 自动处理新库默认开启，实际预算持久化在`app_settings`，不是环境变量每次重置。当前5000是部署后的应用配置，不是从本地历史导入的默认值；后续调整须明确授权并评估用量，不向试用者开放修改权限 |
| 本人导出 | JSON最多20 MiB、每用户每小时2次；有限字段、本人数据，不是数据库备份。Node私有归档成功后经当前认证请求返回，不提供Blob公开下载URL/SAS |
| 导出保留 | `exports/<user-uuid>/<random-uuid>.json`，生命周期在超过7天后异步删除；不保证精确TTL，也不删除用户已下载的副本 |
| 可选使用事件 | 默认关闭；实际前端只有`page_view`。有限`action` schema不是全面埋点或已交付分析面板；按账号保存，30天清理，关闭同意删除该用户现有事件 |
| 必要运行数据 | 阅读状态/曝光等服务数据与去敏运行/安全日志不受可选开关删除；暂无自助账号删除，联系维护者 |

维护通道的单源补采也须有持久回执：在POST前排他保存本轮意图和保护快照，接受后记录准确job ID。重入只观察已记录任务；有意图但job ID未知时先查明原提交结果，禁止直接再POST。保留已完成回执，防止后续材料核对失败导致重复采集；成功提交不等于任务已经成功。

容器exec传输若遭遇429，先退避，不重启应用、不扩大权限或绕过限流。只在原revision/replica和已上传前缀哈希均确认后继续未完成分块，完整载荷再验SHA及结构化完成标志。CLI退出或分块上传完成都不是采集成功；传输恢复不能变成重复执行写操作。身份、Cookie、CSRF、私有参数和原始正文不进入共享日志。

技术遥测采用 `services\cloud-host\src\observability.ts` 的有限路由集合，未知路径写`unmatched`；不记录搜索词、正文、邮箱、Cookie、principal、CSRF或服务token。只保留状态、耗时、有限分类及trace ID；不要临时开启自动HTTP/依赖采集、原始URL/body/header捕获。应用所存使用事件不应被称为不可回溯的完全匿名数据。

## 8. 备份、恢复与回退

9月21日已在最终无writer冻结备份的完整 [隔离恢复预检](OPERATIONS.md#个人库升级前的隔离预检) 通过后，将日常库安全升级至27，并核对20表原指纹及活数据。私有备份未上传，隔离PG/owned data已清理；这不等于完成下面的Azure PITR。现有脚本专门检查24版备份，不能对当前27版备份篡改版本以重放。该次修复为新增 `0027_legacy_evidence_realms.sql`，0026负责角色membership，已应用0025保持不可修改；r8的云端28索引不是本地也已迁移的证据。

### 数据库恢复

1. 以明确订阅/资源组确认云端服务器、数据库、备份保留窗口及目标UTC恢复点。7天是可用恢复窗口配置，不是已备份个人本地库，也不是已完成恢复演练。
2. 在 Azure PostgreSQL **源服务器的 Restore** 操作中选择窗口内恢复点，使用**新的服务器名**、同区域/同主版本以及受控私网配置。PITR创建新服务器，不原地覆盖源库；恢复期间有额外资源成本。
3. 在私网运行位置检查新DNS、证书/`verify-full`、迁移校验和、受限角色及显式membership；用两个专用测试账号验证所有权和RLS。不能为方便连接开公网，不能将云端数据恢复到日常55433。
4. 验证应用镜像与恢复点schema兼容后，在维护窗停止旧写入/Worker；通过批准的安全流程更新Key Vault `database-url`引用的连接内容，保持TLS校验。操作者不输出密码或连接串。
5. 重启/部署经过确认的单应用版本，检查健康、登录、本人数据、任务和分享撤回状态。恢复旧时间点可能重新出现此后已经撤回的分享/同意状态，须按受控审计处理，不能直接恢复对外访问。
6. 记录恢复点、实际数据损失范围、耗时、验证结果与新服务器ID；确认回退窗口后再按授权清理旧恢复资源。不得承诺未演练的RPO/RTO。

Blob导出是短期副本，不是灾备。托管备份不包含本机keyring、读者已下载文件或旧匿名浏览器收藏；`database-url`、登录凭据和服务凭据各有独立恢复/轮换边界。Key Vault purge protection不能被“清理”流程绕过。

### 应用更新或回退

先保留当前digest、release参数、revision、迁移状态及去敏错误。回退通常是使用**已验证兼容的旧digest重新部署**，不是回写migration、覆盖旧源码或恢复个人数据库。始终保留第6.5节私有参数中的最新名单，不能因回退重新批准已撤销用户；不支持 `approved_accounts` 的旧image只能封闭排障，不能恢复对外访问。

**r8迁移的额外边界：** `0028_reader_publication_candidates.sql` 只新增发布时间部分索引，但“DDL是增量的”不等于旧程序能重新启动。当前锁定SQLx 0.8.6，默认迁移校验会拒绝数据库中已应用、旧镜像却未内嵌的版本。因此一旦28实际应用，不能直接重新激活只含1–27的r7镜像作为可用回退；应修复前进，或另行批准恢复到兼容的新数据库。不得删除 `_sqlx_migrations` 记录、修改旧SQL校验和或关闭迁移校验来绕过此边界。实际已应用版本须现场读取，不能从候选构建推断。

**r11迁移29的边界：** `0029_editorial_significance.sql` 新增 `news_editorial_significance`，并以原签名替换 `reader_editorial_features` 与 `reader_editorial_recommendations_for_profile`，不改表结构和数据。同一SQLx校验规则下，29一旦应用，只含1–28的r10镜像不能作为可用回退。发布记录按启动顺序推断云端已为29（API在监听前执行迁移），没有现场读取；做回退决策前须先读取。常规做法是修复前进，或经批准把滚动前的恢复点（2026-09-24 14:16:06 +08）恢复到新服务器。`tmp\brief-r11\rollback-0029.sql` 会恢复旧函数并删除迁移记录第29行，与上面的规则冲突，只作为需要明确批准的应急材料；它只在隔离评估副本的事务内执行过并已整体回滚。

**r12迁移30的边界：** `0030_reader_source_status.sql` 只在 `reader_editorial_features` 里重新套用0025的读者范围来源状态表达式，不改表结构和数据。同一SQLx校验规则下，30一旦应用，只含1–29的r11镜像不能作为可用回退。发布记录按启动顺序推断云端已为30，没有现场读取；做回退决策前须先读取。常规做法是修复前进，或经批准把滚动前的恢复点（2026-09-24 18:20:51 +08）恢复到新服务器。r12 还会在规则版本变化后重选当天已保存的晨报：原选文完整保存在 `admin_audits`（`edition_reselect` 的 `before_value`），可据此核对；据此改回当天那一期属于数据写入，须另行批准，没有准备现成脚本。

**r17迁移31的边界：** `0031_editorial_synthesis.sql` 重命名当前 `news_article_policy_v1` 并创建同签名包装层，只改变长篇阶段回顾/趋势梳理的分类与价值分，不改表或存量材料。同一SQLx校验规则下，31一旦应用，只含1–30的r16镜像不能作为可用回退。r17 API在迁移后开始监听，据此确认31已应用；维护前PITR边界记录为2026-09-29 10:07:08 +08。常规回退是修复前进，或经批准把该时间前的恢复点恢复到新服务器，不能删除 `_sqlx_migrations` 第31行、改旧迁移校验和或直接重新激活r16。r17还把规则版本提升为v2并对当天三个作用域各重选一次；原选文保存在 `admin_audits`，往期未改。

1. 先核对并保存当前完整私有参数、活动revision、digest和真实副本数。需要另行封闭入口时，只用当前digest修改应用级ingress，不提前启动新镜像；封入口本身不停止后台调度。已验证的维护切换接受旧副本停止后的短暂不可用，不承诺零停机。
2. 在获准维护窗临时改为Multiple，以便停用当前revision；随后必须确认全部旧副本/Worker归零，才可启动下一版。Multiple仅是维护过渡，不允许新旧Worker并行、分流或加副本；无法确认停旧即结束本次更新。
3. 使用目标digest和最小image/release环境变量更新，保留其余环境、secret引用、名单与资源配置；若走完整Bicep则先what-if。核对schema兼容及新启动是否会迁移；旧镜像不兼容现有schema时应修复前进或按上节恢复到新库，不强行降级。
4. 新revision Ready后恢复Single、min=max=1，确认只有一个实际副本，再核对私网、登录、本人数据和公开快照；如曾封闭入口，另按准入流程恢复。记录维护起止与新revision，没有确认旧Worker退出不能称为安全单Worker切换。

下面命令仅在已有runtime、选定真实revision、确认短停后使用；执行失败就停止，不替换占位符为猜测的历史值：

```powershell
az containerapp revision list --subscription $subscription --resource-group $rg --name $appName `
    --query '[?properties.active].{name:name,active:properties.active}' --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '不能确认活动 revision。' }
$revision = '<confirmed-current-revision>'
az containerapp revision set-mode --subscription $subscription --resource-group $rg `
    --name $appName --mode multiple --output none --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '不能进入受控维护模式，禁止继续。' }
az containerapp revision deactivate --subscription $subscription --resource-group $rg `
    --name $appName --revision $revision --output none --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '旧 revision 未确认停用，禁止继续新 Worker 切换。' }
```

控制面停用返回后仍须确认旧副本实际退出；不要把HTTP流量为0当作Worker已经停止。2026-09-22的r7发布已记录“旧副本归零后启动新版本”的单Worker维护切换；这不是独立回退、PITR恢复或凭据轮换演练。

## 9. 凭据轮换与重启

准备脚本保留现有secret，不会轮换。使用批准的安全凭据流程创建新版本，**只记录secret名称、版本标识和到期时间，不查看/打印值**；先安排维护窗与恢复方法。

| 凭据 | 轮换关注点 |
| --- | --- |
| Microsoft登录client secret | 先在原注册创建替代凭据并安全写入`entra-client-secret`，确认回调、client ID和新凭据生效后才撤销旧凭据；不要删除`identity.json`或重跑“补缺失”脚本当作轮换 |
| Copilot GitHub App bundle | 正常情况下由Gateway在access token到期前自动刷新，并同步轮换refresh token；检查 `ready=false`、`accountVerified=false`、`durable=false`、`copilot_credential_refresh_failed` 与14天到期警告。账号固定值来自独立的 `SCOUTNEWS_COPILOT_GITHUB_ACCOUNT_ID`；只有授权撤销或refresh token完全过期才重新执行Device Flow，不回退旧PAT、不换账号/模型 |
| proxy / CSRF / Gateway | 协调同一容器内引用与重启；API/Node/Gateway不能混用新旧值。CSRF变化后客户端需重新获取会话，不关闭CSRF校验来消除403 |
| 数据库密码/连接 | 数据库登录凭据与Key Vault `database-url`必须一致，保持`verify-full`；只改Vault不会改变数据库密码。基座不会重置现有管理员密码或覆盖现有连接串 |
| Insights配置 | 保留托管身份和对应监控权限，不改为匿名/local-auth ingestion来解决导出失败 |

当前模板使用无版本Key Vault引用。平台文档说明会在30分钟内读取新版本，并重启引用该secret作为环境变量的活动revision；不能用“已写入Vault”证明所有进程立即生效。一般应用secret更新也不是自动创建新revision的承诺。需要受控刷新时，对已确认revision显式重启或部署新revision，再验证，勿记录秘密值作比对：

```powershell
$revision = '<confirmed-current-revision>'
az containerapp revision restart --subscription $subscription --resource-group $rg `
    --name $appName --revision $revision --output none --only-show-errors
if ($LASTEXITCODE -ne 0) { throw '重启失败；新凭据生效尚未确认。' }
```

检查健康、登录、Node→API→Gateway边界、数据库/Blob/Insights权限及有限错误；保留验证时间与旧凭据撤销记录。密钥版本、应用revision和数据库schema是三种不同版本，回退image不会自动回退其它两者。

## 10. 认证与运行诊断

| 症状 | 检查 / 禁止的“修复” |
| --- | --- |
| bootstrap阶段实际外部URL返回403 | IP规则仍只允许 `192.0.2.1/32` 时属于预期封闭状态，不是OAuth已完成或已失败的证据；不得为消除403直接开放 |
| ACR输出codec/Unicode异常或CLI非零退出 | 使用已安装的CLI自带Python `-I -X utf8 -m azure.cli` 或其他UTF-8宿主，按原run ID查询远端状态；不要把日志流失败直接记为远端build失败或重复提交 |
| npm/Vite成功但Rust报缺少coverage模块 | 检查 `.dockerignore` 是否误用 `**/coverage`，只忽略生成的覆盖率目录；必须保留 `services\api\src\coverage`，不能用前端成功代替完整镜像成功 |
| 登录回跳失败 | 精确HTTPS origin与`/.auth/login/aad/callback`、正确登录注册client ID、有效client secret；不要把UAMI client ID填进EasyAuth |
| 工作/学校账号需审批 | 组织同意/访问策略与支持的账号类型；由组织管理员处理，不关闭MFA/条件访问或承诺所有租户都可直接登录 |
| 登录后私有API仍401 | EasyAuth是否实际验证并注入principal、Node是否被平台入口访问、proxy配置/身份映射是否正确；不能让客户端伪造principal或开放Rust8080 |
| 登录后403 `invitation_required` | 用本人 `invitationKey` 显示只读“申请编号”，手动联系维护者，不会自动提交。Microsoft认证不等于批准，当前只批准1个身份；按第6.5节处理实际编号，禁止邮箱、整个tenant或CLI guest OID匹配，不公开名单 |
| 准入配置导致启动失败 | 检查 `invitedReaders` 是否为最多100项的合法UUID对数组、是否正确JSON序列化到必需的 `SCOUTNEWS_INVITED_READERS`；无成员用 `[]`，不删变量、不传空字符串、不回退到本地认证 |
| 写入403 | 当前会话/账号、精确Origin、每用户CSRF及被禁的设置路由；刷新会话而不是允许任意Origin或禁CSRF |
| 他人ID返回404/拒绝 | 正常所有权边界；用本人ID确认，不通过系统连接把私有数据透给用户 |
| 数据库启动失败 | 私有DNS/VNet/NSG、CA与主机名、`PG_TRGM` allowlist、迁移权限、显式SET ROLE membership；不改`verify-full`为不验证、不授予请求角色BYPASSRLS |
| API/Gateway运行但Copilot恢复失败 | r4曾出现 `selected Copilot connection could not be restored`，r5已解决；若复发，核对Gateway就绪等待、服务凭据引用/内部连接、精确模型资格及预算。该通用警告不证明token无效；不打印凭据、不扩大GitHub权限、不静默读本机keyring或换模型 |
| 采集429/任务重复 | 6次/小时、一个活动任务、同源2分钟claim和上游退避；先读本人job状态，无取消端点 |
| 导出失败 | 本人JSON大小/频率、UAMI在`exports`容器的权限与Blob可达性；不打开匿名ACL、shared key或输出SAS |
| 没有产品事件 | 默认关闭可能是正确结果；检查同意及当前`page_view`范围，不声称已上完整analytics |
| 缺运行日志 | 摄入是异步的，本轮 `AppRequests` 在延迟后才出现；先按有限时间窗等待/核对exporter与MI权限，再检查30天保留和0.25配额。达到cap可能丢日志，不自动提额度或记录正文补偿 |
| restart/新revision异常 | 对比digest、配置引用、单Worker切换与schema兼容；不能仅凭资源存在或TLS握手认定可用 |

排错不导出完整`/.auth/me`、Cookie、请求头、进程环境、Key Vault值或原始正文。向试用者/维护者反馈只提供时间、route模板、有限错误码、trace ID与必要复现步骤。

## 11. 成本与清理边界

- 保持用户现有spending cap，不执行删除/提高上限或更改订阅offer。额度耗尽可能使资源停止服务；Marketplace等不适用credit的项目仍可能另收费，不能将cap宣传为绝对无费用风险。
- Azure Budget/告警是提醒，不是资源自动停机或硬上限；Log Analytics `dailyQuotaGb=0.25`只约束日志摄入且是尽力控制，既不是总预算也不覆盖计算、存储、网络和模型费用。
- 即使无访客，常驻应用、PostgreSQL、ACR、备份/Blob、监控及托管网络仍可能计费；构建和恢复的新资源另增成本。小规格不保证全部月费用落在credit内，不在缺少实际账单时写月成本承诺。
- 不加入AKS、NAT、Redis、Cosmos、专用工作负载档或premium private endpoints作为未授权“优化”；容量失败不自动升级。数据库自动增长关闭，需监控剩余容量，不能等写满后靠忽略错误维持。
- 基座会有ACA托管`ME_...`组及平台自动创建的`NetworkWatcherRG`等副作用；不得删除共享平台资源、关闭订阅级Network Watcher或影响其它项目。停止邀请测试也不等于获准删除整个资源组/数据库；先确认保留、备份和授权。

### 官方平台资料（核对日期：2026-09-21）

实现参数以仓库Bicep/脚本为准；以下说明用于核对平台行为，不代表本项目已完成现场验证：

- Visual Studio Azure开发/测试credit：`https://learn.microsoft.com/en-us/visualstudio/subscriptions/faq/subscriber/azure/`
- Spending limit与例外：`https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit`
- Container Apps认证：`https://learn.microsoft.com/en-us/azure/container-apps/authentication`、`https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra`
- Key Vault引用与更新：`https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets`
- Single revision生命周期：`https://learn.microsoft.com/en-us/azure/container-apps/revisions`
- 环境变量变更与新revision：`https://learn.microsoft.com/en-us/azure/container-apps/environment-variables`
- ARM参数文件、what-if与部署CLI：`https://learn.microsoft.com/en-us/cli/azure/deployment/group`
- PostgreSQL恢复到新服务器：`https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/how-to-restore-latest-restore-point`
- CLI构建/任务状态/镜像和revision操作：`https://learn.microsoft.com/en-us/cli/azure/acr`、`https://learn.microsoft.com/en-us/cli/azure/acr/task`、`https://learn.microsoft.com/en-us/cli/azure/acr/repository`、`https://learn.microsoft.com/en-us/cli/azure/containerapp/revision`
- Python隔离模式与显式UTF-8参数：`https://docs.python.org/3/using/cmdline.html`
