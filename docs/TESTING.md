# 测试与证据指南

适用版本：0.2；维护日期：2026-10-14。只使用项目已有 TypeScript、Vite、Rust 和 Playwright 工具。文档修改不需要构建应用或运行真实采集；代码变更选择覆盖该行为的最小范围。

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

组件发布分组使用 Rust 的 `coverage::tests` 与隔离启动器的 `-TestPattern 'component release groups'`。`release-families.spec.ts` 不再依赖实时 RSS 永远保留某几个旧版本：第一项创建明确标为合成的九条组件材料，覆盖三个分组、CLI/SDK/Provider 身份、过滤、分页、访客读取和独立隐藏/撤销，结束后清理；scoped npm 用例按截图形态创建四条 `@modelcontextprotocol/*@2.2.0`，让各包引用不同变更编号，断言API只返回一组、官方来源数为1、热度为0，页面展开保留server/core/codemod/client四个目标与版本；最后一项只读恢复语料中的2026年9月18日实际版本，并采集1440/1024/768/390的列表布局（r10 已移除卡片视图，旧记录中的卡片截图不再生成）。

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

## 18. r14 GitHub App 凭据轮换与Azure切换（2026-09-28）

本轮不改数据库schema或新闻数据，目标是把Azure Copilot从最长约8天、不可续期的静态PAT切换为GitHub App user token bundle，并验证刷新后旧refresh token失效时仍不会丢失新一代凭据。

| 证据 | 结果 |
| --- | --- |
| Gateway单元测试 | 12/12通过：bundle/URL严格解析、显式模式、外部账号固定、首次账号核验、并发单次refresh、先持久化新一代再核验、瞬时 `/user` 恢复、不重用旧refresh token、Key Vault延迟恢复、固定版本元数据探针不重写bundle |
| 本地构建 | Node全仓typecheck与生产构建通过；Rust 176通过、12忽略；Bicep编译、PowerShell AST、`git diff --check`通过 |
| ACR | Linux构建 `ckh` 成功；不可变镜像 `sha256:af61d1c5…4276` |
| Device Flow初始化 | 专用账号核验通过；立即refresh通过；第二代bundle写入Key Vault。现场修复登录名下划线校验和PowerShell `?api-version` 插值后重跑成功；失败轮次均未写入bundle |
| what-if与滚动 | 修正Managed Identity API为East Asia支持的 `2024-11-30` 后，what-if只有Container App/Auth deploy和bundle secret级role create、0 delete；最终 `newsscout--0000011`、Single/1 |
| 配置边界 | `github-app`、Client ID、外部账号固定及无版本bundle URL存在；旧 `COPILOT_GITHUB_TOKEN` 不存在；应用只有6项非Copilot secret引用 |
| 零推理探针 | `credentialAccepted/accountVerified/credentialDurable/persistenceWriteVerified=true`；16个模型；精确 `gpt-5.6-terra` 可用；0次推理 |
| 真实模型调用 | 容器内Gateway返回HTTP200、provider `github-copilot`、模型 `gpt-5.6-terra`、`reasoningEffort=low`、非空内容 |
| 运行时refresh | 强制refresh成功；Key Vault版本1→2、generation变化、账号不变、refresh有效期更新至2027-03-28 16:40（+08）；revision重启后Gateway仍 `ready/accountVerified/durable=true` |
| 运行日志与前门 | 公网 `/health` 200；最终Single/1；300行日志中0个credential initialization/refresh/persistence/process-exit错误 |
| 旧凭据 | GitHub官方凭据吊销接口返回202，随后旧PAT访问 `/user` 返回401；吊销后零推理探针仍确认账号、持久化写回、16模型和精确Terra；Key Vault `copilot-github-token` 再次软删除、`Recoverable` 90天且未purge，计划2026-12-27 16:47（+08）清除 |

证据边界：真实摘要使用不写数据库的短材料，只验证推理链路，不代表新闻质量评测；强制refresh由同容器中的独立维护进程发起，随后立即重启revision让常驻Gateway读取最新bundle。Microsoft登录后的全部产品流程沿用既有r13证据，本轮没有重新宣称第二真实读者或全部私有工作流live验收。

## 19. r15 自助账号与双身份入口（2026-09-28）

| 证据 | 结果 |
| --- | --- |
| 本地构建 | Node全仓typecheck/生产构建通过；Rust 175通过、12忽略；Bicep编译通过 |
| 会话与页面 | `cloud-session.spec.ts` 28/28；部署登录页200，Microsoft与邮箱入口存在，无申请编号/未获邀文案，显示手机号限制 |
| 隔离数据库 | Microsoft与客户OIDC首次请求即时建号；三个身份的CSRF、兴趣、状态、曝光、来源、晨报、分享、导出和任务按RLS隔离；匿名、未知provider和错误issuer不建号 |
| ACR与部署 | `ckj`成功；digest `sha256:9b9f46de…db2b`；Azure validate与what-if通过、0 delete；Ready `newsscout--0000012`、Single/1、旧revision退出 |
| AuthConfig | AAD和 `newsscout-account` 同时enabled；客户provider使用 `ClientSecretPost`、精确discovery URL及Key Vault secret setting |
| 真实前门 | `/health` 200且 `customer-preview`；AAD与客户登录路由分别到Microsoft和CIAM授权端点；匿名session 401 |
| 容器身份探针 | AAD与客户OIDC session均200且user ID不同；错误issuer、未知provider和匿名均401 |
| Copilot回归 | 零推理探针 `accountVerified/credentialDurable/persistenceWriteVerified=true`，16模型、精确Terra、0次推理 |

