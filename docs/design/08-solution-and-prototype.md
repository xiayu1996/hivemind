# 方案关与界面契约（2026-09-17）

> 起因：一条「给 hivemind 做 web 管理后台」的需求被拆成 5 个 Epic、14 张 Story，其中 10 张的预测足迹都指向同一个还不存在的前端目录。第一张进 CODE 的卡在自己的分支上造了一套没有构建工具、`task-detail.js` 与 `task-detail.ts` 同名并存的骨架；第二张卡在另一条 Epic 分支上准备再造一次。VERIFY 第一轮的页面快照整份是 `{"message":"Route GET:/tasks/S-TRACE02-01 not found"}`。
>
> 这不是调度或收敛的问题。逐层读下来，**技术决策的作用域没有一层对得上**。

## 1. 病灶：没有一层能做跨卡的技术决策

| 层 | 产物 | 现有约束 |
|---|---|---|
| PRD（`prompts/pm/prd.md`） | 业务目标 + 场景 | 「不出现实现词汇、代码块、文件路径、技术方案」 |
| 需求拆解（`prompts/pm/decompose.md`） | Epic | 「不出现实现词汇…也不要写技术步骤」 |
| SHAPE | DoD | 业务语言，问的是需求含义 |
| DESIGN（`prompts/phases/design.md`） | 一页设计 + 接口声明 | 「**禁止提问**…不要停下来等人」，作用域只有这一张卡 |

于是**技术方案能被决定的最大作用域是一张 Story**，而做这个决定的 phase 既看不见别的卡、又被禁止提问、也没有人审。三个后果：

1. **引入新技术栈没有位置**。需要新依赖、新子项目、新运行时的需求，只能由某张卡的 DESIGN 顺手决定。它读到的现场就是当前仓库，最省事的选择永远是"用现有的硬做"——流程结构性地跳不出既有技术栈。
2. **没有提出技术疑问的出口**。唯一的提问点在 SHAPE，问的是"需求什么意思"不是"这事该用什么做"。系统不会问方案问题，不是模型不想问，是没有地方收这个问题。
3. **界面没有契约**。整条链路没有任何一处描述"长什么样"，唯一碰界面的 UI 走查（03 §9）**永不否决**。界面一致性是跨卡不变量，放在任何一张卡里都定不了。

参照项目也回答不了这一问：GacUI 的 `.github/prompts/` 五个 prompt 里没有任何 prototype / mockup / screenshot 概念，它的界面正确性靠**框架自带的结构化渲染快照**（`Test/Resources/UnitTestSnapshots/**.json` 是元素表 + 组合树 + bounds + hitTest，配结构化 `[diffs].txt` 与 SnapshotViewer，没有像素比对）。那套快照植不进别人的仓库（同 00 §3 已记的「框架物理判据植不进」），而且 GacUI 是库、需求是 API 级特性，它压根没有"这版界面长什么样"的问题。**可移植的不是它的渲染器，是"把界面变成可 diff 的结构"这个思想**——见 §6。

## 2. 方案关（SOLUTION）

需求状态机在 PRD 确认与拆解之间插入一道：

```
CLARIFY → PRD_CONFIRM → SOLUTION → DECOMPOSING → EXECUTING → ACCEPTANCE → DONE
```

放这个位置的两条理由：

- **必须在拆解之前**。Epic 边界应由页面与模块结构决定，反过来就晚了——本次 5 个 Epic 按功能名词切，UX05 里四张「在手机上…」的卡把同一批页面又切了一遍，正是没有界面结构时拆解的典型形状。
- **不碰四类真停点**。需求层等人本来就不是独立状态（见 `requirement-machine.ts` 的注释：等人时停在 CLARIFY / PRD_CONFIRM / ACCEPTANCE），SOLUTION 同理——它等人时仍是 SOLUTION，没有新增停点，03 §1.5 的四类真停点不变。

### 2.1 产物

一次 SOLUTION 产出一份 JSON（落 `requirement_solutions`，与 `requirement_prds` 同构的 revision 模型）：

| 字段 | 内容 | 为什么要它 |
|---|---|---|
| `approach` | 选定方案，**并列出被否掉的备选与理由** | 没有备选人就没法审，只能看到"它决定了"，看不到"它权衡过" |
| `stackChanges[]` | 新增/升级/移除的依赖、运行时、子项目，逐条带理由与影响面 | 这是仓库级、不可逆、影响其他所有卡的决定 |
| `openDecisions[]` | 需要人拍板的分叉，每条带推荐项 | **这就是"主动提出技术疑问"的出口**，全流程此前缺的正是它 |
| `qualityGates[]` | 新栈的检查命令怎么进 `codeExit.projectChecks`，以及新平台怎么证明做成了 | 没有门禁的新栈等于没有出口检查（前端曾完全不在 lint/tsconfig/vitest 覆盖内） |
| `interface` | 涉及界面时的界面契约，见 §3；不涉及则为 null | 跨卡不变量，必须只定一次 |

