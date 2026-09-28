# 测试与证据指南

适用版本：0.2；维护日期：2026-09-28。只使用项目已有 TypeScript、Vite、Rust 和 Playwright 工具。文档修改不需要构建应用或运行真实采集；代码变更选择覆盖该行为的最小范围。

## 1. 选择正确的证据

| 方式 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| TypeScript / Rust 定向检查 | 类型、实现和局部规则契约 | 页面视觉质量、真实来源可访问性 |
| API 替身契约 | 参数、字段投影、错误/缓存/限额边界 | 真实已取得来源内容 |
| 浏览器页面替身 | 同内容两端交互、响应式、焦点、加载/失败 | 真实 API 与数据库链路或来源质量 |
| 隔离数据库 + 真实 Feed/语料 | 实际持久化、阅读、选文与数据路径 | 所有平台接通、长期稳定或最优推荐权重 |
| 只读候选截图 | 实际材料在当前构建中的呈现 | 站外入口已经发布、所有交互都可用 |
| 实际 Dev Tunnel 截图/请求 | 公开地址的构建、只读边界和渲染 | 永久在线、多用户权限或无障碍认证 |
| 独立 UI Critic | 已查看范围内的可执行视觉/UX 判断 | 自动修复、人工设计师批准、完整质量认证 |

不得把合成材料叫作真实新闻，不得以 mock 成功替代原站失败，不得把一次综合运行中通过的个别案例写成整个运行通过。

## 2. 依赖与构建准备

先使用已有依赖；只在新 checkout 或缺依赖时安装。项目专用 Node 可通过已有 helper 放入当前终端 PATH：

```powershell
. .\scripts\runtime-common.ps1
Initialize-ScoutNewsNode
npm.cmd run typecheck --workspace '@scoutnews/web'
npm.cmd run build --workspace '@scoutnews/web'
```

Gateway 变更使用其 workspace 的 `typecheck/build`。Rust 定向用例通过 `.\scripts\rust.ps1 -CargoArgs @('test', '<匹配的现有测试名>')` 运行；实际使用前用源码确认过滤名，不能以零个匹配用例当成功。

正在运行的 Windows API 可执行文件可能被锁定。需要候选 API 时使用独立 target 目录构建，再将其绝对路径交给隔离启动器；不要为了测试替换日常服务的运行中程序。

## 3. 不接触日常数据的 UI 回归

用于 CSS、组件和公开/个人交互；**只运行明确设置了 API 拦截的 spec**，不能把 `MOCK_ONLY=true` 当成任意测试文件都安全的总开关。

终端 A，在 Web 构建完成后：

```powershell
. .\scripts\runtime-common.ps1
Initialize-ScoutNewsNode
Assert-ScoutNewsPortsFree @(15173)
npm.cmd exec --workspace '@scoutnews/web' -- vite preview --host 127.0.0.1 --port 15173 --strictPort
```

终端 B，先确认服务就绪：

```powershell
. .\scripts\runtime-common.ps1
Initialize-ScoutNewsNode
Invoke-WebRequest 'http://127.0.0.1:15173/' -UseBasicParsing
$env:SCOUTNEWS_E2E_BASE_URL = 'http://127.0.0.1:15173'
$env:SCOUTNEWS_E2E_MOCK_ONLY = 'true'
npm.cmd run test:e2e -- editorial-reader.spec.ts public-reading-ui.spec.ts --reporter=dot
```

宽度/焦点变更可先定向运行：

```powershell
npm.cmd run test:e2e -- editorial-reader.spec.ts --grep 'reading text uses the available column|form controls keep one focus treatment|select focus remains visible|grouped cards|wide card pending' --reporter=dot
```

这些用例对个人与公开 API 使用请求替身，覆盖长标题/要点、1280/1440/1920/2560/390、展开阅读价值、无操作分组、保存中/失败包含关系、实际键盘选择与 forced-colors。相关用例使用同一 runner 时合并选择器；只有出现跨区域影响才扩大范围。

验证后停止自己启动的 preview，并在测试终端执行 `Remove-Item -LiteralPath Env:\SCOUTNEWS_E2E_MOCK_ONLY -ErrorAction SilentlyContinue` 清除本次模式标记。preview 与真实 E2E 共用 15173，不能同时运行；不要按 `node` 名称批量杀进程。

云端会话激活先在 15173 的生产构建上运行 `cloud-session.spec.ts`。真实离开/返回必须依次模拟 `hidden`、`visibilitychange`、window `blur`、`visible`、`visibilitychange`、window `focus`；只在仍为 visible 时派发一个 `visibilitychange` 不代表用户切换了窗口。断言既要检查已验证页面、草稿和打开的弹窗没有被替换，也要检查 `data-session-validation="pending"` 已阻止新的私有请求；账号改变、401 和邀请撤销则必须重载并清除旧账号内容。

`cloud-workflows.spec.ts` 另有写入防护，固定使用 15175 和 mock-only：

```powershell
# 另一个终端从 apps\web 启动构建产物
npm.cmd exec -- vite preview --host 127.0.0.1 --port 15175 --strictPort

$env:SCOUTNEWS_E2E_BASE_URL = 'http://127.0.0.1:15175'
$env:SCOUTNEWS_E2E_MOCK_ONLY = 'true'
npm.cmd run test:e2e -- cloud-workflows.spec.ts --reporter=dot
```

该文件拒绝其他 base URL 或未设置 mock-only 的运行；不要删掉这一护栏来复用 15173。

## 4. 公开网关 API 契约

```powershell
npm.cmd run test:e2e -- public-reading-api.spec.ts --reporter=dot
```

该 spec 启动自己的临时 loopback 上游和网关，使用明确的测试数据与临时页面，不需要站主数据库或 Copilot 账号。主要覆盖严格筛选、真实存档约束、分页边界、只读方法、字段裁剪、失败投影、缓存和资源限制。

访客兴趣的浏览器与网关定向范围可合并运行：

```powershell
npm.cmd run test:e2e -- public-reading-api.spec.ts public-reading-ui.spec.ts --grep 'visitor interests' --reporter=dot
```

UI 用例仍要求上一节的 preview 和显式 API 拦截环境。覆盖独立浏览器、重新载入、取消/清空、存储拒绝/损坏、跨页草稿冲突、相同时间锚点下的在途旧分页、主题数据源一致性、320–1280px 对话框与焦点。代理替身确认严格参数、缓存隔离、只读、存档拒绝兴趣及旧上游未确认画像时失败，而非假装验证真实排名。

`public-reader.spec.ts` 则包含真实隔离 API/语料路径，不能因为名字相似就直接对日常服务器运行。

## 5. 真实来源与数据库隔离

```powershell
Remove-Item -LiteralPath Env:\SCOUTNEWS_E2E_MOCK_ONLY -ErrorAction SilentlyContinue
npm.cmd run test:e2e:live
```