证据边界：客户授权页及Create one来自真实部署，但未输入真实备用邮箱；完整邮件注册、验证、找回和首次用户操作仍需真人完成。External ID当前不支持手机号作为第一登录因子，短信只能作为可选付费MFA。

## 20. r17 长篇回顾精选与 scoped npm 同批发布（2026-09-29）

| 证据 | 结果 |
| --- | --- |
| Rust全量 | 189项发现，177通过、12忽略、0失败；新增 scoped npm 正向/反向边界，旧包、客户端、插件、快照与配额测试全部通过 |
| 空库迁移 | 随机 `scoutnews_e2e_<32hex>` 数据库从迁移1执行到31；`daily_selection_significance_contract` 通过；最终 `_sqlx_migrations.max(version)=31` |
| SQL编辑策略 | `editorial-policy.spec.ts` 前五项5/5：`2026 in LLMs (so far)` 的长材料为 `analysis / 70 / true`，短材料与社区反例不升级；Stratechery付费目录边界保持 |
| MCP live E2E | `-TestPattern 'scoped npm releases'` 1/1：四条不同变更号的 `@modelcontextprotocol/*@2.2.0` 原始记录只显示一组，展开保留四个package，官方来源数1、热度0 |
| 本地生产构建 | Web TypeScript/Vite、Copilot Gateway、cloud-host与Rust debug构建通过；完整live启动器使用全新数据库及迁移31 |
| ACR与what-if | ACR `ckm` 成功，digest `sha256:297356d6…20aaa`；what-if与r16已接受变化形状一致，目标镜像/release ID确认，0 delete |
| Azure切换 | 10:08:42（+08）确认r16为0副本；10:10:27 r17 `newsscout--0000014` 成为唯一Healthy Single/1；公开 `/health` 200，真实登录页两个入口与精简说明存在 |
| 当天重选 | 启动日志记录三个作用域按 `editorial-significance-v1-ranked-v2` 各执行一次，结果12、15、15条；API在迁移后监听，据此确认schema31 |

维护边界：Bicep恢复Single时控制面一次读数短暂同时列出r16/r17各一副本，随后旧revision inactive且replica列表为空，不能写成零重叠。容器 `exec` 因Azure CLI WebSocket 404失败，Azure Monitor MCP查询亦超时；因此没有把目标文章在登录后页面中的最终位置或真实MCP保留记录再次读取出来。代码、隔离SQL和同形态live E2E已验证修复，登录态内容仍需维护者本人页面复查。

## 21. r18 雷达公告关联与多语言更新（2026-10-09）

| 证据 | 结果 |
| --- | --- |
| Rust全量 | 199项发现，187通过、12忽略、0失败。覆盖官方公告/解读、型号和尺寸、用途与比较、冲突官方锚点、原始与生成标题区别、未知/未来时间、七日非传递批次、语言别名、稳定/预发布通道、24小时精确边界、旧分组快照及已应用SQL字节 |
| 数据库/API/UI | `radar-grouping.spec.ts` 与 `release-families.spec.ts` 三项live用例全部通过：九条合成材料得到七个组/单篇；分页、推荐/最新排序、来源/关键词筛选、四个成员各自详情、隐藏/撤销和访客兴趣读取均核对。旧Mem0与MCP协调发布保持 |
| 前端反馈 | `feedback-performance.spec.ts` 四项通过，另有一个个人topic缓存纯测试通过。新live用例先复现“隐藏同事件组主条目导致整组消失”，修复后确认官方成员仍可见且撤销保留展开位置 |
| 构建与布局 | Node全仓生产构建、最终Web typecheck/Vite和Rust API构建通过；1440/390合成分组截图与页面宽度断言通过。截图不是云端真实新闻验收 |
| 真实云端基线 | 已读到截图对应的四份保留材料；r17维护API的两份列表和四份详情都没有新分组。Agent Framework两个版本来源时间差20小时54分20秒；Anthropic官方公告仍为 `day` 精度，Simon文章为 `time`，没有给官方日期补造时分秒 |
| 隔离云端合同 | 最终源码重新运行空库1→31升级、受限角色/RLS、独立读者、来源、任务、访客、关联上下文、每日选文与目录合同，全部通过；未启动或升级日常schema27库 |
| 迁移兼容性 | 云端0031实际SHA-384为 `02b5b04d…f7c39`，与原CRLF字节一致、与误规范化的LF版本不一致。仅恢复源文件字节；SQLx内嵌迁移校验回归通过，没有改数据库checksum、删除记录或关闭校验 |
| 发布后真实API | 16:55（+08）两份列表和四份详情确认目标两组，另一篇比较/定价文章保持独立；逐篇标题、中文标题、摘要hash、证据ID、时间及精度与r17基线一致。设置、兴趣、阅读状态、保存晨报、来源覆盖指纹和schema均保持 |
| 发布与前门 | ACR `ckn`成功，最终Ready `newsscout--0000017`、Single/1；真实首页200、匿名私有session401，入口 `index-BqVurVy3.js` 的SHA-256与本地生产构建相同。七条当次运行日志无启动、迁移或凭据错误 |