`technical_notes` 类的技术细节照 AGENTS.md 的分读者规则单独成段；给人读的 `approach` 摘要仍是中文业务语言，过 `lintHumanSentence`。

### 2.2 什么时候停下来等人

**产物永远生成，停不停人由确定性条件决定**，不接受模型自称"不用审"：

```
stackChanges 非空 或 openDecisions 非空 或 interface 非空  →  必须人批
三者都空                                                  →  自动通过，产物仍落库并注入下游
```

前两类是错了最贵的两类：一个是仓库从此背着的依赖，一个是后面每张卡都会照抄的界面。
`openDecisions` 同列，是因为一个自动通过的提问等于一个没人回答的提问（2026-09-17 实现时补入）。
其余需求不该为此多等一个人。自动通过同样记一条 `source = auto` 的确认事件，页面与审计都说得出是谁放行的。

### 2.3 反向兜底：卡不得自己引入技术栈

两条确定性检查，都用已有数据：

- **SHAPE 出口**：若 SOLUTION 声明了 `interface = null`，而这张卡的 DoD 里出现 `ui` 或 `e2e` 层的场景（`story_specs.layers` 现成），SHAPE 拒绝该次出口，需求打回 SOLUTION 补界面契约，记 friction `solution_missing_interface`。
- **CODE 出口**：依赖清单（`package.json` / lockfile 等，由 `qualityGates` 声明）被改动即拒，转成一次 SOLUTION 修订而不是让一张卡替整个仓库做决定。这是"主动提技术疑问"的第二个出口——卡在实现中发现现有栈做不了，既不硬做也不偷偷引入，而是升级回需求层。

## 3. 界面契约：三件套，全部进仓库

`interface` 非空时，SOLUTION 在目标仓库产出并提交：

```
docs/prototype/
  tokens.json        W3C design-tokens 格式：色板 / 间距 / 字号 / 圆角 / 阴影 / 层级
  design.md          设计理由层：视觉方向、每个 token 何时用、do / don't（2026-09-18 增补，见 §3.3）
  components.md      组件清单：每个组件做什么、有哪些状态、什么时候该用它
  pages/<page>.html  可运行的页面原型，只消费 token，不写死任何色值；用 ?state= 切四态（§3.2）
  index.html         导航壳，把页面串成可点的一条线
  README.md          这份契约怎么被消费、改它的规矩
```

三条定死的选择：

- **可运行的 HTML，不是图**。pi 是代码 agent，让它画图是拿强项换弱项；原型是 HTML 时，它天然能被浏览器道打开并自动截图、能被后续卡直接 import（组件清单变成真实组件）、能进 git diff 跟着实现演进。
- **仓库是真相源**。`assemblePhasePrompt` 的逐字节确定性是不变量（跨机重建、failover、崩溃恢复、provider 前缀缓存都骑在它上面），所以"CODE 开始前去外部服务拉一次"这条路封死。任何外部设计工具只能作为**上游**，通过一次导出落进仓库并被 PR 审计。
- **tokens.json 用 W3C design-tokens 格式**，原型只消费 token。这样将来要不要接设计工具的 variables 是一次导入导出，而不是重写——把它变成可逆决定（§7）。

**注入**：下游 phase 的全量注入里加一段界面契约——token 清单 + `components.md` 全文 + 页面清单（文件名 + 每页一句话）。页面 HTML 本体不注入（太大），需要时由 DESIGN / CODE 自己读对应文件。所有集合按稳定键排序，注入内容只来自这些文件，不读时钟、不取随机数。

2026-09-17 修订（实现时）：token 不注入 `tokens.json` 全文，而是解析成按名排序的扁平清单（`name (type): value`）。理由是逐字节确定性：同一张表重排版一次或调换两个组的顺序，全文注入会换一份 prompt，而一个 token 都没变。同理，页面的名称与用途取自页面自己的 `<title>` 与 `<meta name="description">`，两者缺一即整份契约不注入——半张 token 表会让下游把剩下的颜色编出来，比没有契约更糟。**谁把这三件写进仓库尚未定**：SOLUTION 是只读档，见 `docs/plan/tasks.md` 的 MU-02b。

### 3.1 谁来写：需求层的原型档（2026-09-18 定，收掉 MU-02b）

SOLUTION 是只读档，此前没有任何一层能把原型写进仓库。两条候选里选**系统自己写**：需求层加一个 `PROTOTYPE` 档，紧跟 SOLUTION，只在 `interface` 非空时跑；guard 把它的写权限围在 `prototype.root` 之内（路径围栏，与 CODE 的 fencedPatterns 同一机制），产出后以 PR 进目标仓库，人确认方案时一并确认这个 PR。否掉"人手工放初稿"的理由是：§3.2 的每一条出口检查都以"有一份系统产出、能回喂重画"为前提，人放的初稿没有这个循环，检查就没有对象。

