# 当前实现架构

适用版本：0.2；维护日期：2026-09-17。本文描述现有实现，不把 [V0 规格](V0-SPEC.md) 中的拟议模块、关系图或身份体系当作已经运行的服务。产品词汇见项目根目录 `CONTEXT.md`。

## 进程与职责

| 部分 | 入口 | 职责与边界 |
| --- | --- | --- |
| Web | `apps\web\src\main.tsx`、`App.tsx` | React、TypeScript、Fluent UI；个人路由与公开阅读入口按明确模式分开 |
| API / Worker | `services\api\src\main.rs`、`app.rs` | Axum API、来源采集、摘要队列、日程与选文；后台任务由同一 API 进程启动，不是另一个已部署 Worker 服务 |
| 数据库 | `services\api\migrations` | PostgreSQL；原始材料、来源配置、摘要、阅读状态、快照和任务持久化 |
| Copilot Gateway | `services\copilot-gateway\src\index.ts` | 通过 Copilot SDK 执行受约束的模型任务；不向公开访客提供代理模型接口 |
| 来源浏览器读取 | `services\source-access\browser-article.cjs`、`services\api\src\browser_articles.rs` | API 调用的受限原始博客读取助手，不是通用浏览器或持续运行的独立 HTTP 服务 |
| 公开阅读网关 | `services\public-reader\server.cjs` | Node 只读入口、静态生产页面与允许列表 API；仅访问 loopback 私有 API，不直接连接数据库或模型 |
| 本地进程管理 | `scripts\runtime-common.ps1` 与 `start/stop-*.ps1` | 注册并验证自己启动的进程、等待服务就绪、保存运行元数据；不按进程名称批量清理 |

默认端口与启动方式见 [运行与发布手册](OPERATIONS.md)。公开门户由 `start-public-reader.ps1` 启动；Rust 中另有 `SCOUTNEWS_PUBLIC_ONLY` 分享读取分支，不是这个 5190 门户，也不代表分享工作台已经接入当前隧道。

## 数据流

1. 来源配置决定可采集的具体入口；关注名单记录待核实或部分接通的对象，关注项不自动成为订阅。
2. `ingestion.rs` 及适配器请求公开材料，执行响应大小、公共地址、重定向、robots 与退避约束，保存原始身份和来源时间。
3. 规范化后的实质材料变化更新内容版本，并在数据库事务中创建或更新摘要任务。
4. `automation.rs` 领取持久化任务，经私有 API 的单请求锁和额度检查调用 Gateway；成功后保存要点、阅读标题、证据 ID 与真实处理信息。失败保留原有可读内容。
5. 阅读查询执行资格判断、排序、明确事件分组与分页；晨间快照另行保存，周报是滚动窗口回顾。
6. 个人浏览器通过私有 API 保存个人状态；公开浏览器通过只读投影获取材料，自己的反馈只写浏览器存储。访客兴趣也持久保存在浏览器，但选中主题会随 GET 请求发送，用于请求内排序。

打开文章、切换来源内容或刷新阅读页面不是采集任务，也不应顺带生成摘要。公开网关只读并不意味着运行中的个人后台停止自动调度，两者是不同职责。

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
| `daily_briefs`、`daily_brief_items.snapshot` | 保存版元数据、选文与当时内容 | 当前文章更新不能重写旧版选文、摘要和顺序 |
| `app_settings`、`morning_runs` | 已保存设置和每日任务记录 | 新库默认值不能覆盖既有模型、额度和日程 |
| `reader_shares` | 个人图文分享素材与草稿 | 导出素材不是自动发帖，也不是公开后台 |

数据库存在预留的知识关系结构，但当前主题图是阅读查询中的关键词共现结果，不是已经交付的完整持久化语义知识图谱。数据库 schema 与面向用户的能力不能画等号。

## 排序、分组与时间

编辑评分来自 `0022_editorial_article_policy.sql`；`0023` 更新付费预览材料边界，`0024_visitor_interest_profiles.sql` 增加 `reader_editorial_recommendations_for_profile`。原四参数 `reader_editorial_recommendations` 保留为等价包装器，仍供站主与晨报任务使用；未修改已应用 migration。

| 分量 | 当前权重 |
| --- | --- |
| 内容价值 | 30% |
| 来源与证据质量 | 25% |
| 显式兴趣 | 20% |
| 时效性 | 15% |
| 主动反馈 | 5% |
| 独立报道覆盖 | 5% |

其后仍有有界重复展示调整、明确排除和来源多样性/版块名额限制。`score` 排序的“来源与热点分”是另一口径，不是上述个人推荐分，也不是把七月拟议公式原样用于当前精选。

`reader.rs` 负责阅读编排、晨报/周报选择；`coverage.rs` 与 `coverage` 子目录负责明确关联的展示。只有精确事件引用或符合约束的同批次发布家族才合并展示；同品牌名和同主题不等于同一事件。详细例子与限制保留在根 `README.md` 的“推荐与重复展示”部分。