现有脚本 `scripts\test-e2e-live.ps1` 使用 15173/18080/18787/55432，新建 `scoutnews_e2e_<UUID>` 数据库，并在结束时只清理本次拥有的进程与数据库。首次使用会按脚本下载项目 PostgreSQL 二进制；不要同时开两个隔离启动器。

脚本设置 `SCOUTNEWS_DISABLE_COPILOT_RESTORE=true`，API/Gateway 的本机账号通道被禁用；不会恢复站主 Copilot 登录、读取其凭据或消费测试模型额度。来源 Feed 请求仍是真实网络访问，失败应报告为失败并尊重退避。

从真实备份回放时：

```powershell
.\scripts\test-e2e-live.ps1 -SkipBuild `
  -ApiExecutable 'D:\absolute\candidate\scoutnews-api.exe' `
  -DatabaseBackup 'D:\absolute\backup\scoutnews.dump' `
  -TestPattern 'public reader beta offers genuine reading|public Radar matches genuine'
```

替换为实际存在的本机绝对路径，并确保已清除前述 `SCOUTNEWS_E2E_MOCK_ONLY` 标记。`-ApiExecutable` 必须和 `-SkipBuild` 一起使用；此时还要求已有 Web/Gateway 构建。`-DatabaseBackup` 只恢复到本次新库，不覆盖 55433 的日常数据。

真实语料可能包含配置与个人状态，因此仅在本机受控环境使用备份，不发给同事或第三方。测试返回示例标题不是用户数据导出的许可。

## 6. 哪些文件覆盖哪些行为

| 范围 | 主要现有用例 |
| --- | --- |
| 阅读布局、层级、Radar 视图、焦点、长文字 | `editorial-reader.spec.ts` |
| 云端初载、窗口激活、请求闸门、账号切换和恢复焦点 | `cloud-session.spec.ts`；写工作流与旧账号在途响应使用 mock-only 的 `cloud-workflows.spec.ts` |
| 真实截止窗口、来源日期精度、固定批次与手动更新 | `editorial-reader.spec.ts`；Rust的 `reader::tests` |
| 延迟确认、跨控件防重、失败重试和撤销提示 | `feedback-performance.spec.ts`，必须显式mock-only |
| 受限数据库批量读取、候选范围、首读和隔离 | `services\api\tests\cloud_contract\reader_performance_regressions.rs`，通过 `run-cloud-isolation.ps1` |
| 放弃读取的取消传播、正常读取及写操作不被误取消 | `services\cloud-host\test\app.test.mjs` |
| 公开 T1、历史、浏览器状态、分页竞态与恢复 | `public-reading-ui.spec.ts` |
| 公共参数、字段投影与失败边界 | `public-reading-api.spec.ts`、`editorial-public.spec.ts` |
| 请求内兴趣、站主隔离、全体候选排序与真实候选截图 | `visitor-interests-live.spec.ts`；Rust 的 `visitor_` 过滤范围 |
| 真实公开读取与个人/公开排序/图谱比较 | `public-reader.spec.ts` |
| 选文、分类、推荐与真实语料回放 | `editorial-policy.spec.ts`、`editorial-corpus.spec.ts`、`reader-classification.spec.ts` |
| 事件分组与发布家族 | `coverage-bundles.spec.ts`、`release-families.spec.ts` |
| 原始材料、博客浏览器、评论契约、X 预览 | `reading-context.spec.ts`、`browser-articles.spec.ts`、`reddit-comments.spec.ts`、`reading-comment-contract.spec.ts`、`x-public-preview.spec.ts` |
| 真实采集、目录、摘要队列与日程 | `real-ingestion.spec.ts`、`source-directory.spec.ts`、`summary-queue.spec.ts`、`z-morning-reader.spec.ts` |

文件目录不等于运行要求相同。执行前读对应 fixture 和隔离检查，涉及数据库的用例必须走隔离启动器。

访客兴趣的真实链路使用 `-TestPattern 'visitor SQL|visitor retained-corpus'`，并提供实际候选 EXE 与受控备份。原评分包装器与旧 SQL 在事务内逐项比较；130 条明确标为合成的隔离材料验证分组、分页、100 条主题样本、20% 兴趣分量和站主状态隔离，结束后清理。之后的截图只使用恢复的真实材料，不把这些合成材料发布或冒充新闻。截图子过程的浏览器只有公开 GET 权限。

组件发布分组使用 Rust 的 `coverage::tests` 与隔离启动器的 `-TestPattern 'component release groups'`。`release-families.spec.ts` 不再依赖实时 RSS 永远保留某几个旧版本：第一项创建明确标为合成的九条组件材料，覆盖三个分组、CLI/SDK/Provider 身份、过滤、分页、访客读取和独立隐藏/撤销，结束后清理；第二项只读恢复语料中的2026年9月18日实际版本，并采集1440/1024/768/390的列表布局（r10 已移除卡片视图，旧记录中的卡片截图不再生成）。

真实语料截图需要 `-DatabaseBackup`，且备份必须确实包含该批 Mem0 发布；没有对应版本应更新回放语料，而不是在线补抓或伪造为真实新闻。合成截图以 `synthetic-` 命名，真实恢复材料以 `retained-` 命名。Rust 反例覆盖非官方/fork、不同项目或改动、错误标签、同组件连续版本、日期精度、24小时跨度、无引用桥接、排序变化下批次稳定，以及旧 `v1` 快照标题不被改写。

## 7. 截图、比较与结果保留

完整流程见 [UI 设计与独立评审](UI-DESIGN.md)，候选启动见 [运行与发布手册](OPERATIONS.md)。

`npm run ui:review` 只接受 loopback 只读公开网关或 HTTPS Dev Tunnel；Vite preview 不提供所需的 `readOnly` 健康契约。采集阻止个人 API 和非读取请求，失败/空/加载模拟只发生在浏览器，不改变服务器。

输出必须是 `tmp\ui-reviews` 的新命名目录。保存 `review.json`、截图和相应命令/结果范围；宽度修正要比较实际内容列宽度和操作位置，能力变更要比较两端模式、筛选、排序、分页、主题及返回。

Playwright 配置为单 worker、零自动重试，失败保留 trace 和截图。`tmp\playwright-report`、默认结果目录可能被后续运行替换，需要保留发布证据时使用命名的 `--output` 路径并另存必要结果。`.last-run.json` 只说明该次状态，不包含全部人工验收信息。

遇到环境级失败先读 trace/console。2026-09-16 曾出现浏览器 `ERR_NO_BUFFER_SPACE` 导致动态模块失败：记录失败，随后定向及相关范围重新运行；没有因此修改产品分页逻辑或增加上游超时。一次重新运行成功不自动删除先前失败证据。

## 8. 2026-09-16 宽度/焦点交付记录

| 证据 | 范围 |
| --- | --- |
| `tmp\e2e-reader-width-focus-final` | 两份受影响 UI spec，共 96 个用例通过 |
| `tmp\e2e-reader-width-focus-specificity` | 最后一处选择器特异性修正后，10 个相关用例通过；与前一项有重叠 |
| `tmp\ui-reviews\reader-width-focus-before` | 修正前实际材料，24 条捕获记录 |
| `tmp\ui-reviews\reader-width-focus-final` | 最终候选，24 条捕获记录 |
| `tmp\ui-reviews\reader-width-focus-published` | 真实 HTTPS 入口，24 条捕获记录，宽度与焦点和候选一致 |

独立 Critic 接受的是本次宽度/焦点范围，没有以此授予所有历史功能或连续 14 天质量验收。相关文件位于忽略目录，可能只存在于维护者机器；新 checkout 应按指南重新获得证据，而不是假定文件随仓库分发。

发布时还应保留对应构建标识及个人数据不变量的前后比对范围。不要为“复现”这次记录而修改保存模型、5000 次既有额度、06:00 日程、来源决定、个人状态或历史快照。

## 9. 2026-09-17 访客兴趣交付记录

| 证据 | 范围与结论 |
| --- | --- |
| 受影响范围回归 | 三份 reader/gateway spec 共 174 个用例通过；不等于全库测试 |
| SQL 与隔离语料 | 3 项通过：旧站主 SQL 等价、130 条合成材料的全体候选/分组/分页/主题样本与状态隔离、真实恢复语料截图 |
| UI 评审修正 | 复选框、焦点和关闭目标修正后，4 个网关、18 个 UI 及一次真实截图共 23 项通过；最后错误可见性修改另有 2 项通过，范围有重叠 |
| Rust 请求与演示行为 | 4 个 `visitor_` 用例通过，包括全局分相同时保留发布时间次序 |
| 最终默认/兴趣网关投影 | 20 个相关用例通过，包含保存版与共享文案边界；与前述覆盖重叠 |
| 独立评审的最终候选 | `tmp\ui-reviews\visitor-interests-candidate-ab27e53c-0c8e-43e5-ae2b-77527d74e028`，28 个状态 |
| 实际 HTTPS 发布 | `tmp\ui-reviews\visitor-interests-published-00af8a79`，28 个状态；外网入口资源与候选字节匹配，两种真实兴趣得到不同推荐次序 |

VI-01、VI-02、VI-03 经独立复查标为已解决；评审结论仅针对该范围和关联的错误可见性，不是完整无障碍认证。实际入口的中间宽度、深色滚动/焦点与错误呈现也已查看；没有仅凭模拟 API 成功推断公开部署完成。

发布保护材料在 `tmp\release-candidates\visitor-interests-20260917-d9b6669cc21b4cf3b0185e3c2fb181ed`：包括冻结的 Web、原 API 与数据库备份、前后数据哈希、外网观察和最终运行记录。最终 API 的演示并列规则补充不改变 PostgreSQL 或已评审的 Web 资源。七类保护数据逐项一致：147 条 `daily_brief_items`、10 条 `daily_briefs`、64 个来源、65 个关注项、4 项设置、1 份站主兴趣和 422 条个人状态；新增 migration 为 24。

备份仍属于本机受控材料，不随站点公开，也不能因报告需要而向同事发送。当前服务会话与这些历史证据分开管理，仍以运行时元数据为准。

## 10. 2026-09-20 组件分组交付记录

| 证据 | 范围与结论 |
| --- | --- |
| Rust 分组范围 | `coverage::tests` 26项通过，包含新客户端家族、确定性批次与旧快照兼容 |
| 隔离 PostgreSQL / UI | `component release groups` 2项通过；九条明确合成的材料验证行为，真实恢复材料验证五组件与响应式呈现 |
| 移动操作补充 | 真实语料用例另跑1项，确认390宽度两种视图的最后一个组件详情按钮可接收指针；与前项重叠，不计为第三个独立用例 |
| 独立视觉评审 | 实际查看紧凑/卡片在1440/1024/768/390的8张真实恢复材料截图，限定范围接受，无需修正的P0/P1/P2；不是全站或无障碍认证 |
| 发布后 HTTPS | 三个 `v2` 分组与本地一致，客户端五项齐全；另采集8张真实公网页面，无非读取或私有API请求 |
| 数据保留 | 七类保护数据的数量与哈希发布前后一致；177条快照材料、13期保存版、64来源、65关注项、4设置、1兴趣画像、530条个人状态；没有新迁移 |

首次隔离运行中，真实页面用例错误地要求公共紧凑行使用 `h2`，实际组件使用 `h3`，因此断言失败。修正的是测试定位，未把它包装为产品空白页修复；首次证据保存在候选的 `e2e-first-attempt`。

候选与发布记录位于 `tmp\release-candidates\component-groups-20260920-2cf20d96888745d680db4a36ce1d0298`。独立接受的截图在 `e2e-final`，实际 HTTPS 截图及请求边界记录在 `published-ui`，最终运行/API哈希与保留数据见 `completed-release.json`。这些路径仅用于维护者定位受控证据，不是新 clone 中应存在的文件。

首次独立 GitHub 分发还从 Git 索引导出源码，并用该副本的 `Cargo.toml` 完成 `cargo check --locked`；不能只凭维护者目录能构建，就认为忽略规则没有漏掉源文件。测试覆盖率输出仅忽略报告位置，不能误排除 Rust 的 `src/coverage` 模块。24份迁移的索引内容与工作文件逐字节一致。

## 11. 2026-09-20 CoDesign 阅读改版

设计基线与哈希见 [工程映射](design/CODESIGN-MAPPING.md)。原型在隔离浏览器中渲染为1440/1024/768/390四种宽度的六类阅读场景，不把演示内容接到真实接口。

| 证据 | 范围与结论 |
| --- | --- |
| `tmp\codesign-reader-20260920\reader-final-results.json` | 共享阅读87项通过：任务预设、两端三视图、真实主题成员、分组/历史、宽度、焦点、更新、抽屉、加载与失败等 |
| `tmp\codesign-reader-20260920\public-final-results.json` | 公开阅读39项通过：访客兴趣、缓存/分页/跨页隔离、历史、首篇与已打开状态、返回焦点及1024边界 |
| `tmp\codesign-reader-20260920\final-reading` | 同内容的个人/公开四宽度阅读对照及1280/1440/1920/2560/390长文本范围 |
| `tmp\ui-reviews\codesign-reading-live-20260920-r1` | 真实已收录材料候选的84个状态；其中加载/失败/空结果模拟有明确标记，没有私有或非读取请求 |
| `tmp\codesign-reader-20260920\visual-review.json` | 独立 Critic 分别接受受控阅读和真实材料范围；管理、破坏性管理操作及完整CoDesign暗色均未授予接受 |
| `tmp\ui-reviews\codesign-reading-published-20260920` | 实际HTTPS入口84个状态，JS/CSS与候选字节一致；无页面错误、禁止请求或横向溢出，窄屏抽屉五入口及首篇均有真实呈现 |
| 构建与切换 | 41份生产分发文件与候选逐字节相同；新不可变网关会话，个人运行元数据保持相同 |

两份UI文件共126个独立用例，定向复跑不累加。没有据此声称全库后端回归、真实采集或模型调用已重新执行；本轮未修改这些行为。已有依赖、构建与Playwright工具继续复用，没有为UI另加测试框架。

迁移旧用例时保留了业务断言：深读未打开时首篇在主条目中，列表含其余39项，不能把它误判为丢了一篇；阅读时完整队列仍包含活动文章。周报先选主题，不再对初始空选择误报数据丢失；选择后继续检查原始成员顺序。导航目标与触摸尺寸检查移到抽屉，不因新布局删去可达性要求。

完成记录为 `tmp\codesign-reader-20260920\completed-release.json`；当前公开会话为 `a7af09f772784e6c848381266ecc837a`。本轮没有重启个人服务、运行数据库迁移、修改来源/模型配置或执行Git提交/推送。

## 12. 2026-09-22 新鲜度与性能证据

以下是r8代码与候选证据；是否已部署、实际revision、线上耗时和采样时间统一见 [Azure手册第1节](AZURE-PREVIEW.md#1-带日期的-rollout-状态)，不以隔离测试替代线上测量。

| 证据 | 范围与边界 |
| --- | --- |
| `tmp\freshness-r8-20260922\playwright` | 合成API材料的1440/390窗口截止、混合日期精度、保持批次/手动更新和历史响应字段；不冒充当天真实新闻 |
| `tmp\ui-reviews\freshness-r8-20260922\critic.json` | 独立接受已查看的浅色截止/时间范围；非全站、完整暗色或无障碍认证 |
| `tmp\ui-reviews\feedback-performance-20260922\integration-after` | 4项反馈用例通过，包含撤销提示仍可见时从阅读器撤销的真实崩溃回归；初次失败trace保留 |
| `tmp\ui-reviews\feedback-performance-20260922\integration-reader-identity` | 8项相关阅读/身份用例通过；与其他范围有重叠，不合并成独立总数 |
| `tmp\performance-r8\after\startup-pool-validation.log` | 独立PG17/55489、UUID库、2400条合成事件及60条活动材料；角色/状态隔离、分页、覆盖和历史快照契约；不是云端性能SLA |
| `tmp\performance-r8\after\coverage-review-regressions-before.log` / `coverage-review-regressions-after.log` | 独立复审发现后，先复现再修复“不感兴趣材料从详情/精选关联中重现”和“三版本重叠时详情重新分组”；覆盖另一账号、访客、明确读取已隐藏条目，以及25小时/2小时/1分钟三个版本的列表/详情成员一致性。修正后同一隔离契约通过；有问题的ck8候选未发布 |
| 实际生产初始化函数的首读 | 迁移/目录导入连接池关闭后建立新runtime pool；该轮首批50条385ms，门槛5000ms；同轮旧连接路径18809ms。仅证明该连接生命周期处理在本用例有效，不据此断言某个PostgreSQL内部缓存缺陷 |
| `tmp\performance-r8\after\runtime-pool-repeat-validation.log` | 修正关联后再次使用实际生产初始化函数：首读341ms，同一runtime pool连续8次读取205–279ms，每次均要求低于5000ms且条目顺序相同；不只验证一个新连接的第一次请求 |
| 定向Rust与宿主用例 | 最后 `reader::tests` 16项通过；宿主11项相关契约覆盖弃读取消、正常响应与已转发PUT语义 |

`run-cloud-isolation.ps1` 使用独立目标目录 `tmp\performance-r8\target`，不覆盖日常运行中的EXE；结束后恢复原 `CARGO_TARGET_DIR` 并停止本次实例、清理自己创建的数据目录。不要并行运行占用同一固定测试端口的实例，也不要删除整个 `tmp` 或有用编译缓存。

性能记录必须区分四种口径：前门真实浏览器请求、容器内可信维护身份的Node GET、受限角色SQL执行计划、隔离合成数据。5秒与1.9ms的查询计划比较是SQL候选范围变化，不能写成“收藏端到端只需2ms”；维护GET不包含外网和EasyAuth，也不是用户亲自点击。GET探针不写收藏、不触发采集/模型，但认证可能更新账号的 `last_seen_at`。

发布后除复用旧基线的四条路由，还必须按实际UI参数补测：Radar包含 `coverage=true`、40条、24/72小时、真实排序和固定 `asOf`；主题图传对应窗口与空搜索，主题结果为24条并启用分组。`r8-reader-routes-ui-after.json` 记录20:31的7次200响应，列表/地图/主题结果约1.50–1.69秒，详情0.112秒，精选2.84秒。裸 `/explore` 的全历史19.06秒仍单独记录为慢路径，不能换成轻查询后声称同一路径已经优化。

发布保护比较已保存的应用设置和历史快照，不要求正常摘要Worker处理的所有动态表都保持不变。数据库新增28只是索引，旧1–27迁移仍保持原字节；旧镜像是否能启动还受迁移集合校验约束，按Azure手册的兼容性边界处理。

## 13. 2026-09-23 来源缺口定向回归

Anthropic News 用例覆盖根路径公告、旧 `/news/` 卡片指纹、日期/RFC3339 时间精度、导航/站外/凭据/编码路径排除，以及有效旧卡片与异常新卡片共存时不得报告成功。超过200条不静默截断。测试只将来源索引短摘录作为材料，不声称取得文章全文。

在不触碰工作中分组修改的独立源码回放目录中，r8生产解析器加新用例实际复现5项失败；更换为修复解析器后14项相关单元用例通过，另外保存页回放与真实 `FeedAdapter` 各返回13项并包含官方 Opus 5.5 公告，发布时间仍为2026-09-22、精度为 `day`。原10项的指纹契约保留。这些是解析/有界GET证据，不是数据库补采或云端发布证明。

证据在 `tmp\source-fixes-r9\anthropic-before.log`、`anthropic-after-compiled.log` 与 `anthropic-index-replay-live.log`。中间的 `anthropic-after.log` 使用了旧缓存可执行文件，不计为修复代码的结果：`Copy-Item` 保留旧mtime时，Cargo可能不重编译。回放在源码哈希一致且更新时间后重新编译；不能只根据复制文件或一次命令退出判断执行了目标字节。

包家族新增9项回归，覆盖真实 LangGraph 核心/SDK 组合、组件与标签版本对应、一次安全解码、同仓库共同改动、非官方/日期/混合证据拒绝、与旧家族隔离、连续版本/同时间稳定性、24小时总跨度/非链式扩张及历史捕获材料不改写。

两项修复回到主源码后，先前的 `integrated-unit.log` 仍复用了回放目录缓存，缺少9项新测试，不能计为集成通过。仅清理独立target中的 `scoutnews-api` 包产物、保留依赖后，`integrated-unit-rebuilt.log` 明确重新编译主项目并执行全部9个新名称：组合过滤共49项通过、3项需显式选择的用例跳过。`cloud-isolation.log` 随后在同一178项测试可执行文件中通过 `cloud_tests`、来源目录与晨报三个隔离PG契约；隐藏材料、访客隔离、列表/详情批次、分页及历史快照保护继续生效，未接触日常数据库。

正常定向用例可合并在同一个Rust测试进程，使用已有独立target，不覆盖日常API：

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location).Path 'tmp\performance-r8\target'
.\scripts\rust.ps1 -CargoArgs @('test','--locked','--bin','scoutnews-api','--','coverage::','anthropic_','--test-threads=1')
```