性能证据保留原始冷/热差异：最终隔离样本为2400条历史、60条活跃材料，实际候选发现查询返回62行、EXPLAIN约50.59ms；初始分组两页合计42.87秒，后续同形单页约418ms。主评分/连接初始计划开销仍存在，不能把候选查询或热读取数字当作端到端亚秒SLA；本轮没有扩大连接池、提前截断候选或改变RLS来掩盖慢路径。

本轮不重新生成摘要、不提升选文规则版本、不重选已保存晨报。隔离用例确认设置、保存快照及模型尝试次数不变；实际发布后的保护指纹与真实API分组结果也已单独确认。云端读取经过维护通道，不是新的真人Microsoft登录/点击验收；API认证处理仍正常更新既有读者的last-seen元数据，不把它称为整个过程完全无写入。自动“已打开”写入与紧接的反馈写入之间的并发排序问题不在本轮保证范围内，反馈用例先等“已打开”完成后再操作。

## 22. r19 GitHub Engineering 来源（2026-10-11）

| 证据 | 结果 |
| --- | --- |
| Rust全量 | 200项发现，188通过、12忽略、0失败；新增合成RSS契约，核对目标原始时间、article阅读上下文和重复解析指纹，不把合成正文冒充真实文章 |
| 隔离数据库 | `run-cloud-isolation.ps1` 的5项合同通过，迁移1→32；来源合同验证T1/observing、同一GitHub发布者、两项主题、迁移重放不改已有名称/暂停/间隔/游标，以及私有同地址订阅不替代公共默认源 |
| 来源页面live | `github-engineering.spec.ts` 1/1通过；真实隔离API和页面同时列出 Engineering 与 AI & ML，不依赖外网Feed内容或某篇文章永远留在Feed中 |
| 官方入口核查 | 官方Engineering RSS和robots均200，Feed响应398896字节，在原有适配器上限内；这不证明全历史覆盖 |
| ACR与迁移 | `ckp` Linux构建成功，174项输入哈希复核一致；18:55云端直接读取schema32，31/32校验和分别为 `02b5b04d…f7c39` / `2febf642…55eb0`，与源码字节一致 |
| 真实定向采集 | 唯一任务仅含Engineering；18:30:02–18:30:05（+08）成功，新入库10、更新0、失败0，来源保留10条、连续失败0 |
| 真实文章与API | 目标原始URL、官方身份、`2026-10-06T20:57:56Z`及time精度保持；近7天可见、72小时不可见。阅读标题为“为智能体规模开发构建 Git 基础设施”，`summaryKind=copilot`，详情 `readingContext.body.length=11562` |
| 保护与前门 | 七项设置/兴趣/状态/快照/分享/来源指纹与18:04基线一致；首页200、匿名session401；部署入口 `index-BqVurVy3.js` 与既有验证构建SHA-256相同 |

SQL的 `news_publisher_excerpt` 在该查询中返回3000字符的评分摘录，不代表详情只保留3000字符；详情正文长度与评分摘录分别记录。没有提高排序、扩大时间窗口、修改原始日期或重选保存版来让文章出现。新增材料沿现有自动摘要队列处理，不是全目录重跑；本轮没有单独重做凭据轮换或零推理模型探针。

云端证据来自正常权限链路下的维护API，不是新的真人登录和点击验收。最初最终单副本检查未通过，随后只读复核全部条件通过；未据此推断原失败原因，也未回退到缺迁移32的旧镜像。诊断传输经历限流和replica替换，最终使用短启动命令及受限stdin的一次exec连接完成；只产生一个采集任务。证据保存在忽略目录 `tmp\github-engineering-20261011`，包括基线、采集回执、最终SQL/API、配置检查和临时文件处置记录；隔离库日志位于 `services\api\target\cloud-validation\cb3c185b618f4495b0c2f0f9ccc0e587\logs`。

## 23. 可点击分享 PDF 与门户二维码（2026-10-12）

最终前端生产构建通过；`cloud-workflows` 的3项分享用例与 `daily-share-devices` 的12项用例合计 **15/15通过**。本轮没有改后端、迁移、摘要或选文规则，因此没有把旧的 Rust/数据库全量数字计作本次重新执行。