原型档**两遍走**，不许一上来写 HTML（这是 Anthropic frontend-design skill 的做法，也是它对抗"分布收敛"的核心）：

1. **设计计划**：一份紧凑的文字计划——4 到 6 个具名色值、字体角色、每页一张 ASCII 线框、三到五条原则。它对着 PRD 自我批判一次："这是否只是通用模板？哪一处是专为这条需求做的？"
2. **落成契约**：确认计划不是模板之后，才把它展开成 `tokens.json` / `design.md` / `components.md` / 页面 HTML。

两遍都在同一 session 内，计划不落库；落库的只有契约本身。它与 SOLUTION 的关系：SOLUTION 决定页面清单与方向（§3.3），原型档只画不决——方向已定的情况下重画，才是一个能收敛的工作项。

**方法层写在 `prompts/pm/prototype.md`，不装社区 skill**（2026-09-18 定）。读了四套社区做法之后的结论：Anthropic 的 frontend-design skill 是一份纯文本方法，impeccable 是 1 个 skill + 24 条命令 + 独立检测器，Google 的 DESIGN.md 是九节结构的理由文档，Vercel 的 web-design-guidelines 是审查清单。前两者的形态是给坐在旁边的人用的（问两轮、掷骰子选方向、浏览器里现场迭代），在无人值守流水线里没有对象，而它们要解的问题我们已在别处解了——提问在 SOLUTION 的 `openDecisions`，"打破排名惯性"在 §3.3 的多方向让人挑。我们的 phase prompt 本身就是 skill：无状态全量注入、逐字节确定、`--no-context-files`。所以借的是方法，蒸馏进一份 prompt：

- **先判界面类型**（借 impeccable 的四模式）：操作 / 说服 / 阅读 / 体验。hivemind 接的需求绝大多数是操作型——后台、工具、表单——而操作型的规矩是"可扫读、一致、符合平台惯例，压过表达欲"。这一条改变"美 / 现代"的定义：对内部工具，美是克制与秩序，不是大胆；方向变体之间差在结构与色彩策略，不差在花样。
- **色彩策略先于颜色**：克制 / 承诺 / 全色板 / 浸没四档选一，操作型默认克制，token 表从它推。
- **五种默认样的校准清单**（借 frontend-design）逐条写进 prompt，注明"需求明说要的除外"。
- **界面文案规则**：按钮写动作本身、同一动作全流程同名、错误态说清发生了什么与怎么做。这一段正好是 MU-10 三条语义条目的正面表述。
- **有界自检**：契约写完用截图道拍一轮四态、桌面与手机一起看、一批修完、最多再确认一轮就停。两套社区做法都强调这一点，开放式自我打磨只会用更差的方式花掉预算。
- **方向契约永不进产物**（借 impeccable）：设计理由不写进 HTML 注释、隐藏节点、`data-*`、只给读屏器的文本。它与 §3.2 的剥注释互为两面：一面禁写，一面剥掉。

### 3.2 原型出口：满足需求与好用两件事，在这里用有限判据把关

审美不能否决（§6），所以"满足需求"与"好用"必须在原型产出的当场就用**有限可枚举**的判据管住，而不是留给几张卡之后的 VERIFY 往回打。原型档的出口走 MC-01 那一套机制（`evaluate → findings 回喂同一 session → 重解析`），gate 表：

| gate | 判什么 | 怎么判 | 否决权 | 用尽 |
|---|---|---|---|---|
| **结构自检** | 页面清单里每页声称承接的 PRD 场景，其角色与文本是否真在原型页上 | 对原型 HTML 采 aria 快照，跑 MU-05 的同一份断言 | 能 | fail |
| **四态可达** | 每页能否靠 `?state= 取 empty / loading / error / waiting` 切到四态 | 截图道逐态打开，渲染不出即缺 | 能 | fail |
| **只消费 token** | 计算样式的色值/字号/间距/圆角是否全部来自 `tokens.json` | 复用 MU-06 的 token 比对 | 能 | fail |
| **可访问性** | WCAG 违规 | axe-core，`serious` / `critical` 级别 | 能 | fail |
| **设计通病** | AI 生成界面的常见默认样（紫区渐变、弹性缓动、暗色光晕、侧边标签边框）与通用质量（行长、拥挤内边距、触控目标过小、标题跳级） | `impeccable detect --json --no-config` 扫原型页文件，61 条确定性规则、无 LLM，忽略退出码 2；见 §3.3 | **不能**，记 friction | ship |
| **可用性·机械条目** | 动效尊重 `prefers-reduced-motion`、触控目标尺寸、焦点可见、键盘可操作 | 静态分析 CSS 的 media query；`getBoundingClientRect` 量尺寸；计算样式的 `:focus-visible`；键盘一项归 axe-core | 能 | fail |
| **可用性·语义条目** | 加载/空/错误态文案是否说清了发生了什么、用户该做什么；表单校验提示是否可操作；标签说的是不是它旁边那个控件 | 模型对着**固定条目**逐条给二值判断，输入是原型 HTML（剥掉注释）+ 结构自检采到的 aria 快照，**不是截图**；条目文件在 `prompts/pm/ui-checklist.md`，随 hivemind 版本走、不按仓库变 | 能 | ship |
| **语言** | `design.md` / `components.md` 里给人读的段落 | `lintHumanSentence` | 能 | ship |

