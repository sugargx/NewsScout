# 测试与证据指南

适用版本：0.2；维护日期：2026-09-17。只使用项目已有 TypeScript、Vite、Rust 和 Playwright 工具。文档修改不需要构建应用或运行真实采集；代码变更选择覆盖该行为的最小范围。

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
| 阅读布局、层级、三视图、焦点、长文字 | `editorial-reader.spec.ts` |
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

组件发布分组使用 Rust 的 `coverage::tests` 与隔离启动器的 `-TestPattern 'component release groups'`。`release-families.spec.ts` 不再依赖实时 RSS 永远保留某几个旧版本：第一项创建明确标为合成的九条组件材料，覆盖三个分组、CLI/SDK/Provider 身份、过滤、分页、访客读取和独立隐藏/撤销，结束后清理；第二项只读恢复语料中的2026年9月18日实际版本，并采集1440/1024/768/390的紧凑/卡片布局。

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