| 证据 | 结果与边界 |
| --- | --- |
| 实际 PDF | 下载后由 `pdf-lib` 解析每页 Link/URI 注释，逐个比较选中文章的完整去跟踪地址；长中文路径、重复查询参数、转义和片段不从显示标签反向重建。标题与原文区域在同页、坐标在正确区域且不重叠；每页门户入口指向同一根地址 |
| 独立解析与渲染 | 使用本机已有的 `pypdf` 与 PyMuPDF 再核对5份实际文件，共40页、116个链接；完整渲染每页，并确认注释落在页面内且包含真实绘制文字。包括10条混合内容、15条极限内容、两个手机引擎的输出和长门户网址，不是只检查 `%PDF` 文件头 |
| PNG 门户二维码 | 用 `pngjs` / `jsqr` 解码实际导出图片；默认公共地址、极限15条后的压缩模拟副本和较长 Azure 形态地址均得到准确根地址。二维码为 H 级容错、黑白整数模块及四模块留白；首次 M 级在极低质量压缩模拟中未通过后作了修正 |
| 地址与来源边界 | 本地、IP、常见内网域名格式、HTTP、非标准端口及带凭据的门户地址不导出；去除个人路径、查询和片段。原文无有效 URL 时仍保留已知发布者并标注缺少链接，没有伪造可点击区域或将发布者误写为“来源未知” |
| 选文、期次与隐私 | 默认10/上限15、两种顺序、补读和原日期、固定旧期及“换成新版”、恢复默认保持；未选/隐藏夹具不进入导出，无采集/模型/发布请求。旧已公开链接的显式撤回仍独立验证 |
| 设备与恢复 | WebKit iPhone 14、Chromium Pixel 7模拟环境完成 PNG 原生分享替身及 PDF 下载；按钮至少44px且文字不折行。复制失败文本框聚焦并全选，原生分享取消无报错，失败提示可改用下载 |
| 焦点与状态 | PDF 编码失败可见且可重试，忙碌按钮保持焦点和 `aria-busy`，锁定选文、防重复下载，空选择禁用操作。390px 的浅色、兼容深色和 forced-colors 分别留存加载、指针错误、键盘忙碌/恢复、手动复制、空态，共18份截图 |
| 独立视觉评审 | 首轮要求保留无效 URL 对应的已知发布者，并补齐状态、长域名及实际滚动到底的预览证据；修复后窄范围复查接受，无本范围内未关闭项。静态截图、解析与解码相互补充，不互相代替 |
| r20部署资源与真实入口 | ACR `ckq`、Ready `newsscout--0000019`；40份公开静态资源与上述本地构建逐字节匹配，首页/健康200、匿名session401。实际部署资源及响应策略下生成1页/5个链接的合成PDF，实际PNG解码到门户根地址；留存1440/390截图，不是只验证源代码中的目标字符串 |
| 云端交互边界 | 上一行的私有API由新浏览器上下文中的本地合成夹具响应，实际私有数据调用0、应用写入0；没有真人登录态分享、用户点击历史读取、数据库保护指纹重读或新模型探针 |

证据为忽略目录 `tmp\share-links-20261012`：最终 `targeted-v3-results.json` / `targeted-v3-e2e`，独立解析及完整页面图片在 `targeted-v3-pdf-rendered`；部署后的静态资源校验与合成导出在 `r20-frontend-verification.private.json` / `deployed-assets`。更早的 `targeted` / `targeted-v2` 记录包含初始失败，不是最终验收输入。PNG 的文字仍不可点击；PDF 正文为栅格，不宣称文本搜索、可选文字或完整 PDF 无障碍。没有真机/真实微信上传验收，也不保证所有聊天应用的内嵌预览都保留 PDF 点击能力。

复跑时只启动隔离的前端生产预览，不启动或连接个人 API/数据库；两个测试文件会拒绝其他 base URL，HTTPS 形态的测试域名由 Playwright 路由完全映射到本地候选，不访问公网：

```powershell
$env:SCOUTNEWS_E2E_BASE_URL = 'http://127.0.0.1:15175'
$env:SCOUTNEWS_E2E_MOCK_ONLY = 'true'
npx.cmd playwright test cloud-workflows.spec.ts daily-share-devices.spec.ts --grep 'daily share|share image|portal URLs|public-origin exports|fifteen longest|PDF failures|keyboard focus|failed system share|long public portal|share export states' --workers=1 --retries=0
```

文件选择器使用文件名，因为 Playwright 将其当作正则表达式，直接传 Windows 反斜杠路径会导致零用例。`pdf-lib`、`jsqr`、`pngjs` 是测试依赖；独立 Python 解析/渲染是额外证据，不是运行上述 Playwright 用例的先决条件。实际 Azure 发布结果及检查范围以运行手册第1节为准。

## 24. 可选择的阅读兴趣学习（2026-10-12）