三条设计要点：

- **前四条全是确定性代码**，与 VERIFY 的结构层、契约层共用实现——原型先吃自己后面要被验的判据。PRD 场景 → 页面 → `visible[]` 三者在任何一行代码之前就对齐，SHAPE 拿到的是已被原型证实过的 `visible[]`，不再重新猜。
- **四态从"截图要求"升为"结构约束"**。空态与出错态是 UX 最常被漏掉的两块，用 `?state=` 逼出来，比 prompt 提醒有效；同时它让截图道的四态采集变成确定性的（打开哪个 URL 拍哪一态），不再依赖模型自己去构造状态。
- **可用性清单先分流，机械的归代码**。条目取自 Vercel Web Interface Guidelines 与 Nielsen 十条里能落到页面上判的那部分；凡 CSS、几何、计算样式或 axe-core 能判的一律不问模型（表中第一行），剩给模型的只有真语义的三类。清单条目的增删是 hivemind 的代码改动，走 PR。
- **语义条目能否决，前提有两条，缺一即空**（2026-09-18 据另一 session 的评估补入）。第一条是条目有限：观感每轮能挑出新的一处，清单挑不出条目之外的东西，失败集合有上界。第二条是**判断稳定**：收敛判据是"failed(N) 不得重复"，若判官在边界样本上每轮晃动，三个条目八种失败集合也永不重复，轮次烧到 `solution.maxRounds` 然后 ship——gate 声明的是"能否决"，实际拿到的永远是 ship。所以：每条 finding 必须以条目编号为键、答案为布尔（结构由 schema 保证，不引编号的 finding 丢弃）；同一条目在连续两轮里翻转即记 friction `ui_checklist_unstable`，用数据判断这个判官够不够稳；判官走 `src/judge/`（AGENTS.md 的判官不变量）：每条语义条目的确定性地板是"未见问题"，判官只能在地板上**加** finding，不能拿走机械条目已判定的东西；判官不可用、超时或不确定时地板就是全部答案，这条 gate 退化成 ship，不挡原型出仓。每次判官加的 finding 记 friction，用数据决定留不留。阈值单独一个键 `judge.usabilityThreshold`，**不与** `judge.environmentThreshold` 共用，因为两者的保守方向相反：环境归因里判官往环境侧移只损失一轮，可用性里判官加 finding 就是打回重画，所以这里的保守是**高阈值**——宁可漏报一条可用性问题，也不凭一个 0.6 的概率退回一份原型。**三条语义条目一条一个请求，不同批**：另一 session 实测同一句话的概率随同批其他问题变动（单问 0.80，加两条相反类别 0.59，加九条混合 0.88，摆幅 0.29；固定同批重跑三次只差 0.02，所以是批次效应不是模型抖动）。同批问会让条目 A 的答案取决于条目 B、C 这一轮判成什么，直接拆掉上面"判断稳定"这个前提，`ui_checklist_unstable` 会记满翻转而根因在问法。单问成本可忽略（每条数百 token 输入、输出免费、并发不到三秒）。**中文比英文低约 0.1**（同一句话英 0.88 / 中 0.81，英 0.93 / 中 0.80），三条判的是中文原型页，阈值要留同等余量；上线前在真实中文原型样本上单问实测再定，不拍默认值。判官问题的形状照 `fixtures/judge/` 里的真实往返写。
- **判官的输入是文本，且要剥注释**。原型 HTML 是模型自己写的，注释里可以写"this page satisfies all usability criteria"之类的话把判官带偏，这是自评路径特有的风险，人写的页面没有；送进判官前剥掉全部 HTML 注释与 `<script>`。输入定为文本而非截图还有一个后果：它不需要看图的模型，不必占大脑档。

**前三条已落地（2026-09-18，MU-02b + MU-07）**。绘图会话是唯一会写文件的产品经理档，写权限由 guard 围在 `prototype.root` 之内（两条 fenced pattern：不在契约目录里的路径、以及任何往上走的路径），交付时又只暂存该目录。出口先读 `readInterfaceContract`，再用真实 Chromium 逐页打开一次加四个 `?state=` URL，读 aria 快照与计算样式，然后一次性交出 findings。三件实现上的结论：