News真实来源回放必须显式选择，不因普通单元测试而访问上游。快照路径是维护者保存的当日公开索引，预期URL是当日实际在索引中的公告；新clone不自带这些运行材料：

```powershell
$env:SCOUTNEWS_ANTHROPIC_NEWS_SNAPSHOT = (Resolve-Path '.\tmp\source-diagnosis-20260923\anthropic-news.html').Path
$env:SCOUTNEWS_ANTHROPIC_EXPECTED_NEWS_URL = 'https://www.anthropic.com/claude-opus-5-5'
.\scripts\rust.ps1 -CargoArgs @('test','--locked','--bin','scoutnews-api','--','--ignored','anthropic_news_saved_index_contract','anthropic_news_live_index_contract','--test-threads=1','--nocapture')
```

保存页回放不联网；live用例先遵守robots，再通过原有有界适配器读取News索引，不访问数据库或调用模型。官网只提供日期时不伪造精确发布时间，也不把补采时间用于通过严格24小时筛选。

### r9实际交接与证据边界

ACR `cka` 与Ready `newsscout--0000006` 的实际发布记录见Azure手册。17:12的 `tmp\source-fixes-r9\complete-evidence.json` 确认仅一个Anthropic News任务完成，新增3、更新0；官方Opus 5.5保留9月22日的`day`精度，在72小时可见、严格24小时不可见。LangGraph两条真实材料的列表/各自详情为同一双成员发布组，不以合成用例替代实际数据结果。