这是默认关闭的云端账号弱反馈，不是点击流水回填、读完检测或已训练好的推荐模型。20秒、两篇支持及最多1综合分是保守工程边界；现有本人历史不足以衡量真实效果提升，不能用以下合成加分断言替代用户实验。

| 证据 | 结果与边界 |
| --- | --- |
| 最终构建 | Web/cloud-host TypeScript 检查和 Node 全仓生产构建通过；没有改依赖、模型配置、推理预算或日常数据库 |
| 数据库/API | 最终 `run-cloud-isolation.ps1` 5项合同通过：非超级用户升级、RLS、多读者、来源、晨间版和选文。新增学习断言包含在综合隔离合同中，不另算成一个单独运行的测试 |
| 升级保护 | schema32→33前后比较12张既有表指纹，材料、来源、账号、反馈和保存版不因迁移改变；没有历史打开回填。SQLx内嵌31/32/33的SHA-384固定回归通过，旧迁移字节不变 |
| 信号接口 | AAD与邮箱两个合成身份分开验证，默认关闭、CSRF、未知字段、内容版本、本人可见性、幂等、每日60篇、设置代次与清空/关闭串行化、过期和本人导出均有断言。额外输入单测1项通过，严格拒绝客户端身份、时间、标题和主题 |
| 评分 | 与迁移29中的旧函数比较冷启动分数；至少两篇、候选自身排除、显式收藏优先、匹配负反馈阻止增益、禁用/零权重主题、14天衰减、30天有效期、精确最近150篇和综合分最多增加1均验证。其他账号、访客、本地及过去截止点不能继承新信号 |
| 当期与存档 | 学习、清空、关闭不改变已保存条目指纹；`DAILY_SELECTION_RULE` 仍为 `editorial-significance-v1-ranked-v2`，不会因发布触发当天重选 |
| 浏览器 | `reading-personalization` 20项、`cloud-session` 28项与 `cloud-auth-api` 1项，最终 **49/49通过**，0跳过/失败/flaky、顶层错误为空。覆盖快速打开、后台/空闲/时间跳跃、文章/版本切换、失败重试、迟到响应、旧身份请求和会话恢复 |
| 开启后立即阅读 | 1440/390分别走开启学习→关闭隐私→立即打开文章；手机先正常关闭导航抽屉。依靠产品自动聚焦，不注入 `pane.focus()`，23秒模拟前台时间后仍聚焦阅读区且恰有1条信号；不增加等待或放宽阅读资格来掩盖焦点竞争 |
| 交互与视觉 | 1440/1280/1024/768/390浅色、390兼容深色及 forced-colors；对话框上下端均可达，无横向溢出。1440浅色与390深色用实际积累的1条合成信号验证关闭确认、取消、键盘焦点、pending、失败保留和重试；清空与关闭有不同后果说明 |
| 独立评审 | 首轮指出关闭即删除缺少确认；修复后又补齐稳定动画帧截图及390深色键盘流程。最终窄范围复查接受两项证据缺口，沿用此前已关闭的确认问题，不扩展为全站或无障碍认证 |
| 引擎边界 | 显式启动的 WebKit 移动上下文通过前台阅读计时，不要求再次点击原站；这不等于真机验证，也没有把 Chromium 的关闭确认流程宣称为跨引擎已测 |
| 兼容恢复 | r20应用输入逐字节保持，只补入相同0033的恢复候选，在新隔离数据库通过原r20综合云端合同1项，实际内嵌并应用33份迁移。维护脚本6种离线场景通过，禁止在请求新镜像后恢复原schema32镜像；不是云端回退演练 |
| 真实部署 | 初版r21实际升级到33，r21a仅修正前端焦点；最终为 `ckt` / `0000021`。18:21:52实际复核全部33校验和、九项既有数据指纹和精确本人session/设置GET，未开启任何真实账号的学习 |
| 真实资源合成交互 | 最终40份部署资源与验证构建逐字节匹配；1440/390在实际CSP下验证开启后立即阅读、产品自动聚焦、恰1条合成信号及确认关闭删除。实际两档均为浅色，不能把请求的深色偏好当作界面已切换。私有API全拦截、0真实应用写入，不称为真人登录流程；维护GET另有正常last-seen更新 |

最终证据在忽略目录 `tmp\reading-personalization-20261012`：`cloud-isolation-v4.log`、`final-node.log`、`ui-v8-results.json` / `ui-v8-artifacts`、`final-rust-input.log`、`frozen-migrations-final.log` 和 `recovery-contract.log`。早期已接受的 `ui-v5` 47项及其54份PNG（其中26份阅读学习控件）保留作迭代证据，不再当作最终用例数。真实受限身份诊断、部署参数和原始维护输出不提交公开仓库。

纠正版的11份操作脚本语法与6种离线场景记录为 `r21a-offline-deployment-checks.json`；不可变构建清单、维护前后数据及时间线使用 `r21a-` 前缀，最终部署资源/交互结果为 `r21a-frontend-verification-v2.private.json` 与 `deployed-assets-r21a-v2`。原 `r21-` 数据库升级记录、两次失败的部署浏览器诊断及首份r21a资源报告保留，不用最终成功覆盖失败经过。