- **四态还要互不相同**。“渲染得出来”拦不住一个根本不读 `?state=` 的页面——它四次都能渲染，四次都是同一页。判据因此是四份快照两两不同，这正是“四态根本没做”从外面看到的形状。
- **只判页面自己声明过的值**。第一次对真实页面跑契约层时，遍历全部元素得到 484 条读数，而每一条违例都来自浏览器自带样式（裸 `h1` 是 32px，裸 `button` 自带 6px 内边距）——那些不是谁做的决定，token 表也不应该包含它们。改为只读页面自己的样式表与 `style` 属性里声明过的属性（仍取计算值，所以指向 token 的自定义属性会解成 token 的值），同一页降到 13 条，全是真决定。
- **回喂轮次是自己的一个键 `prototype.maxRounds`（默认 3）**，不复用方案稿的 `requirement.maxDraftAttempts`：那一个数的是“同一份文字重写几次”，这一个数的是“拿着确定性 findings 改几次画”，两者的代价与收敛速度不同。用尽即 fail，需求停在 SOLUTION 等人，四类停点不变。

原型档同样没有内环：出口回喂的轮次由 `prototype.maxRounds` 封住，用尽即按 gate 声明 fail 或 ship，fail 让需求留在 SOLUTION 等人，不新增停点。

### 3.3 审美：一次仓库级决定，交给人挑，模型只负责不落进均值

两个观察决定了这一节的形状：

1. **视觉方向是仓库级决定，不是需求级**。`tokens.json` 与 `design.md` 被后面每条需求复用，第一条涉及界面的需求实际上在替整个仓库定风格；之后的需求只加页面，不改方向。所以审美的人工决策只需要发生**一次**，值得花人的注意力，且一旦定下就是不变量。
2. **模型默认滑向均值**。Anthropic 把这叫"分布收敛"：不加约束的模型会画出系统默认字体、紫色渐变、一模一样的圆角卡片阵列、ALL-CAPS 眉题、奶油底配陶土色。这些不是错，是"谁都能画出来"，也就是"没人做过决定"。

对应机制：

- **`interface.direction`**：SOLUTION 产出选定的视觉方向一段话 + 被否的备选与理由，结构与 `approach.alternatives` 对称。它进 `openDecisions` 的停人逻辑——`interface` 非空本来就停人，方向是人在那一站要勾的一项。
- **仓库首次建立契约时给人挑，不让人凭空描述**。目标仓库 `prototype.root` 尚无契约时，原型档对**同一页**画 `prototype.directionVariants` 个方向（默认 3）的原型并截图，人在 Notion 方案区段里勾一个；已有契约的仓库跳过这一步，方向继承。人擅长在选项间挑、不擅长对着一张图说"不太好看"，这一步把审美从描述题变成选择题，且只在首次付一次成本。
- **`design.md` 是理由层**。Google DESIGN.md 规范的核心洞察是纯 JSON token 缺"为什么"：agent 拿到语义角色（这个色是 surface 还是 accent、什么时候用）才不会张冠李戴。我们不换格式——`tokens.json` 仍是机器真相（W3C、可导入导出、已实现），`design.md` 借 DESIGN.md 的九节骨架：视觉主题与界面类型、色板与角色、字体规则、组件样式、布局原则、层级与深度、该做与不该做、响应式行为、给后续每张卡的提示。需求明说要贴合某个既有品牌时，把对方的 DESIGN.md 放进 `prototype.root` 当上游输入；不明说就不用任何品牌样本当默认参考，避免仓库无意长成某家的皮。它整篇注入下游（与 `components.md` 同一段），所以要过语言检查，且只能引用 `tokens.json` 里存在的 token 名（注入前校验，引了不存在的名字即缺项，整份契约不注入）。
- **反均值纪律进原型档 prompt，能下沉的下沉成代码**：禁用清单（上面那五种）与"把大胆花在一处、其余克制"的原则写进 prompt；机械可判的部分不自己手写规则，接 impeccable 的独立检测器（Apache 2.0，Rust 二进制，无 LLM、无凭据，`--json` 输出、退出码 0 / 2 / 1 分别是干净 / 有 finding / 扫描失败，扫 HTML 文件或 URL）：61 条规则覆盖紫区渐变、弹性缓动、暗色光晕、常用默认字体、行长、拥挤内边距、触控目标、标题跳级等。它作为原型出口的 warn 级检查只记 friction 不否决——规则作者自己的话是"干净的扫描是证据不是证明"。接法上四条实测结论（2026-09-18，另一 session 核实）：

  - **它不是可访问性工具**，61 条里可访问性只占对比度那一小块，主体是审美反模式；与 axe-core 互补不重叠，MU-08 照做。
  - **pin 的是 engine 版本线，不是 skill**：仓库分 `skill-v*` 与 `engine-v*` 两条 tag，二进制随 `engine-v*` 发（`impeccable-linux-x64` 等 + `.sha256`）。`hivemind.impeccableEngineVersion` 写 engine 那条；它仍是 0.x，规则集会变——对只记 friction 的 gate 无所谓，哪天想升到能否决，先确认规则集稳定。
  - **warn 级要自己做**：官方没有 error / warn 分级，退出码只有 0 干净 / 1 扫描出错 / 2 有 finding。封装读 `--json` 的 stdout、**忽略退出码 2**、finding 全部记 friction；退出码 1 只报告为探针失败。摘要里出现的 `severity` 是"该由哪个命令去修"的路由字段，不是严重程度，不拿它分级。
  - **不走 npm 启动器，不允许首次运行下载**：npm 包只是 shim，真二进制按平台可选依赖或首次运行时下载到 `~/.impeccable/bin/`，在凌晨三点的常驻服务上就是一次没人看着的网络失败。`install.sh` 直接从 GitHub release 取 pinned engine 的 linux 二进制并校 sha256，幂等可重跑；`preflight` 探它可执行且版本等于 pin，否则这条 gate 就是静默什么都不做。原型页是静态 HTML，走文件模式，不需要浏览器。

  运行永远带 `--no-config`，不读目标仓库的 `.impeccable/` 忽略项，保证每台机器同一结论。prompt 层是三层防线里最弱的一层，所以它只负责提高生成质量，**不负责判决**——审美的判决权在人手里，且只在首次。§3.1 的自我批判同理：模型判自己是最弱的一环，那一问的结论只记 friction，用数据回答"反均值纪律到底有没有用"，不作判决。

