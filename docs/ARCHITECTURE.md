# 当前实现架构

适用版本：0.2；维护日期：2026-09-24。本文区分可信本地、Azure认证完整应用及已退役的旧匿名网关，不把代码或 [V0规格](V0-SPEC.md) 当全量验收。**r11已部署为Ready `newsscout--0000008`，云端schema推断为29，仍仅1个明确批准身份。** r11改为按事件重要性与价值选文（迁移29只新增1个、替换2个SQL函数），晨报在北京时间6点固定为一期并直接返回保存的快照，分享改为浏览器本地生成的每日分享图；r10的CoDesign前端与压缩、r8/r9的新鲜度、包发布识别、受限读取与连接生命周期改进继续保留原RLS、身份门禁及Origin/CSRF。事件列表的后端耗时与全历史探索慢路径未在本轮处理，实际交接与测量见Azure手册。日常本地实例保持停止，本轮未重启，本地数据仍为27。第二真实账号及其余私有分享/导出live流程受证据范围限制；产品词汇见根目录 `CONTEXT.md`。

## 进程与职责

| 部分 | 入口 | 职责与边界 |
| --- | --- | --- |
| Web | `apps\web\src\main.tsx`、`App.tsx`、`auth.tsx` | React、TypeScript、Fluent UI；可信本地和 Azure 共用完整应用，旧 `data-public-reader` 是另一套只读入口 |
| Azure Node host | `services\cloud-host\src\server.ts`、`app.ts` | 唯一面向平台 ingress 的3000端口；完整静态页面、受控 API 转发、内部进程监督、私有导出归档与手动遥测。按 `Accept-Encoding` 优先返回 br、其次 gzip：1KB以上的 HTML/JS/CSS/SVG 在启动时预压缩并缓存，1KB以上或长度未知的 JSON 响应流式压缩 |
| API / Worker | `services\api\src\main.rs`、`app.rs` | Axum API、来源采集、摘要队列、日程与选文；后台任务由同一 API 进程启动，不是另一个已部署 Worker 服务 |
| 数据库 | `services\api\migrations` | PostgreSQL；原始材料、来源配置、摘要、阅读状态、快照和任务持久化 |
| Copilot Gateway | `services\copilot-gateway\src\index.ts` | 通过 Copilot SDK 执行受约束的模型任务；不向公开访客提供代理模型接口 |
| 来源浏览器读取 | `services\source-access\browser-article.cjs`、`services\api\src\browser_articles.rs` | API 调用的受限原始博客读取助手，不是通用浏览器或持续运行的独立 HTTP 服务 |
| 旧公开阅读网关 | `services\public-reader\server.cjs` | 5190匿名只读入口、静态页面与允许列表 API；读取本地 API，不是 Azure host，不直接连接数据库或模型 |
| 本地进程管理 | `scripts\runtime-common.ps1` 与 `start/stop-*.ps1` | 注册并验证自己启动的进程、等待服务就绪、保存运行元数据；不按进程名称批量清理 |

默认端口与启动方式见 [运行与发布手册](OPERATIONS.md)。旧门户由 `start-public-reader.ps1` 启动；Rust 中另有 `SCOUTNEWS_PUBLIC_ONLY` 分享读取分支，不是5190门户，也不是 Azure 完整应用。云端明确要求 `SCOUTNEWS_AUTH_MODE=azure`、持久化数据库，拒绝 demo/public-only 降级；缺少安全配置即失败，不从本机 `.env` 补云端配置。

## Azure 部署与身份边界

`Dockerfile.azure` 打包同一完整 Web、编译后的 Node host、Rust API 和 Copilot Gateway，运行于非 root 用户并用 `tini` 转发信号。`infra\cloud-app.bicep` 只将平台 HTTPS ingress 指向 Node3000；Node 启动并监督 Rust `127.0.0.1:8080` 和 Gateway `127.0.0.1:8787`，不开放两个内部端口。它等待 Gateway 就绪，任一内部进程退出会触发宿主退出；`/health` 查询 API 就绪，不证明 OAuth、RLS、导出或模型可用。

Container Apps 为 Consumption、1 CPU/2 GiB、min=max=1，使用 Single revision。采集、摘要、日程仍与 API 同进程，不是已实现横向扩展的任务系统；不能增加副本或缩为0来保持同样调度语义。Single revision 也不是调度排他锁：更新时可能短暂保留新旧进程，后续发布需验证受控单 Worker 切换，不能承诺零停机。