v2额外核对主题属性和计算背景：390系统偏好为深色，实际仍为浅色，并记录内联初始化脚本被现有CSP拒绝。该既有缺口列入项目状态，不通过注入 `data-theme`、放松CSP或另发无关产品变更来掩盖；因此本地深色控件通过不等于云端系统深色已生效。此限制与阅读学习的两档合成流程分别报告。

保留失败迭代而不混入最终通过数：早期数据库夹具缺时间/版本，已修正；`ui-v3` 因在 describe 内设置 browserName 而收集失败，0用例并非通过；v4截图含过渡帧，v5以稳定截图取代。恢复源码与候选曾共用同名 Rust package 的 target，导致旧测试可执行文件被误判为 fresh；确认没有活动进程后，仅清理该验证 target 中的 `scoutnews-api` package，再对当前显式 manifest 重建。最终两个定向单测均为1通过、200 filtered，旧的199 filtered记录不能证明新输入测试已运行。不同 checkout 后续使用独立 target，不能仅凭命令退出0判断测试覆盖正确。

r21初次上线后的合成交互发现：隐私对话框关闭时的延迟焦点恢复会抢走随后打开的文章焦点，阅读计时因此按设计暂停。修复仅限 `AccountControls`：新指针/键盘输入、再次切换弹窗状态或卸载时取消旧恢复；共用会话恢复器及阅读门槛不改。v6中新增手机用例因未关闭导航抽屉而超时，是夹具路径缺失；补上真实关闭动作后v7全通过，v8再移除两条新用例的手动聚焦并全部通过。独立窄范围复查接受焦点交接修复，原控件接受结论保持；这不等于穷尽键盘路径或真实用户效果评估。

复跑前先按§3启动隔离前端生产预览；这三份 spec 拦截其私有API，不启动个人后端：

```powershell
$env:SCOUTNEWS_E2E_BASE_URL = 'http://127.0.0.1:15223'
npx.cmd playwright test reading-personalization.spec.ts cloud-auth-api.spec.ts cloud-session.spec.ts --workers=1 --retries=0
pwsh -NoProfile -File services\api\tests\run-cloud-isolation.ps1
```

数据库脚本自行创建、停止并清理唯一隔离PG实例，端口55489须空闲；不连接日常schema27库。浏览器 mock、隔离API合同、真实部署资源和本人维护GET是不同证据，线上发布与实际迁移结果另见Azure手册。

## 25. 每日来源门槛与长摘要图解（2026-10-14）

| 证据 | 结果与边界 |
| --- | --- |
| Rust与构建 | 当前源码204项发现，192通过、12忽略；摘要10项、reader21项另有定向通过。Node全仓typecheck、Web生产构建通过；没有新增依赖或更换模型 |
| 来源门槛 | Rust覆盖T1/T1.5、T2高分/收藏/补读、混合或空证据与未知等级；隔离SQL验证同义门槛、RLS私有证据不可见、T2仍可直接阅读。雷达与周报不继承每日门槛 |
| 当天重选 | 合成当天T2-only保存版且无合格替代时变为空版，保留一次审计；第二次不重选，往期内容保持。规则版本为 `editorial-significance-v1-ranked-v3-t1` |
| schema34升级 | 5项隔离数据库合同通过。综合合同在33→34前加入108条明确合成材料，验证近7天最多100篇、较旧当日选文优先、过期/未来/超额排除、failed不自动恢复和pending/running租约不变；14类原数据指纹保持，未伪造图解，新增任务为格式4。清理仅针对夹具ID |
| 内容与引用 | 格式、条数、字数、未知字段、控制字符、重复内容、引用越界和非逐字片段拒绝；额外测试拒绝切断词内否定、英文词和数字单位。合法图解随文字原子保存并可序列化进快照；旧内容版本写入不改变现有记录。完整要点保留，不将片段检查冒称语义事实核验 |
| 最终浏览器 | `summary-visuals` 37项、`public-reading-ui` 39项、`public-reading-api` 64项、`reading-personalization` 20项，合计160通过，0失败/跳过/flaky；全部在隔离预览及明确API替身下运行 |
| 行数与响应式 | 实测五行不显示、六行显示；1920→390换行触发重排。个人/公开1440/1280/1024/768/390明暗共20组，SVG文字边界和页面无横向溢出有断言 |
| 交互与状态 | 两端对照/overview、完整依据展开、原文页签切换、正文跳转焦点/首点可视均通过。Tab→依据控件→Enter展开/收起有键盘证据；旧格式、pending、failed、invalid、无安全结构10组状态截图保留完整要点，不发原站图片请求 |
| 独立视觉复查 | 补齐宽度、状态、overview、图前限制说明与手机跳转后获接受；仅限本次摘要图解，不扩展为全站或新的CoDesign深色设计验收 |
| 实际云端迁移与保护 | r22 / `ckv` / `newsscout--0000022`，实际schema34与34份校验和确认；11项设置、兴趣、阅读/曝光、分享、学习、来源及往期精选保护指纹保持 |
| 实际当天规则 | 本人原11条中4条不合格，重选后7条均合格、同截止时间且恰1次审计；全局当天不合格主条目20→0，历史精选未改 |
| 实际模型输出 | 3篇自动任务生成的Terra/low格式4图解，其真实尝试、保存审计、完整要点及详情API一致，均在本人当期内；没有人工伪造模型结果或额外触发推理 |
| 部署资源与图解 | 40份实际资源SHA-256一致；1440/390渲染真实模型文章的22/36行完整要点，SVG边界、AI标识、依据键盘展开、全文跳转与焦点通过。会话及所有私有API均本地替换，0真实私有请求/应用写入 |
| 维护与恢复 | 9份部署脚本语法和6种离线维护场景通过；schema34纯文本恢复组合的摘要及隔离云端合同通过，`cku`构建成功。正常发布未使用恢复镜像，不称云端回退或PITR演练 |