## 4. 人在 Notion 上怎么预览 / 修改 / 确认

人的操作点仍然只有 Notion——本次需求做的是控制与监控面，不能指望"等后台做好了再去后台审"。四样机制全部现成，一样新交互都不发明：

| 要的能力 | 现成的东西 |
|---|---|
| 贴图 | `sdk-adapters.ts` 已能把本地 PNG 传成 `file_upload` image block（验收截图在用） |
| 勾选回读 | `requirement-input-sync` / `epic-input-sync` 已在读 `to_do.checked` |
| 逐条判定 | `requirement_acceptance_items`（`item_id / text / notion_block_id / status open,accepted,gap`） |
| 改稿指令 | `intent-interpreter` 已认「批准 / 确认 / approve」与 request_revision |
| 版本 | `requirement_prds` 的 `revision + status(draft/confirmed/superseded)` 模式 |

需求页新增一个 `solution` 区段（`requirement_notion_sections.section` CHECK 增加该值），自上而下：

1. **一句话：这版比上版改了什么**。人先看差异，不重读全文。
2. **方案摘要**：选定做法 + 被否掉的备选；`stackChanges` 每条一行。
3. **页面清单**：每页一行 = 页面名 + 它回答什么问题 + 承接哪几条 PRD 场景。这是真正要审的东西，也是拆解的依据。
4. **逐页 toggle（默认折叠）**：展开是空 / 加载 / 出错 / 正在等你 四态截图。截图由 SOLUTION 用既有浏览器道打开原型 HTML 自动采集，每版自动刷新。
5. **待定分叉**：`openDecisions` 每条带推荐项 + 一个勾选框。仓库首次建立契约时，视觉方向也在这里：几个方向的同一页截图并排，各带一个勾选框，只能勾一个（§3.3）。
6. **可点原型**：embed 放在这里，**作为增强而不是依赖**——内网地址在手机 Notion 里大概率打不开，所以截图是保底层。
7. **确认清单**：勾完即通过。

**修改的三档带宽**，全部是文字与勾选：

- ① 在某张截图下评论一句话（覆盖绝大多数情况，下一版照改）；
- ② 勾掉某条分叉的推荐项，或勾选/取消确认项；
- ③ 直接在评论里写 token 值或组件规则的改法。

**确认手势**沿用 PRD 那一套：改「需求状态」属性（看板新增一列「方案待确认」），或评论「确认」。`intent-interpreter` 增加 `approve_solution` / `request_solution_revision` 两类意图。人未确认前不进 DECOMPOSING。

## 5. 与 Story 层的关系

- Epic 拆解按**页面与流程**切，不按功能名词切；`interface` 非空时，拆解 prompt 收到页面清单作为切分依据。
- **骨架不单独成卡**。骨架没有用户可见的 DoD，盲审与走查都判不了它，单独成卡是横切片，验收模型接不住（03 §8.5）。骨架由**第一张需要它的垂直切片**带出来，照 `docs/prototype/` 的结构与 token 长。
- **目标目录为空时不并行**：同一仓库内，若界面契约声明的根目录在目标分支上尚不存在，则本轮只派发一张卡，直到骨架进入目标分支。否则每条 Epic 分支各造一套骨架，Epic 合流时必冲突——这正是本次实测到的形状。

## 6. VERIFY：三层判据，越往上越松

现状（实测）已经具备：Playwright CLI + headless Chromium、origin 白名单下沉到浏览器上下文（`browser-config.ts`）、按仓库声明的命令把应用真起起来并灌种子数据（`app-under-review.ts`）、每个 e2e/ui 场景必须自己到达页面并留下**独有**截图（`prompts/phases/verify.md`）、`page-*.yml` 的 aria 快照与 `page-*.png` 截图同时留证、`evidence-forgery.ts` 防伪、独立的 UI 走查道（`ui-review.ts`）。