`coverage\release_family.rs` 的 `release-family-v2` 扩展到 SDK / CLI / SDK Provider：客户端成员必须有同仓库共同变更引用，组件身份包含类型，避免把 Node CLI 与 Node SDK 当作同一目标；语言别名又避免把 Node / TypeScript SDK 的连续版本混为不同组件。插件家族不与客户端家族混合。官方身份、标签/标题对应、精确发布时间、24小时总跨度与组内共同变更交集仍是边界。

发布家族先以来源时间倒序及事件 ID 建立确定性批次，再由列表排序选择组内主条目；同一候选集合不因兴趣或排序改变组成员。标题依据所有成员都出现的有限原文主题线索生成，缺少线索时使用组件名称，不合并模型摘要或新增模型调用。公开类型允许 `release-family-v2`，历史读取同时兼容 `v1` 与 `v2`，已保存分组不重新命名。本次无需数据库迁移，不改变推荐权重或采集调度。

`publishedAt` 表达来源提供的发布时间语境，`publicationPrecision` 保留只有日期的情况；不以收录时刻补造新闻发生时间。`freshnessAt` 用于新鲜度判断，`contentVersion` 用于实质材料版本，`summaryFormatVersion` 用于摘要格式，两者不互相冒充。

列表批次保留 `asOf`，用于固定时间窗口和行为截止；配合不自动刷新正在阅读的结果，降低跳动。它不是数据库快照令牌，也不保证之后重新请求时数据库从未变化。真正历史内容固定依靠已保存的晨报快照。

### 请求内访客兴趣

`shared\reader-interest-topics.json` 为前端、Node 网关与 Rust 提供同一组分类 ID。`visitor_interests.rs` 校验有限的 `id:weight` 参数，转为临时主题画像。PostgreSQL 使用 `NULL` 读者身份和该画像，不连接站主兴趣/反馈；事件过滤、评分、覆盖材料与详情 hydration 都传递同一边界，不只替换最后一个分数。

当前兴趣精选重用 `build_brief` 的资格、分组和版块限制，但不写入 `daily_briefs` 或 `daily_brief_items`。推荐列表在完整候选集上评分，分组后才分页；主题样本同样使用请求内画像。T1、周报及历史版不接受这个公开参数。MemoryStore 仅以合成分数覆盖演示行为，不冒充 PostgreSQL 的真实特征计算。

`public-interests.ts` 独立保存浏览器设置，采用明确保存、错误保留与跨页面冲突检测。`PublicReader` 将画像加入查询/工作区身份，应用后切换批次；其他页面的改动不会悄悄替换当前阅读。网关要求上游返回 `readerProfileApplied: true` 才接受兴趣响应，防止新 Web 配旧 API 时静默回到站主结果。

## 共用阅读组件

组件主要位于 `apps\web\src\components`：

| 组件 | 职责 |
| --- | --- |
| `ReaderShell`、`ReaderNavigation` | 共用页面外框、响应式导航与个人/公开标识 |
| `ReaderStory`、`ReaderRow` | 摘要卡片和紧凑行的展示，不持有个人数据写权限 |
| `RadarControls`、`RadarFilterChips` | 三种视图、公共筛选与当前条件提示 |
| `TopicWorkspace`，定义于 `TopicExplorer.tsx` | 共用图谱、匹配文章列表、分页与文章阅读；通过类型明确的数据源接入两种表面 |
| `EventPreviewPane`、`PublicArticlePane` | 个人/公开详情，各自注入允许的操作 |
| `useReadingWorkspace`、`useReaderDialog` | 阅读选择、返回上下文，以及窄屏焦点/背景隔离 |
| `SummaryContent`、`ReadingValue` | 区分紧凑要点、完整要点、来源摘录和阅读价值 |
| `PublicInterestDialog` / `public-interests.css` | 标题旁的访客兴趣编辑、可滚动内容、固定操作区与明确的保存/重置 |

公开数据类型定义于 `apps\web\src\public-reader.ts`，不强制转换成拥有全部个人字段的 `Event`。个人与公开查询使用隔离的缓存命名空间；个人状态更新必须覆盖单页和多页查询，不能修改公开浏览器偏好。

## 信任边界

- 私有 API 面向可信的本地单用户。来源检查和 CORS 不是多用户认证/租户隔离，不能因此把 8080 暴露到公网。
- Gateway 的 `/v1/*` 需要 API 与 Gateway 共享的内部密钥；健康检查不代表任何访客有权调用模型。
- 默认本机账号通道不使用环境中的服务 token。精确模型不可用时明确暂停，不使用自动模型选择或隐式备用账户。
- 摘要只使用传入并已保留的材料，不调用工具、不读取项目文件、不自行补抓原文。来源浏览器助手是单独的、有界采集流程。
- 公开网关采用请求、路由和字段允许列表，而不是把整个私有 API 透传。精确限制见 [公开阅读契约](PUBLIC-READER.md)。
- 备份含个人配置、偏好与材料；公开访客的浏览器存储不在站主数据库备份内。

## 修改时的不变量

不改写已应用 migration 或来源目录版本；用新的增量变更保留后续用户决策。UI 修正不重排队列、不更换模型、不修改来源配置和历史快照。任何新公开能力同时更新客户端类型、网关允许列表、字段投影、两端行为与对应证据；只共用样式或组件不能证明能力相同。