本轮证据在忽略目录 `tmp\brief-visuals-20261014`：`cloud-v3.log`、`rust-all-v4.log`、`ui-v4-results.json` / `ui-v4-artifacts`。首次数据库失败为旧学习夹具仍断言v2规则，已同步到新的日版规则；另将误嵌套的分句测试移到模块级，最终确认实际发现并运行。UI v2被PowerShell 5对Vite警告stderr的处理提前中止，改为原生流重定向并保留退出码检查，未改产品来掩盖失败。v3的141项是补齐宽度/状态/正文跳转前的证据，不能冒充最终160项。

复跑UI先按§3启动无后端的生产预览，再执行：

```powershell
$env:SCOUTNEWS_E2E_BASE_URL = 'http://127.0.0.1:15224'
$env:SCOUTNEWS_E2E_MOCK_ONLY = 'true'
npx.cmd playwright test summary-visuals.spec.ts public-reading-ui.spec.ts public-reading-api.spec.ts reading-personalization.spec.ts --workers=1 --retries=0
```

本地20组截图使用合成材料；部署后的 `deployed-assets\actual-model-*.png` 使用本人授权维护GET取得的真实模型文章，但仍以本地会话/API替身渲染，不是登录态E2E。`r22-outcomes.private.json` 记录实际数据与模型匹配，`r22-frontend-verification.private.json` 记录部署资源及交互；本人维护GET会正常更新last-seen，不把整轮称为完全无写入。没有代用户开启学习、提交阅读信号或额外采集。

审计核对曾发现原JSONB与 `before_value` 的原始哈希不同。已定位为既有JSONB→Rust Value→JSON往返使一项 `items[4].snapshot.recommendation.freshness` 的f32评分出现小数尾差；只读重建全部JSONB后的哈希与原版一致，条目ID/顺序及该数字的f32值相同。结果明确保存 `originalEditionAuditRawHashMatched=false`、`originalEditionAuditF32HashMatched=true` 和1处数值变化；没有为匹配哈希写回数据库，也不将其冒称字节级原样保存。时区假设未获支持。

部署验证首次从错误工作目录启动，随后使用了只适用于首页的h3标题选择器；截图和零页面错误确认雷达已正常加载，改私有验证器为语义标题按钮后通过，产品代码未改。最终使用仓库根目录和Node22.23.2，失败记录保留。

云端两档实际均为浅色；390虽然系统偏好深色，`data-theme`仍为空、阅读面为 `rgb(252, 252, 249)`，每档捕获一次既有内联主题脚本CSP拒绝。未放松CSP或把本地深色截图冒称云端深色验收。不保证真实模型每次都生成合适图解或全部旧摘要已经补齐；不宣称原文图片复用、真人登录、真机或完整无障碍验收。日常schema27库未启动或迁移；发布时间线与schema34恢复限制见Azure手册。

## 26. 首页跳转与多种图解（2026-10-15）

r22的雷达渲染验收没有覆盖“首页长列表 + 长摘要、展开依据之前直接跳转”的场景。用户报告后在本人已保存的真实模型摘要上复现：`overflow:hidden` 的固定外壳仍被程序化滚动，工具栏随之离开视口。修复将外壳改为 `overflow:clip`，阅读面板保留唯一滚动权；不能仅以首条要点可见来验收。