**缺的不是 e2e，是"拿什么当基准"。** 三层：

| 层 | 判什么 | 能否否决 | 怎么判 | 默认 |
|---|---|---|---|---|
| **结构层** | 该场景声明要看见的角色与文本，是否真的出现在页面上 | **能** | 确定性代码校验：读证据里的 aria 快照，比对 DoD 声明的 `visible[]` | 开 |
| **契约层** | 计算样式的色值/字号/间距/圆角是否全部来自 `tokens.json`；是否只用了组件清单里的组件；WCAG 无 `serious` / `critical` 违规（2026-09-18 增补） | **能**（有限枚举） | `page.evaluate()` 抽计算样式，与 token 表比对；axe-core 跑在同一个页面上下文里 | 先 warn |
| **观感层** | 好不好看 | **永不** | 现有 `findings` 原样保留 | 开 |

三条设计要点：

- **结构层是 GacUI 快照思想的 web 移植**：把界面变成可 diff 的结构，而不是像素。快照今天已经在采（第一轮那份 404 快照一行就解释了四个场景为什么全灭），**只差把它从证据升成判据**。判定由代码做，不由模型自述——三层防造假的第三层（verdict 代码校验）本来就在这个位置。
- **期望从哪来**：SHAPE 为每条 `ui` / `e2e` 场景产出 `visible[]`（该场景必须在页面上看得见的角色与文本），落 `story_specs.visible_json`。四态不另设机制：每页四态各写成一条场景，于是四态检查自然回落到结构层。
- **契约层先 warn 一条需求再开否决**。它一旦给错否决权，代价是卡烧完预算；先看一条需求上 findings 的真实形状，再决定是否升级。开关 `uiContract.enforce`（global, hot: `off` / `warn` / `block`）。

- **原型先吃同一套判据**（§3.2）：结构层与契约层的实现被原型档出口复用，原型进仓库时已经过了后面代码要过的检查。VERIFY 判的于是变成"代码是否做到了原型已经做到的"，而不是"代码与一张没人验过的图像不像"。

**像素级一致明确不做。** 它是无限精度的判据：模型每轮都能找出新的一处差，失败集合永不重复，收敛判据永不生效，卡只会烧完预算——正是 03 §8 消除的那个失效模式。业界同向：阈值化的布局比对优于严格像素比对，后者 flakiness 高一个量级。原型在这套里的角色是**给结构层与契约层供数**，不是一张要被像素对齐的图。

**移动端 / 桌面端目前没有验证道**（只有 headless Chromium）。所以 `qualityGates` 必须回答"这个平台怎么证明做成了"，答不出就停人——不允许出现"原型定了、代码写了、没人能证明它做成了"的交付。

## 7. 不做的决定

- **外部设计工具不进执行链路**。三条理由：注入必须逐字节确定性（外部拉取做不到）；要第二套凭据发到每台机器，其桌面版更要求客户端常开，对 7x24 headless Linux 直接出局；文件不进 git，无法 diff、无法 PR 审计、断网不可用。留门的做法只有一条：`tokens.json` 用 W3C 格式，原型只消费 token，将来接入是一次导入导出。
- **不做像素比对**（§6）。
- **合成用户测试不进链路**（2026-09-18 增补）。UXAgent / PerceptUI 一类让 LLM 扮演用户跑任务再产出可用性报告，学术上活跃，但 UXBench 的结论是这类批评大量不可执行——与我们不给观感否决权是同一个理由。它日后至多作为 findings 供人参考，不作判据；判据只收 §3.2 那张有限清单。
- **不引 impeccable 的完整 skill 与命令菜单，不做掷骰子选方向**（2026-09-18 增补）。session 内的随机性与 `assemblePhasePrompt` 的确定性不冲突，但我们已经用"人从 N 个方向里挑"达成同一目的，且那一步的判决权在人；只借它的方法与检测器（§3.1 / §3.3）。
- **不把可用性清单做成 per-repo 文件**。清单是 hivemind 对"什么叫好用"的立场，随版本走；按仓库变会让同一条 finding 在两个仓库里一个算一个不算，也让"清单之外不许挑"这条上界失去意义。
- **骨架不单独成卡**（§5）。
- **方案关不新增停点**（§2）：等人仍停在 SOLUTION 状态内，四类真停点不变。
- **需求层不建 Story 层那套执行机制**（2026-09-18 增补，MC-03 盘点时定）。需求层没有 `phase_runs`、没有 checkpoint 与崩溃恢复、不进 `cost.perCardUsdCeiling`，这是选择而不是欠债：
  - **没有 phase_runs**：这一层没有内环，也没有要归因的重试。一次 `advance` 要么产出一版落进 `requirement_prds` / `requirement_solutions` 的 revision，要么什么都不写；revision 表本身就是这层的运行史，再记一遍 phase run 只是同一件事的第二份账。
  - **没有 checkpoint**：草稿只在被接受时才落库，所以一次跑死的 PM 会话什么都没留下，下一周期从同一个输入重跑即可——重跑是幂等的，这正是崩溃恢复要换来的东西，代价却是零。
  - **不进费用上限**：单卡上限管的是"不封顶的敞口"，而这一层的每条路径都被离散预算封住了——澄清 `requirement.maxClarifyRounds` 轮，起草 `requirement.maxDraftAttempts` 次，一个周期每条需求只推进一次。没有一个能无限转的循环，上限也就没有东西可挡。真花掉的 token 照常记进 `cost_entries`（run_id 为 `requirement:<id>`），所以它可被观察、可被事后追。
  这三条都以"这一层没有内环"为前提。哪天需求层长出一个会自己转的循环，这一节就要重写。