认证链路如下：

1. 平台 EasyAuth 使用 Microsoft identity，注册 audience 为工作/学校与个人 Microsoft 账号，issuer 使用 `common/v2.0`。组织策略可能要求管理员批准。注册应用的 client ID 与访问 Azure 资源的 UAMI client ID 是两个不同身份。
2. 平台允许匿名到达登录/隐私/静态页面及明确发布的快照，因此 `AllowAnonymous` 不是“私有 API 不认证”。`/p/:id` 的投影和 `/health` 有明确例外，其余 API 在 Rust 中校验。
3. Node 仅转发有限请求头，覆盖 `X-ScoutNews-Proxy-Token` 为内部配置值。Rust 同时要求可信代理密钥与 EasyAuth `X-MS-CLIENT-PRINCIPAL`，拒绝重复/冲突认证头，使用租户/对象身份映射内部用户，不把浏览器传来的用户 ID 当授权。
4. 写请求必须同时匹配精确 `WEB_ORIGIN` 和该用户的 CSRF token；读取若带 Origin 也须匹配。前端从 `/api/v1/session` 获取会话及能力，账号切换/过期时丢弃私有缓存。仅隐藏按钮不构成授权。
5. 云端拒绝模型提供方/连接、阅读设置、模型处理设置/全局重试及分享基础地址修改；主题、来源、采集、草稿和隐私仍属完整应用。已部署的 `approved_accounts` 使用Bicep `invitedReaders` array（新环境默认 `[]`、最多100项），JSON传入Rust必需的 `SCOUTNEWS_INVITED_READERS`；缺失/格式错误拒绝启动，`[]`拒绝全部私有API。只匹配真实认证用户申请编号中的 `<tenant UUID>:<object UUID>`，不按邮箱/名称/整个tenant或CLI guest OID推断；当前1项名单仅私有保存。
6. 每个私有请求校验名单；有效但未获邀principal在创建 `app_users` 前收到403 `invitation_required` 和本人 `invitationKey`。UI只读显示申请编号，需本人手动发送，不自动批准。已完成首个真实OAuth/批准/读取；撤销后的document、mutation和缓存清除/重载是实现契约，尚无完整真人撤销流程验收。匿名显式快照与健康检查保持例外；证据分层见 [Azure手册第1节](AZURE-PREVIEW.md#1-带日期的-rollout-状态)。

外部匿名与伪造principal的私有session请求实际返回401。真正OAuth后的前门读取200早于维护调用；后续维护通道使用该已建档批准profile进行两次采集，不能把这种调用冒充浏览器行为或第二账号验证。不得直接暴露Rust或以可信本地模式绕过Azure边界。

### 数据库、身份和共享材料

`0025_cloud_readers.sql` 与 `auth.rs` / `scoped_db.rs` 实现请求内隔离。每个用户操作进入显式事务，设置事务级 `scoutnews.actor`，执行 `SET LOCAL ROLE scoutnews_reader`；角色和 actor 随提交/回滚消失，不在连接池会话上保存可串号的可变身份。请求角色为 `NOLOGIN`、非 superuser、无 `BYPASSRLS`，不拥有受保护表。

既有 `0026_reader_role_membership.sql` 负责角色membership，legacy evidence realm修复为新增 `0027_legacy_evidence_realms.sql`；已应用0025保持不可修改。本次先用最终冻结备份完成 [隔离恢复预检](OPERATIONS.md#个人库升级前的隔离预检)，再安全升级日常库至27，20表原指纹与原历史/设置保持。今后升级仍需独立授权和对应版本的恢复验证，不能直接重放只接受24版备份的检查。

RLS 覆盖兴趣、收藏/打开/曝光、晨报、草稿、自定义来源、来源覆盖设置、采集任务、可选使用事件等。公共来源种子与其公共新闻材料可以共享，用户的启用、确认与采集间隔通过 `user_source_overrides` 表表达；用户新增来源及其衍生材料保留 owner realm，不与他人或公共材料混合成摘要。自定义来源仍受公共 HTTPS/采集策略约束，不获得私网抓取权限。

后台迁移、调度及极窄的匿名发布投影使用系统连接；不能因此宣称整个数据库登录本身已最小权限化。基座 `database-url` 当前是bootstrap管理员连接，启动执行迁移/目录导入；PostgreSQL17需显式 `SET ROLE` membership，不能给请求角色superuser/BYPASSRLS。隔离PG已测所有权，第二个真实Microsoft账号的live跨账号验证仍未完成。**日常库已安全升级27；云端未导入个人历史，初始210条云端事件来自独立维护采集。**

### r8读取路径与连接生命周期

数据库模式的 `connect_runtime_database` 先用bootstrap pool完成增量迁移和版本化来源目录导入，无论成功或失败都会关闭该池；初始化失败继续传播，成功后才以相同数据库URL、TLS和最多10连接建立新的runtime pool，并交给Store、认证及Worker。不是通过扩大连接池、放宽超时或RLS提速；demo/public-only分支不变。新增28只为 `content_items(published_at,id)` 建立非空发布时间部分索引，已应用1–27不改写；实际部署/schema状态以本文顶部和Azure手册为准。

列表和精选先在同一受限、repeatable-read事务中取得窗口内候选ID，再交给原评分器，保持账号/来源权限、排序和分页。证据、阅读状态及任务信息按批读取；精选先筛合格候选，再补确实相关的材料并执行原分组/名额选择，不为每条候选重复完整详情查询。单篇读取限定当前ID，反馈写入前只做受限的published事件存在性检查，成功后返回同一受限详情，不先后两次扫描整个时间窗。

关联发现仍使用原来的有界发现窗口，只加载精确GitHub/arXiv引用及有关仓库的发布候选；私有读者的不感兴趣材料不作为其他条目的关联重现，访客不继承站主隐藏状态，明确按ID读取已隐藏条目仍可返回本人的状态。发布家族必须保留窗口内决定批次的同仓库候选，不能先以“距请求条目24小时”裁剪再分组；24小时组跨度仍由原有newest-first cohort选择器约束，避免列表和详情重新拼出不同组。

Node宿主在客户端放弃GET/HEAD时向上游传播取消，正常响应结束不误取消；已转发写操作、导出、原230秒宿主上限及身份/Origin/CSRF契约不改。浏览器反馈仍仅修补阅读状态并做 `refetchType: "none"` 失效，不自动整页重拉；去掉繁忙鼠标不代表服务器保存已经成功。性能测量区分前门浏览器、维护GET、SQL计划及隔离数据，见测试指南与带时间点的发布记录。

### Azure 资源与观测

- PostgreSQL17、Burstable B1ms、32 GiB，委派子网/私有 DNS，禁止公网入口；`verify-full` 校验 TLS 与主机名。7天本地冗余备份，无 HA；`PG_TRGM` allowlist 已配置，真正 `CREATE EXTENSION` 仍由应用迁移执行。
- ACR Basic 禁止匿名拉取与 registry admin，通过 UAMI `AcrPull` 拉取镜像；运行参数引用 Key Vault，不把凭据放镜像或构建参数。数据库目前用密码连接，不声称已实现数据库 Entra token 自动刷新。
- `exports` Blob 容器禁止匿名与共享密钥，通过 UAMI/Entra RBAC 写入 `<user-uuid>/<random-uuid>.json`。Blob、ACR、Key Vault 的服务端点不是 private endpoint；“私有”描述访问授权，只有上述数据库明确使用私网。
- Node 手动创建有限路由模板的 trace 与请求结果/耗时日志，未知路由记作 `unmatched`，不采集原始查询、正文或身份头。Azure Monitor 使用托管身份，未启用自动请求/依赖内容采集；Logs/Insights 保留30天，Log Analytics 日配额0.25 GiB，不是总费用硬上限。
- 可选产品事件与必要运行日志分开：默认不收集；当前前端仅发送 `page_view`，后端有限事件 schema 不等于完整行为埋点或分析面板。事件按账号保存并保留30天，撤回同意删除该用户已有事件。
- 镜像包含原始博客读取助手但不含浏览器，云端浏览器主机名单保持空；尚未验证兼容 Linux 浏览器及内存预算，不能把本机 Edge 能力视为云端已接通。

## 数据流

1. 来源配置决定可采集的具体入口；关注名单记录待核实或部分接通的对象，关注项不自动成为订阅。
2. `ingestion.rs` 及适配器请求公开材料，执行响应大小、公共地址、重定向、robots 与退避约束，保存原始身份和来源时间。
3. 规范化后的实质材料变化更新内容版本，并在数据库事务中创建或更新摘要任务。
4. `automation.rs` 领取持久化任务，经私有 API 的单请求锁和额度检查调用 Gateway；成功后保存要点、阅读标题、证据 ID 与真实处理信息。失败保留原有可读内容。
5. 阅读查询执行资格判断、排序、明确事件分组与分页；晨间快照另行保存，周报是滚动窗口回顾。
6. 可信本地浏览器写入本机个人状态；Azure 认证浏览器写入本人云端状态。旧匿名浏览器通过只读投影取材料，自己的反馈只写浏览器；访客兴趣同样保存在浏览器，但选中主题会随 GET 请求发送，用于请求内排序。

打开文章、切换来源内容或刷新阅读页面不是采集任务，也不应顺带生成摘要。旧公开网关只读不意味着个人后台停止自动调度；云端正常阅读也不等于后台预算和 Worker 已暂停。

云端主动采集由 `ingestion_jobs.rs` 返回持久化 job ID，Worker 在 owner scope 下处理；每批最多100来源、每用户每小时6次提交、最多一个 pending/running 任务，全局同一来源2分钟 claim 间隔。重复提交可能返回既有任务，不能当新任务成功；没有取消端点。过期 running 租约会标记 `worker_interrupted`，不以无界自动重提掩盖中断。

Anthropic News 的 `source_adapters.rs` 以服务端索引中的标题/日期卡片识别文章，而非仅按 `/news/` 路径识别。允许经过校验的官网根路径公告与原新闻路径；排除导航入口、站外/带凭据/异常端口地址及含混编码路径，不请求文章正文或执行脚本。已识别卡片缺少必要字段、日期不合法或超出200条界限时使采集失败，沿用现有 `fetch_runs` 与来源失败/退避链路，避免“仍能解析旧文章”掩盖部分漏采。News 的此门槛不改变 Research/Engineering 的目录与截断契约，也不宣称网站全量覆盖。

仅有日期的公告继续保存来源日期和 `datePrecision=day`；明确的 RFC3339 时间保留 `time` 精度。格式和材料未变的旧日期卡片保留原身份与内容指纹，不因本次解析扩展而重排摘要；新增材料与发布者的实质更新仍沿用正常处理队列。24小时筛选与历史晨报规则不变，补采时间不替代发布时间。

## 主要数据对象

| 实现对象 / 表 | 含义 | 必须保留的区别 |
| --- | --- | --- |
| `sources`、`source_watchlist`、`source_directory_imports` | 来源配置、待核实对象、版本化目录导入记录 | 已登记、可访问、采集成功和用户确认不是同一状态 |
| `content_items`、`content_item_identities` | 来源原始材料及稳定身份 | 标题变化、再次抓取不应随意生成另一篇新闻 |
| `events` / `Event` | 当前可阅读条目、摘要与内容版本 | 代码名为 Event，不代表每个条目已被判定为独立现实事件 |
| `event_evidence` / `Evidence` | 具体出处及取得的材料；详情可包含 `readingContext` | 来源证据存在不等于已取得全文或事实已核验 |
| `CoverageBundle` / 覆盖包 | 多份明确相关材料的展示投影 | 不删除成员身份，不用主条目摘要代替整组总结 |
| `summary_jobs`、模型尝试记录 | 队列状态、版本/租约/重试与滚动用量 | 摘要格式升级不等于材料内容版本升级 |
| `user_event_states`、`event_exposures` | 个人收藏、不感兴趣、主动打开与被动展示 | 打开不等于读完，曝光不等于喜欢 |
| `daily_briefs`、`daily_brief_items.snapshot` | 保存版元数据、选文与当时内容；r11 起也是当期 `latest` 的直接来源 | 当前文章更新不能重写旧版选文、摘要和顺序 |
| `app_settings`、`morning_runs` | 已保存设置和每日任务记录 | 新库默认值不能覆盖既有模型、额度和日程 |
| `reader_shares` | 本人素材草稿、编辑状态及 `published_document` | 私有 `/share/:id` 与匿名 `/p/:id` 分开；显式发布只冻结选中项，撤回不允许重发同一快照。r11 起前端不再编辑草稿，`/share/:id`、`/shares` 重定向到每日分享页 `/share`，该页仍列出已发布链接并可撤回；每日分享图在浏览器本地生成，不写入此表、不上传图片 |
| `app_users`、`user_source_overrides` | 平台身份映射、同意状态及本人公共来源覆盖 | 注册租户、UAMI、用户身份和公共来源种子不是同一类对象 |
| `ingestion_runs`、`ingestion_source_claims` | 本人异步采集任务与全局来源提交间隔 | 采集任务限额不是模型预算，没有取消端点 |
| `reader_telemetry`、`reader_rate_limits` | 可选事件及按操作限流 | 可选事件可撤回，不等于删除必要阅读状态或运行日志 |

数据库存在预留的知识关系结构，但当前主题图是阅读查询中的关键词共现结果，不是已经交付的完整持久化语义知识图谱。数据库 schema 与面向用户的能力不能画等号。

本人 JSON 导出使用一致性读取和显式投影，上限20 MiB、每用户每小时2次，不导出其他用户、凭据、系统设置或整库抓取正文。Node 先通过托管身份保存私有归档，再将 JSON 返回当前认证请求；没有公开 Blob 下载链接或 SAS。导出副本设7天生命周期清理，异步清理不承诺精确时刻。暂无自助账号删除。

## 排序、分组与时间

编辑评分来自 `0022_editorial_article_policy.sql`；`0023` 更新付费预览材料边界，`0024_visitor_interest_profiles.sql` 增加 `reader_editorial_recommendations_for_profile`。r11 的 `0029_editorial_significance.sql` 新增 `news_editorial_significance`，并以原签名替换 `reader_editorial_features` 与 `reader_editorial_recommendations_for_profile`：只换函数，不改写已存材料、摘要、事件身份/日期或已保存晨报与分享快照。原四参数 `reader_editorial_recommendations` 保留为等价包装器，仍供站主与晨报任务使用；未修改已应用 migration。`tmp\brief-r11\rollback-0029.sql` 会删除迁移记录第29行，只作为需要明确批准的应急材料；常规回退按 [Azure手册第8节](AZURE-PREVIEW.md#8-备份恢复与回退) 修复前进或恢复到新服务器。

| 分量 | 当前权重（r11） |
| --- | --- |
| 事件重要性 `editorial-significance-v1` | 35% |
| 原文价值 `article-value-v1` | 20% |
| 显式兴趣 | 15% |
| 分类型时效 | 15% |
| 来源与证据质量 | 10% |
| 主动反馈 | 5% |

原文价值只衡量取得了多少可用原始材料，分不清旗舰发布与普通论文，所以新增“事件重要性”。它是确定性、可解释的估计，不是模型判断或事实核验：先按发布者角色（第一方公司/实验室、项目、编辑/作者、播客、论文索引、社区）与内容类型给基础分；第一方的明确发布动作加5–20分，二手媒体只有命名旗舰模型版本的发布才加5分；标题含旗舰模型版本加5分，人事动态减10分；非第一方的补丁或预发布版本减15分、主版本加10分；每多一家独立发布者再加10分，最多加30分，因此不再单列“独立报道覆盖”。依据写入 `editorial.significanceBasis`。时效为 `100×0.5^(小时/半衰期)`：研究、分析、教程96小时，发布48小时，其余30小时，周报统一168小时。精选资格在原有可选材料条件上，另要求重要性至少60，或重要性至少45且原文价值至少60；代码仓库、哈希式工程构建、聚合型证据及7天外材料不进入精选。

其后仍有有界重复展示调整（打开后最多降6分，按48小时衰减；曝光最多降3分，按24小时衰减）、明确排除（降200分）和来源多样性/版块名额限制。`score` 排序的“来源与热点分”是另一口径，不是上述个人推荐分，也不是把七月拟议公式原样用于当前精选。

日版编排为 `editorial-significance-v1-ranked-v1`，部署状态另见Azure手册。主列表只收选文截止前24小时的合格内容，按综合分从高到低逐条贪心入选，前5篇为“今日重点”，其余为“更多值得读”；不再给当天发布预留名额，任何版块都不能把低分内容排到高分之上。名额在整期内共享：每个发布者最多2篇（周报3篇），社区、论文索引最多各2篇，播客最多3篇，每主题最多5篇；同一模型版本在96小时内只收排名最高的一篇报道，第一方公告（含定价、缓存、系统卡等后续）不受此限。“值得补读”最多3条，排在主列表之后，只收过去7天内发布、从未入选往期精选、重要性至少60且原文价值至少70的内容（没有重要性字段的旧演示材料沿用价值至少68）。每期目标上限由设置 `briefLimit` 决定（默认20，范围5–30），合格内容不足时宁缺毋滥。周报按主题分组，不计重复曝光。

`reader.rs` 负责阅读编排、晨报/周报选择；`coverage.rs` 与 `coverage` 子目录负责明确关联的展示。只有精确事件引用或符合约束的同批次发布家族才合并展示；同品牌名和同主题不等于同一事件。详细例子与限制保留在根 `README.md` 的“推荐与重复展示”部分。

`coverage\release_family.rs` 的 `release-family-v2` 扩展到 SDK / CLI / SDK Provider：客户端成员必须有同仓库共同变更引用，组件身份包含类型，避免把 Node CLI 与 Node SDK 当作同一目标；语言别名又避免把 Node / TypeScript SDK 的连续版本混为不同组件。插件家族不与客户端家族混合。官方身份、标签/标题对应、精确发布时间、24小时总跨度与组内共同变更交集仍是边界。

`package_release` 另识别 `包名==版本` 标题与对应的裸核心标签或 `组件==版本` 标签，以独立的 `repo:package` 家族键进入同一确定性批次算法。核心包必须对应仓库名，子组件必须对应 `仓库名-组件`，仅一次解码 `%3D` 分隔符。多份证据必须同意仓库/组件/版本身份并保有共同的明确改动；没有共同改动、跨仓库、仅日期及同组件不同版本都不能因此混组。显示“核心包”或对应组件及其原始版本，各篇内容、个人状态和已保存包仍独立保留；不调用模型合成标题或摘要。

发布家族先以来源时间倒序及事件 ID 建立确定性批次，再由列表排序选择组内主条目；同一候选集合不因兴趣或排序改变组成员。标题依据所有成员都出现的有限原文主题线索生成，缺少线索时使用组件名称，不合并模型摘要或新增模型调用。公开类型允许 `release-family-v2`，历史读取同时兼容 `v1` 与 `v2`，已保存分组不重新命名。9月20日这项归组改动本身无需数据库迁移，不改变推荐权重或采集调度；不能将其与r8新增的28号读取索引混为一谈。

`publishedAt` 表达来源提供的发布时间语境，`publicationPrecision` 保留只有日期的情况；不以收录时刻补造新闻发生时间。`freshnessAt` 用于新鲜度判断，`contentVersion` 用于实质材料版本，`summaryFormatVersion` 用于摘要格式，两者不互相冒充。

列表批次保留 `asOf`，用于固定时间窗口和行为截止；配合不自动刷新正在阅读的结果，降低跳动。它不是数据库快照令牌，也不保证之后重新请求时数据库从未变化。真正历史内容固定依靠已保存的晨报快照。

r11 起当前精选按“期”提供，每期24小时不变。日版模式下，北京时间晨报时刻（默认06:00）之后 `latest` 直接返回当天已保存的晨报快照，之前返回前一天的；响应带 `nextRefreshAt`（下一期时刻），不再随请求重新选文，因此同一期内排序、摘要和截止时刻都不跳动。晨报任务仍在运行时，最多3小时内继续提供3天内最近一期保存版并标 `refreshPending`；没有可用保存版（采集关闭、失败或尚未运行）才回退为实时预览（`isSnapshot: false`）。前端在 `refreshPending` 时每60秒复查，否则在 `nextRefreshAt` 后2分钟复查、最长间隔6小时；不触发来源采集。卡片保留实际 `publicationPrecision`：有时分的材料不再一律隐藏为日期，只有日期的来源仍不补造时刻。旧公开投影未提供截止字段时明确显示缺失；历史版展示保存的截止字段，不重写快照。已保存的某一天再次请求时原样返回，不因新规则重排。

### 请求内访客兴趣

`shared\reader-interest-topics.json` 为前端、Node 网关与 Rust 提供同一组分类 ID。`visitor_interests.rs` 校验有限的 `id:weight` 参数，转为临时主题画像。PostgreSQL 使用 `NULL` 读者身份和该画像，不连接站主兴趣/反馈；事件过滤、评分、覆盖材料与详情 hydration 都传递同一边界，不只替换最后一个分数。

当前兴趣精选重用 `build_brief` 的资格、分组和版块限制，但不写入 `daily_briefs` 或 `daily_brief_items`。日版模式下它以站主当期晨报的截止时刻为边界选文，并按身份、截止时刻与兴趣画像在进程内缓存，同一期内不变；进程重启后重新计算，仍以同一截止时刻为界，但可能纳入其后才补齐的摘要。推荐列表在完整候选集上评分，分组后才分页；主题样本同样使用请求内画像。T1、周报及历史版不接受这个公开参数。MemoryStore 仅以合成分数覆盖演示行为，不冒充 PostgreSQL 的真实特征计算。

`public-interests.ts` 独立保存浏览器设置，采用明确保存、错误保留与跨页面冲突检测。`PublicReader` 将画像加入查询/工作区身份，应用后切换批次；其他页面的改动不会悄悄替换当前阅读。网关要求上游返回 `readerProfileApplied: true` 才接受兴趣响应，防止新 Web 配旧 API 时静默回到站主结果。

## 共用阅读组件

组件主要位于 `apps\web\src\components`：

| 组件 | 职责 |
| --- | --- |
| `ReaderShell`、`ReaderNavigation` | 共用页面外框、响应式导航与个人/公开标识 |
| `ReaderStory`、`ReaderRow` | 精选/周报条目和紧凑行的展示，不持有个人数据写权限 |
| `RadarControls`、`RadarFilterChips` | 列表 / 主题地图两种视图、公共筛选与当前条件提示 |
| `TopicWorkspace`，定义于 `TopicExplorer.tsx` | 共用图谱、匹配文章列表、分页与文章阅读；通过类型明确的数据源接入两种表面 |
| `EventPreviewPane`、`PublicArticlePane` | 个人/公开详情，各自注入允许的操作 |
| `useReadingWorkspace`、`useReaderDialog` | 阅读选择、返回上下文，以及窄屏焦点/背景隔离 |
| `SummaryContent`、`ReadingValue` | 区分紧凑要点、完整要点、来源摘录和阅读价值 |
| `PublicInterestDialog` / `public-interests.css` | 标题旁的访客兴趣编辑、可滚动内容、固定操作区与明确的保存/重置 |

公开数据类型定义于 `apps\web\src\public-reader.ts`，不强制转换成拥有全部个人字段的 `Event`。个人与公开查询使用隔离的缓存命名空间；个人状态更新必须覆盖单页和多页查询，不能修改公开浏览器偏好。

## 可信本地与旧隧道的信任边界

- 私有 API 面向可信的本地单用户。来源检查和 CORS 不是多用户认证/租户隔离，不能因此把 8080 暴露到公网。
- Gateway 的 `/v1/*` 需要 API 与 Gateway 共享的内部密钥；健康检查不代表任何访客有权调用模型。
- 可信本地账号通道不使用环境中的服务 token；Azure 独立使用 Key Vault 服务凭据，不读本机 keyring。两种模式精确模型不可用时均明确暂停，不使用自动模型选择或隐式备用账户。
- 摘要只使用传入并已保留的材料，不调用工具、不读取项目文件、不自行补抓原文。来源浏览器助手是单独的、有界采集流程。
- 公开网关采用请求、路由和字段允许列表，而不是把整个私有 API 透传。精确限制见 [公开阅读契约](PUBLIC-READER.md)。
- 备份含个人配置、偏好与材料；公开访客的浏览器存储不在站主数据库备份内。

## 修改时的不变量

不改写已应用 migration 或来源目录版本；用新的增量变更保留后续用户决策。UI 修正不重排队列、不更换模型、不修改来源配置和历史快照。旧匿名网关新增能力须同步其允许列表和字段投影；Azure 则须同步身份/所有权、事务 RLS、CSRF 与会话能力。只共用样式或组件不能证明两端权限相同，旧本地/隧道测试也不能证明 Azure 已验收。