| 验证面 | 已取得的本地结果 |
| --- | --- |
| 精确HOME回归 | 个人/公开 × 2560/2000/1440/1280/1024/768/390，共14项；7篇列表、8条长要点，直接点击跳转后外壳scrollTop为0、面板和工具栏top为0、首点位于工具栏下且获焦，背景位置不变；切换原文、上一篇/下一篇及关闭后焦点/位置恢复 |
| 已保存真实模型文章 | 六档2560/2000/1920/1440/1280/390全部缺陷标记为false、无页面错误；外壳和工具栏保持0、窗口位置不变、要点获焦。仍为本地会话/API替身，不是线上登录态E2E |
| 图形与内容 | 分支结构、并列栏、流程、时间线；个人/公开、宽/窄、明/暗、双步骤横向转竖向、SVG文字边界/重叠、中文标点、准确五/六行阈值、键盘依据展开和全部缺图状态。最终`summary-visuals`69项通过，无跳过、失败或重试 |
| 受限合同 | Rust摘要11项通过；v1兼容、v2完整流程依据、步骤顺序、未知字段/活动内容、非法/倒序/重复/闰年日期、否定与单位片段边界；TS与公开投影定向用例同轮通过。不能把这些结构检查当作自然语言语义事实核验 |
| 持久化与API | 独立55489临时库的云端合同1项通过，含新v2流程/时间线原子保存、详情API、快照序列化及旧内容版本拒写；应用迁移1–34逐一哈希匹配，未新增迁移 |
| 独立视觉复查 | 接受此范围，无P0/P1/P2整改项；查看匹配的修复前后截图、个人/公开四种图形及典型响应式状态，不据此声明全站功能等价、完整无障碍、真实登录或云端深色验收 |

证据根目录为 `tmp\summary-graphics-20261014`：最终 `rich-final-results.json`、`rich-final-artifacts`、`rich-final-real-article.log`、`persistence-final.log`；修复前真实内容截图留在 `baseline-r22`，修复后为根目录的 `jump-after-*.png`。`rich-ui` 是中文标点换行修正前的中间证据，不作为最终图形验收。构建和typecheck通过，仅保留既有大分块警告；两个临时端口15225/55489均已释放，日常schema27库未启动或迁移。

首次直接调用cargo因缺少VS链接库失败，随后改用仓库`scripts\rust.ps1`成功。新增Rust用例最初误嵌在另一测试内，已移到模块层级并确认11项中实际执行了该用例；未把“编译存在但未运行”当作通过。图解v2沿用格式4，不自动重跑旧任务，实际模型是否选择流程/时间线取决于材料，不能以受控图形夹具冒称线上模型已生成所有类型。

### r23部署结果

| 验证面 | 实际部署证据 |
| --- | --- |
| 发布与配置 | ACR `ckx`、`newsscout--0000023`，Single/min=max=1；19:11:27旧副本归零、19:12:37新副本健康、19:13:36完成交接，约70秒维护区间。仅image/release ID改变，认证和其余配置保持 |
| 数据与模型 | 现场34份迁移校验和及11项保护指纹匹配；本人当期7条的完整保存版、截止时间、往期及日版门槛不变。4篇真实模型v1图解与尝试/保存审计/当前API一致，未观察到真实v2实例 |
| 实际资源 | 40份前端资源SHA-256逐项一致；首页/健康200，匿名session及学习设置401；Node22.23.2完成最终检查 |
| 报告文章复现 | 已授权真实文章组成7行首页列表，2000/390分别21/36行完整要点；外壳scrollTop和工具栏top均为0，面板scrollTop为647/1257，首点获焦且在工具栏下，背景不变 |
| 实际当期首页 | 原有7条保存版配合已取得的当前详情，1440/390分别19/30行要点；外壳和工具栏仍为0，面板scrollTop为853/1048。不是把雷达或单篇页面当作首页验证 |
| 完整交互 | 四个场景均核对SVG文字边界/重叠、依据键盘展开、可用正文页签或真实blocked来源的摘录回退、上一篇/下一篇、关闭后的触发焦点和列表位置。最终0非预期页面/接口错误 |
| 恢复兼容 | ACR `ckw`文字界面/提示组合保留当前v2数据类型和解析，180项输入冻结；11项摘要和1项新隔离云端合同通过，含v2保存/API/快照。7种完全离线维护场景通过，未在云端执行恢复 |

最终证据为 `r23-frontend-verification.private.json`、`r23-deployed-browser-v4.log`、`r23-outcomes.private.json`及`deployed-assets`下匹配场景的截图。浏览器所有私有接口均本地替换，0实际私有调用/应用写入；只有有界本人维护GET读取真实数据并正常更新last-seen。390系统偏好深色仍实际显示浅色，每档捕获1次既有内联脚本CSP拒绝；这不是云端深色、真人登录、真机或全站无障碍验收。

部署夹具迭代没有改产品代码或重复发布：先补上遗漏的`GET /api/v1/briefs`历史列表替身并保留实际来源上下文，再用当前详情而非保存版预览验证文章；最后按真实`blocked`状态断言原有摘录回退，不能因为还留有旧body就强求正文页签。首轮截图/失败、v2/v3日志仍保留，不混入最终四场景通过数。来源正文投影最多16000字符，超出时标注截断；没有额外抓取来源或调用模型。

本地与恢复的临时PostgreSQL使用55489并已停止，不连接日常schema27。恢复时不得直接使用旧r22/`cku`；schema相同不代表旧类型能读取v2流程/时间线，实际不可变镜像及维护限制见Azure手册第8节。