`preservation.json` 比较发布前、补采前及补采后的全部保护字段，而不只比较采集前后；获批读者作用域的3份晨报/21项快照、设置、兴趣、阅读状态和可见来源配置均一致。本轮维护GET不写收藏/打开，单源POST使用原批准身份、真实会话CSRF与精确Origin；仍不等于真人浏览器采集交互验收。

独立复审的唯一运维发现是“先POST再写回执”会造成重试重复提交，已修为POST前排他保存意图、已知job只恢复观察、未知结果停止及保留完成回执。`receipt-replay.log` 用Node内置断言及纯内存替身覆盖成功重入、丢失响应和后续核对失败恢复，没有网络/数据库调用；`review-r9.json` 记录独立关闭。exec最后分块的429仅做退避和前缀哈希续传，没有重跑采集。

## 14. r10 CoDesign 1:1重构与前端性能（2026-09-24）

设计版本、有意差异与深色取值见 [工程映射](design/CODESIGN-MAPPING.md) §8；实际发布与线上测量见 [Azure手册第1节](AZURE-PREVIEW.md#1-带日期的-rollout-状态)。证据目录为 `tmp\ux-refactor-r10`，不随仓库分发。本轮没有修改后端、迁移或Gateway，因此没有重跑Rust用例。

| 证据 | 范围与结论 |
| --- | --- |
| mock集 | 172项通过：`editorial-reader`、`public-reading-ui`、`cloud-session` 三个文件，覆盖共享阅读、公开阅读与云端登录会话 |
| mock-only `cloud-workflows` / `feedback-performance` | `SCOUTNEWS_E2E_MOCK_ONLY` 下分别14项、4项通过 |
| 语料栈 | 104项通过、31项失败：18项是只允许全新隔离库的保护性拒绝，13项与环境或数据状态相关 |
| 语料专用用例 | 4项通过、2项失败：保留语料中该事件最长的已存阅读上下文只有226字符（期望>600）；Mem0发布家族已超出72小时窗口。`verify-family\report.json` 改用168小时复核，公开与站主视图均呈现5成员家族，1440/1024/768/390无溢出、无页面错误 |
| 新库live（16个文件，workers=1，21分钟） | 50项通过、12项失败，归因见下表 |
| 官方runner补跑Gateway用例 | `test-e2e-live.ps1 -SkipBuild -TestPattern` 2项通过 |
| `theme\after3` | 13个页面状态 × 390/1280 × 明暗两种主题，每种主题909个文本元素：深色0项低于4.5:1；浅色严格沿用演示取值，保留的低对比度见 [映射§8.4](design/CODESIGN-MAPPING.md#84-有意保留的差异)；开关圆钮/轨道均高于3:1 |
| `critic\` | 独立UI评审三轮，最终接受 |
| `latency\` | 请求瀑布、渲染间隔、云端冷启动及App Insights路由耗时 |

新库live的12项失败：

| 用例 | 现象 | 归因 |
| --- | --- | --- |
| `real-ingestion` | 全量真实采集270秒超时 | 真实网络 |
| `source-coverage`、`source-directory` L16、`z-morning-reader` L72 | 缺 `lastSuccessAt`、计数为0、晨报只有1条 | 上一项采集未完成的连带影响 |
| `source-directory` L117 | 播客计数为0 | Worker网络抓取 |
| `reddit-comments` | 显示“阅读上下文获取失败”，而不是robots说明 | 网络 |
| `topic-source-ux` L90 | 只有“真实零边回退主题”一步失败 | 当天前12个真实主题都有边；之前的UI步骤均通过 |
| `workflows` L146/L159 | 缺 `COPILOT_GATEWAY_SHARED_SECRET` | 维持栈未导出该机密；官方runner补跑通过 |
| `zzzz-reader-quality` L58 | 精选只有3张卡片，期望10张 | 10条夹具只有3条通过现行精选资格。精选API本身只返回3条，UI以相同顺序呈现同样3条（`verify-brief\report.json`） |
| `zzzz-reader-quality` L115 | freshness为18.95，期望12.5 | 纯API用例，结果随所选事件和时间变化；语料栈同一用例为59.46。r10未改后端 |
| `zzz-news-discovery` | `/reading` 未自动打开阅读器 | 用例早于9月20日阅读设计，见下文 |

`zzz-news-discovery` 有三处断言早于9月20日阅读设计：HEAD已改为点击“从第 1 篇开始”，阅读标题优先显示中文标题，就地阅读使用 `?reader=` 参数。本轮按现行设计更新：先切换到“全部博客 · 包含公司动态”，使队列与接口查询同口径；再点击开始按钮，比较显示标题，并断言 `/reading?reader=<下一篇id>`。新库重跑依次通过阅读、打开状态、下一篇、分享库、分享工作台编辑与导出，最终停在 `/weekly`。原因是夹具只取Mistral RSS 7天内的材料，而该来源最新一篇发布于9月16日，属于发布方更新节奏造成的日期漂移。

完整运行中 `zzzz-reader-quality` 排在其后，会留下一个已撤回的分享草稿；单独重跑前已从隔离库删除它。分享库列出已撤回草稿并标为“新草稿”，这与HEAD一致，不是r10回归，已列为后续改进。

### r10证据边界

- 线上浏览器测量只覆盖匿名前门：`latency\r10-cloud-cold.json` 的5次加载最终都停在邀请登录页，没有进入已登录阅读路由。
- 已登录路由的耗时取自App Insights中的真实请求（`latency\ai-routes-36h.json`）。精选p50约3.9秒、事件列表约2.1秒，这是后端响应耗时，不是用户点击到画面完成的端到端计时。本轮没有改动这两段后端逻辑。
- 云端没有运行已登录的浏览器E2E，因为这需要站主本人登录Microsoft账户。云端行为以mock-only的 `cloud-session`、`cloud-workflows` 和本地隔离栈为准。

## 15. r11 精选价值排序、固定晨报与每日分享图（2026-09-24）

选文规则见 [架构说明](ARCHITECTURE.md)，分享页结构、“今日”的判定和评审记录见 [工程映射](design/CODESIGN-MAPPING.md) §9，实际发布见 [Azure手册第1节](AZURE-PREVIEW.md#1-带日期的-rollout-状态)。证据目录为 `tmp\brief-r11`，不随仓库分发。

| 证据 | 范围与结论 |
| --- | --- |
| Rust `scoutnews-api` | 174项通过、10项忽略。覆盖选文严格按分排序、来源与版块配额、同一模型版本的第三方报道只留一篇（官方公告例外）、补读门槛、不透明构建排除、北京时间6点切换晨报与下次刷新时间、Anthropic News解析。忽略的10项是需要数据库或外网的契约，包括 `morning_database_contract` 和 `brief_selection_read_only_evaluation`。事件重要性SQL和晨报3小时准备宽限期没有常规自动化用例 |
| 迁移0029 | 新增 `news_editorial_significance`，替换 `reader_editorial_features` 和 `reader_editorial_recommendations_for_profile`，不改表结构和数据。在真实数据的隔离副本（6451个事件）上应用后，v2精选资格为1499条；在事务内执行回滚脚本、恢复旧函数后为1501条，随后整体回滚，副本仍为29。该脚本会删除迁移记录第29行，只作为需要明确批准的应急材料；云端回退按 [Azure手册第8节](AZURE-PREVIEW.md#8-备份恢复与回退) 修复前进，或经批准恢复到新服务器 |
| 类型检查 | web、copilot-gateway、cloud-host 均通过 |
| mock集（5个文件，生产构建） | 193项通过：`editorial-reader`、`public-reading-ui`、`cloud-session`、`cloud-workflows`、`feedback-performance`，均在 `vite preview` 上运行 |
| 分享专项（包含在 mock 集内） | 固定时钟下的主流程：默认10条、上限15条、两种排序、补读排在最后、下载PNG、复制文字版，以及“恢复默认”后焦点回到标题。“换成新版”前后分别下载和复制：旧期写“9月20日值得分享的 5 条新闻”，切换后写“今日值得分享的 10 条新闻”，焦点回到“选择新闻”。复制失败时文本框获得焦点并全选 |
| 新库live `zzz-news-discovery`、`zzzz-reader-quality` | 最终重跑5项全部通过。覆盖真实发布方材料生成1080px宽的PNG，文字版每条都有原文链接；当期精选不在后台重新请求，分享页复用同一份选择，不额外发请求 |
| 截图 `screens2\` | 所有截图来自同一份保存的夹具（`fixture-data.json`），各次运行的条目顺序一致。包括：精选的真实、夹具、安静、空状态；分享页在1440/1280/1024/768/390下的浅色与深色；15条上限；复制失败；旧期保留与换成新版；键盘顺序；触屏滚动 |
| 键盘顺序 | 依次经过排序按钮、复制与下载、各条复选框、“查看原尺寸”、可滚动的预览区域，与视觉顺序一致 |
| 触屏 | 用原始触点事件测量（headless 下 `synthesizeScrollGesture` 不生效）。390px：预览从0滚到1228，之后页面继续从358滚到563；768px：预览滚到2897后，页面从242滚到447。对照组改为 `contain` 后页面不动 |
| 耗时（本机生产构建连本机API） | `latest` 中位约17ms，冷启动打开精选约0.40秒，直接打开 `/share` 到预览出现约0.58秒，站内跳转约0.42秒。此前云端精选接口p50约3.9秒 |
| 独立UI评审 | 三轮，第三轮接受 |

新库live首轮（16个文件，workers=1）48项通过、11项失败、3项未运行。归因：

| 用例 | 归因 |
| --- | --- |
| `real-ingestion`，以及 `source-coverage`、`source-directory` L16、`z-morning-reader` L72 | 真实网络采集超时及其连带影响，与r10相同 |
| `source-directory` L117、`reddit-comments` | Worker网络抓取 |
| `topic-source-ux` L90 | 真实主题都有边，找不到零边回退主题，与r10相同 |
| `workflows` L148/L161 | 维持栈未导出Gateway机密，与r10相同；L28依赖采集状态，第二次运行时失败 |
| `zzz-news-discovery` | 周报为空：Mistral RSS近7天没有新文章，属于发布方节奏造成的日期漂移。用例改为同时使用更新更频繁的真实中文发布方，重跑通过 |
| `zzzz-reader-quality` L21 | 单一来源真实采集失败（网络）。之后重跑通过；按串行规则跳过的3项也已重跑通过 |
| `zzzz-reader-quality` “最早同事件证据” | freshness结果随时间变化：一次为18.95（期望12.5，与r10相同），最终重跑通过 |

另有一次运行因 `-Files` 按正则匹配，`workflows.spec` 同时匹配到 `cloud-workflows`，导致后者在非mock模式下运行，结果作废。

### r11证据边界

- 云端没有运行已登录的浏览器E2E。实际云端的晨报快照和分享页需要站主本人登录后确认。
- 云端schema 29按启动顺序推断：API在监听前执行内嵌迁移，失败就不会监听，而启动日志显示已监听。没有现场读取 `_sqlx_migrations`。
- 9月24日6点那一期由r10执行，已保存的当期仍按r10规则选出；r11的选文规则从9月25日6点那一期开始生效（r12 发布后，这一期已按新规则重选一次，见第16节）。
- 未验证：真机触屏、微信转发后的压缩、鼠标点击后的焦点环、深色主题下的旧期/上限/复制失败状态。
- 耗时是本机数据库和本机网络下的测量，不代表东亚区域的实际往返时间。发布记录时云端只有匿名探测，没有登录后流量；云端改善以之后的真实请求为准。

## 16. r12 晨报按新规则重选、焦点可见性与分享图设备验证（2026-09-24）

规则见 [架构说明](ARCHITECTURE.md)，界面记录见 [工程映射](design/CODESIGN-MAPPING.md) §9.4，实际发布见 [Azure手册第1节](AZURE-PREVIEW.md#1-带日期的-rollout-状态)。证据目录为 `tmp\r12-critic` 和 `tmp\r12-deploy`，不随仓库分发。

| 证据 | 范围与结论 |
| --- | --- |
| Rust `scoutnews-api` | 175项通过、12项忽略。新增常规用例 `grace_lasts_three_hours_from_the_slot_even_across_midnight`：宽限期从当期晨报时刻起算，时刻前1秒不算，时刻当秒开始，满3小时前1秒仍在，满3小时结束；晨报时刻设为23点时，跨过北京时间零点（已是9月25日）仍按9月24日那一期计算；今日时刻过后，昨天那一期不再算“准备中”；间隔模式没有宽限期。新增的2项忽略是下面两个数据库契约 |
| 隔离数据库（`run-cloud-isolation.ps1`，非超级用户迁移角色） | 5项全部通过：`cloud_tests`、`source_directory_database_contract`、`morning_database_contract`，以及新增的 `daily_selection_significance_contract` 和 `daily_selection_edition_contract`。前者从高到低固定12个代表事件的 editorial-significance-v1 分数和角色（官方首发95分，补丁与预发布30分）；检查依据文字（明确发布动作+20、旗舰模型版本+5、人事动态−10、补丁/预发布版本−15、主版本+10，社区帖子提到旗舰模型不加分）；3家独立发布者比单一来源高20分，同一发布者的转载不计；读者本人确认的“观察中”来源只对本人算作已确认。后者覆盖：过去的旧规则晨报保持不变，不写审计；今日的旧规则晨报按原截止时刻重选一次，并写入含前后规则版本的审计；之后即使规则版本被改回，也不再重选；没有合格候选时保留原晨报，只标记一次；宽限期在固定时刻下的五种状态（时刻前、准备中、超时、已完成、23点晨报跨零点） |
| 迁移0030 | r12 检查发现：0029 按 0023 的文本重建 `reader_editorial_features`，丢掉了 0025 补上的读者范围来源状态，读者本人确认或恢复的来源不再算作“已确认”。0030 只重新套用这一表达式，不改表结构、数据、已保存的晨报或快照；函数已包含该表达式时跳过，文本与预期不符时报错中止。上面的显著性契约覆盖这一行为 |
| 性能回归契约（`reader_performance_regressions`，在 `cloud_tests` 内） | 更新夹具：版本发布族改由厂商自己的发布源（一方材料）提供，因为 editorial-significance-v1 会把未分类来源的补丁版本排除在晨报之外，这是正确行为；检查实时选文前先清掉读者A早先保存的晨报，因为已保存的晨报不会再变 |
| 类型检查与构建 | web 通过；copilot-gateway 和 cloud-host 本轮没有改动 |
| mock集（6个文件，生产构建） | 199项通过：15173 端口上 `editorial-reader`、`public-reading-ui`、`cloud-session`、`feedback-performance` 共177项，15175 端口上 `cloud-workflows` 和新增的 `daily-share-devices` 共22项，均在 `vite preview` 上运行。数字来自发布所用的最终构建 |
| 焦点对比度 | `editorial-reader` 在公开与登录、浅色与深色四种组合下，计算精选日期选择器、条目标题和雷达搜索框的焦点环颜色与偏移间隙后方背景色的对比度，要求焦点环不透明且不低于3:1。按主题色值计算，浅色 `#b86e2f` 为3.32–3.96:1，深色琥珀为6.67–8.71:1 |
| Fluent 双重焦点框 | `cloud-workflows` 新增回归：键盘聚焦分享页的“复制文字版”和“下载分享图”（ReaderButton）时，Fluent 仍会加上 `data-fui-focus-visible`，但描边颜色和圆角与静止时相同，没有阴影，只有 3px 实线、偏移 2px 的共享焦点环。修复前的构建上此用例失败。外壳内直接使用的 Fluent 按钮（“不感兴趣”提示里的按钮）只在评审截图中检查 |
| 手机（`daily-share-devices`，iPhone 14 用 WebKit、Pixel 7 用 Chromium，均模拟触屏） | 页面不横向滚动；三个按钮、两个排序按钮和第一条选项都不低于44px且完整在屏内；五个按钮的文字都只占一行（修复前“复制文字版”会折成两行）；预览在框内滚到底后提示消失；“分享图片”交给系统分享的是与预览字节数相同的 PNG 文件，标题为“NewsScout · 今日值得分享的 10 条新闻”；下载得到 1080px 宽的有效 PNG，与预览字节相同；没有未模拟的请求 |
| 微信压缩模拟 | 微信不公开压缩规则，这里采用 Luban 2 逆向得到的规则：长图上限约977万像素，按面积平方根等比缩小，每像素约0.215 bit，在不超过该体积的前提下取最高 JPEG 质量，最低为0.05。默认10条为1080×6238，15条样例为1080×8564，都不缩小，只重新编码。极限情况（15条都写满、其中3条为补读）的理论高度为 330 + 12×754 + 3×796 + 14×88 + 150 = 13,148px，实测正好13,148，低于 iOS 画布上限；微信副本为896×10905，缩放0.83，25px 的链接约为20.75px，JPEG 质量已到下限0.05（0.258 bit/像素，仍略高于预算）。按 iPhone 14 屏宽查看，标题、概述、链接、补读标注和页脚免责声明都能辨认，因此不增加长度提示 |
| 忙碌时的键盘焦点 | `daily-share-devices` 新增：把 `toBlob` 延迟1.5秒；用键盘在“下载分享图”上按回车后，按钮显示“正在生成…”并保持焦点，带 `aria-disabled` 和 `aria-busy`；下载完成、状态提示出现后，焦点仍在该按钮上。修复前按钮在忙碌时变为 `disabled`，焦点丢失，此用例失败 |
| 系统分享失败 | `daily-share-devices` 新增（Pixel 7，Chromium）：依次让系统分享返回取消（AbortError）、拒绝（NotAllowedError，“Permission denied”）和不支持的文件（TypeError）。取消时不提示；拒绝时提示“没有打开系统分享”和“系统没有允许这次分享。可以改用“下载分享图”，保存后再发送。”；其他失败时正文前半句改为“系统分享暂时不可用。”；页面不出现浏览器的英文原文，也不写“分享图未生成”。之后按提示下载，提示消失，下载成功。修复前的构建显示“分享图未生成 / Permission denied”，此用例失败 |
| 独立UI评审 | 两轮。第一轮 CHANGES REQUIRED：Fluent 按钮双重焦点框、登录页标题出现浏览器默认焦点框、微信极限长度没有模拟（三项 should-fix），以及焦点偏移的说明与实际不符、分段按钮焦点环盖住相邻按钮（两项 nit）。全部修复并补齐证据后，第二轮 ACCEPT，不阻塞发布。第二轮新提的 should-fix（系统分享失败时显示浏览器英文原文，标题也不对）在结论之后修复，并加了上面的回归用例。nit 中两处文档缺口已补；外壳内直接使用的 Fluent 提示按钮聚焦时描边变透明，[界面设计](UI-DESIGN.md) 第4节已如实说明 |
| 云端发布 | ACR `ckd`、Ready `newsscout--0000009`，Single/1副本，约64秒不可用。启动日志显示API已监听，随后两期9月24日晨报按新规则重选（全局14条、唯一受邀读者13条），没有重选失败、调度失败或错误。前门与复查：健康、登录页、`/share` 为200，匿名私有session与匿名 `latest` 为401，入口脚本和样式与本机构建一致；冷启动与r11相当。详见 [Azure手册第1节](AZURE-PREVIEW.md#1-带日期的-rollout-状态) |

### r12证据边界

- 云端没有运行已登录的浏览器E2E。今日晨报的重选结果以启动日志为准（日期、是否替换、条数），没有登录查看页面，也没有现场读取 `admin_audits` 或 `morning_runs`。
- 云端schema 30按启动顺序推断：API在监听前执行内嵌迁移，失败就不会监听，而启动日志显示已监听。没有现场读取 `_sqlx_migrations`。
- 手机结果来自 Playwright 的设备模拟（iPhone 14 用 WebKit、Pixel 7 用 Chromium），不是真机：没有验证真实 iOS Safari 与 Android 的系统分享面板、13,148px 长图在真机上的内存占用，也没有在微信里实际发送、下载或长按保存。
- 微信压缩是按 Luban 2 逆向规则做的模拟。极限情况的 JPEG 质量已降到下限0.05，仍略高于预算（0.258对0.215 bit/像素），真实微信可能压得更狠。
- 没有截图或验证：深色主题下的旧期、条数上限和复制失败状态；“已复制”确认和系统分享成功提示；强制颜色（Windows 高对比度）模式；手机按钮网格在200%文字缩放下的表现；雷达的两个分段控件、公开阅读页按钮和对话框内 Fluent 按钮的焦点。
- 忙碌时焦点留在“下载分享图”上，只由用例断言，没有截图。
- 焦点环对比度按主题色值和用例读取的计算样式得出，没有在真实屏幕上测色。

## 17. 云端窗口激活保留页面（2026-09-28）

本轮只修改 Web 会话激活、恢复模态与相应用例，已作为r13部署到Azure；没有修改 API、数据库、迁移、采集或数据。测试目标是同时证明两个不变量：已接受页面在窗口离开期间继续挂载，新的私有请求仍立即被闸门暂停。

| 证据 | 范围与结论 |
| --- | --- |
| Web 类型检查与生产构建 | 最终代码通过；恢复层使用同一 Fluent/Tabster 模态栈，并关闭 surface motion，避免底层弹窗在入场帧透出 |
| `cloud-session.spec.ts` | 最终构建 31/31 通过：首次连接、邀请、撤销、后台 hidden/blur 与 visible/focus、私有请求闸门、账号替换、在途写入、快速/慢速/失败恢复、移动 Drawer、嵌套隐私弹窗、草稿及焦点恢复 |
| `cloud-workflows.spec.ts` | 15175 mock-only 最终构建 16/16 通过；其中账号替换用完整窗口生命周期触发，旧账号 200/401 在途响应均不能覆盖新文档，1440/390 打开的隐私弹窗在换账号后释放 |
| 最终响应式证据 | `tmp\focus-session-final-r2` 的 10项通过，覆盖 1440/1024/768/390 的页面保留、移动隐私弹窗、静默确认、失败恢复、首次慢恢复及390嵌套慢恢复；目录为本机证据，不随仓库分发 |
| 独立 UI Critic | 首轮指出恢复层入场透明帧会让底层隐私文字透出（FS-01，P1）；关闭恢复 surface motion 后复查标记 FS-01 已解决，限定范围 Ready for visual acceptance，无新 P0/P1/P2 |
| r13 ACR与滚动 | ACR `cke` 成功；镜像digest为 `sha256:2a990ebb…f3e5`；旧revision归零后约63秒新revision Ready，最终 `newsscout--0000010`、Single/min=max=1。168项构建输入只变更 `auth.tsx` / `auth.css`，无后端或迁移变化 |
| 前门与配置一致性 | 健康、登录页、`/share` 为200，匿名私有session和匿名 `latest` 为401；入口JS/CSS的字节数与SHA-256和本地最终构建一致。AuthConfig、身份、registry、资源、扩缩、16项环境变量名、7项secret引用、1位受邀读者与0条IP规则保持 |
| 已部署前端mock E2E | 直接打开真实Azure HTML/JS/CSS并拦截私有API，最终8/8通过：移动隐私焦点2项、静默激活3项、失败恢复2项、390px嵌套慢恢复/草稿1项。第一次复跑为7/8：外层移动Drawer在内层隐私模态活动时被Fluent正确设为后台，旧断言错误要求其中账号文字可见；改为断言外层DOM仍 attached，同时继续要求内层弹窗、页面和pending状态存在后，最终8/8 |
| 云端运行观察 | 启动日志显示API监听，0个启动错误、调度失败或晨报重选失败；App Insights从滚动开始只有一次预期匿名401，0个5xx、0个异常 |

### 证据边界

- 窗口离开/返回由 Playwright 合成完整事件序列，不是真实 Windows 应用切换。自动化浏览器没有Microsoft登录态，点击登录只到账号提示页，没有选择或输入凭据；获邀用户仍应在登录后的Azure浏览器中手工切换应用复查。
- 本地用例中的新闻、账号和失败均为明确mock；部署前端8项只使用真实Azure静态资源，私有API仍被拦截。这些结果证明发布bundle与前端隔离/交互契约，不证明真实Microsoft登录、私有后端网络或云端延迟。
- 直接嵌套恢复截图覆盖 1440 和 390；1024 仅覆盖静默确认，768 仅覆盖隐私弹窗。深色与 forced-colors 的恢复证据只覆盖 390 首次连接，不扩大为完整主题认证。
- 私有请求闸门和账号隔离由请求记录及源码/用例断言证明；最终截图目录没有独立网络 manifest。
- App Insights窗口内只有发布探测流量，不能据此推断登录用户切换应用时的实际网络耗时。