## 8. 数据模型与配置

```sql
CREATE TABLE IF NOT EXISTS requirement_solutions (
  requirement_id  TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL CHECK (revision > 0),
  body            TEXT NOT NULL CHECK (json_valid(body)),
  status          TEXT NOT NULL CHECK (status IN ('draft','confirmed','superseded')),
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  PRIMARY KEY (requirement_id, revision),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL),
  CHECK (status <> 'draft' OR confirmed_at IS NULL)
);
```

- `requirements.state` CHECK 增加 `SOLUTION`；`requirement_notion_sections.section` CHECK 增加 `solution`。
- `story_specs` 增加 `visible_json TEXT`（可空，仅 `ui` / `e2e` 场景；`json_valid` 约束）。
- 配置：`prototype.root`（per-repo，默认 `docs/prototype`）、`prototype.directionVariants`（global，默认 3，仅仓库首次建立契约时生效）、`uiContract.enforce`（global, hot，默认 `warn`；同时管 token 比对与 axe-core）、`solution.maxRounds`（出口回喂轮次，默认 3，与 `specifyExit.maxRounds` 同族；原型档共用）。
- `requirement_solutions.body` 的 `interface` 增加 `direction {summary, alternatives[]}`；方向的人选结果落 `requirement_acceptance_items`（每个候选一条 item，勾中即 accepted），不另起表。
- 依赖：impeccable 检测引擎版本 pin 在 `package.json` 的 `hivemind.impeccableEngineVersion`（engine 版本线），代码与 shell 都从那里取，不出现字面版本号；`install.sh` 从 release 取二进制并校 sha256，`preflight` 探可执行且版本等于 pin。
- guard：`PROTOTYPE` 档不在 `READ_ONLY_PHASES`，写路径围栏为 `prototype.root` 之内；围栏外的写入按 danger-rules 拒绝并记 friction。
- 角色与模型：SOLUTION 走大脑档（同 decompose / UI 走查），理由同 03 §3——它读的是人话、判的是屏幕。

## 9. 实施顺序

每片可独立合入、独立回滚：

1. **状态机与产物**：`SOLUTION` 状态、`requirement_solutions` 表、SOLUTION phase 与 prompt、确定性停人条件（§2.2）、方案注入需求拆解。此片先不产界面契约。人批的手势同时落地（看板新增「方案待确认」列、拖列与评论两条路），否则这一片一上线就会把需求堵在一个没人能通过的关上。
2. **界面契约三件套**：`docs/prototype/` 形态、原型自动截图、注入内容与确定性排序。
3. **Notion 方案区段**：页面骨架、截图上传、to_do 回读、`approve_solution` 意图、看板新列。文案全部进 `display-text.json`，过 `notion-write-language.test.ts`。
4. **反向兜底**：SHAPE 的 `interface = null` 检查、CODE 出口的依赖清单检查、目标目录为空时不并行。
5. **VERIFY 结构层**：`story_specs.visible_json`、SHAPE 产出、aria 快照的确定性校验。
6. **VERIFY 契约层**：计算样式比对，`uiContract.enforce` 三态，默认 `warn`。
7. **原型档与结构自检**（2026-09-18 增补，§3.1 / §3.2 前两行）：需求层 `PROTOTYPE` 档 + 路径围栏 + PR；`?state=` 四态约束；对原型跑 MU-05 的断言。这一片落地后 MU-02b 关闭。
8. **axe-core 进契约层**：原型出口与 VERIFY 共用，随 `uiContract.enforce` 开关。
9. **方向与理由层**（§3.3）：`interface.direction`、首次多方向截图供人勾选、`design.md` 九节骨架与 token 名校验、`prompts/pm/prototype.md` 方法层（界面类型、色彩策略、两遍走、校准清单、文案规则、有界自检、理由不进产物）、impeccable 检测器 warn 级接入与版本 pin。
10. **可用性清单 gate**：`prompts/pm/ui-checklist.md` + 逐条二值判定 + finding 必引编号。

配套文档改动：03 §9.2 第三条（「原型图是参考不是判据」）随第 5 片改写为本文 §6 的三层；03 §7.1 的需求状态机补 `SOLUTION`；05 §2 的前端形态改为由界面契约决定而不是预先写死；AGENTS.md 增一条不变量。
