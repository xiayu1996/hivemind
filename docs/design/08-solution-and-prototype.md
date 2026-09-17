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
  components.md      组件清单：每个组件做什么、有哪些状态、什么时候该用它
  pages/<page>.html  可运行的页面原型，只消费 token，不写死任何色值
  index.html         导航壳，把页面串成可点的一条线
  README.md          这份契约怎么被消费、改它的规矩
```

三条定死的选择：

- **可运行的 HTML，不是图**。pi 是代码 agent，让它画图是拿强项换弱项；原型是 HTML 时，它天然能被浏览器道打开并自动截图、能被后续卡直接 import（组件清单变成真实组件）、能进 git diff 跟着实现演进。
- **仓库是真相源**。`assemblePhasePrompt` 的逐字节确定性是不变量（跨机重建、failover、崩溃恢复、provider 前缀缓存都骑在它上面），所以"CODE 开始前去外部服务拉一次"这条路封死。任何外部设计工具只能作为**上游**，通过一次导出落进仓库并被 PR 审计。
- **tokens.json 用 W3C design-tokens 格式**，原型只消费 token。这样将来要不要接设计工具的 variables 是一次导入导出，而不是重写——把它变成可逆决定（§7）。

**注入**：下游 phase 的全量注入里加一段界面契约——token 清单 + `components.md` 全文 + 页面清单（文件名 + 每页一句话）。页面 HTML 本体不注入（太大），需要时由 DESIGN / CODE 自己读对应文件。所有集合按稳定键排序，注入内容只来自这些文件，不读时钟、不取随机数。

2026-09-17 修订（实现时）：token 不注入 `tokens.json` 全文，而是解析成按名排序的扁平清单（`name (type): value`）。理由是逐字节确定性：同一张表重排版一次或调换两个组的顺序，全文注入会换一份 prompt，而一个 token 都没变。同理，页面的名称与用途取自页面自己的 `<title>` 与 `<meta name="description">`，两者缺一即整份契约不注入——半张 token 表会让下游把剩下的颜色编出来，比没有契约更糟。**谁把这三件写进仓库尚未定**：SOLUTION 是只读档，见 `docs/plan/tasks.md` 的 MU-02b。

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
5. **待定分叉**：`openDecisions` 每条带推荐项 + 一个勾选框。
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
| **契约层** | 计算样式的色值/字号/间距/圆角是否全部来自 `tokens.json`；是否只用了组件清单里的组件 | **能**（有限枚举） | `page.evaluate()` 抽计算样式，与 token 表比对 | 先 warn |
| **观感层** | 好不好看 | **永不** | 现有 `findings` 原样保留 | 开 |

三条设计要点：

- **结构层是 GacUI 快照思想的 web 移植**：把界面变成可 diff 的结构，而不是像素。快照今天已经在采（第一轮那份 404 快照一行就解释了四个场景为什么全灭），**只差把它从证据升成判据**。判定由代码做，不由模型自述——三层防造假的第三层（verdict 代码校验）本来就在这个位置。
- **期望从哪来**：SHAPE 为每条 `ui` / `e2e` 场景产出 `visible[]`（该场景必须在页面上看得见的角色与文本），落 `story_specs.visible_json`。四态不另设机制：每页四态各写成一条场景，于是四态检查自然回落到结构层。
- **契约层先 warn 一条需求再开否决**。它一旦给错否决权，代价是卡烧完预算；先看一条需求上 findings 的真实形状，再决定是否升级。开关 `uiContract.enforce`（global, hot: `off` / `warn` / `block`）。

**像素级一致明确不做。** 它是无限精度的判据：模型每轮都能找出新的一处差，失败集合永不重复，收敛判据永不生效，卡只会烧完预算——正是 03 §8 消除的那个失效模式。业界同向：阈值化的布局比对优于严格像素比对，后者 flakiness 高一个量级。原型在这套里的角色是**给结构层与契约层供数**，不是一张要被像素对齐的图。

**移动端 / 桌面端目前没有验证道**（只有 headless Chromium）。所以 `qualityGates` 必须回答"这个平台怎么证明做成了"，答不出就停人——不允许出现"原型定了、代码写了、没人能证明它做成了"的交付。

## 7. 不做的决定

- **外部设计工具不进执行链路**。三条理由：注入必须逐字节确定性（外部拉取做不到）；要第二套凭据发到每台机器，其桌面版更要求客户端常开，对 7x24 headless Linux 直接出局；文件不进 git，无法 diff、无法 PR 审计、断网不可用。留门的做法只有一条：`tokens.json` 用 W3C 格式，原型只消费 token，将来接入是一次导入导出。
- **不做像素比对**（§6）。
- **骨架不单独成卡**（§5）。
- **方案关不新增停点**（§2）：等人仍停在 SOLUTION 状态内，四类真停点不变。

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
- 配置：`prototype.root`（per-repo，默认 `docs/prototype`）、`uiContract.enforce`（global, hot，默认 `warn`）、`solution.maxRounds`（出口回喂轮次，默认 3，与 `specifyExit.maxRounds` 同族）。
- 角色与模型：SOLUTION 走大脑档（同 decompose / UI 走查），理由同 03 §3——它读的是人话、判的是屏幕。

## 9. 实施顺序

每片可独立合入、独立回滚：

1. **状态机与产物**：`SOLUTION` 状态、`requirement_solutions` 表、SOLUTION phase 与 prompt、确定性停人条件（§2.2）、方案注入需求拆解。此片先不产界面契约。人批的手势同时落地（看板新增「方案待确认」列、拖列与评论两条路），否则这一片一上线就会把需求堵在一个没人能通过的关上。
2. **界面契约三件套**：`docs/prototype/` 形态、原型自动截图、注入内容与确定性排序。
3. **Notion 方案区段**：页面骨架、截图上传、to_do 回读、`approve_solution` 意图、看板新列。文案全部进 `display-text.json`，过 `notion-write-language.test.ts`。
4. **反向兜底**：SHAPE 的 `interface = null` 检查、CODE 出口的依赖清单检查、目标目录为空时不并行。
5. **VERIFY 结构层**：`story_specs.visible_json`、SHAPE 产出、aria 快照的确定性校验。
6. **VERIFY 契约层**：计算样式比对，`uiContract.enforce` 三态，默认 `warn`。

配套文档改动：03 §9.2 第三条（「原型图是参考不是判据」）随第 5 片改写为本文 §6 的三层；03 §7.1 的需求状态机补 `SOLUTION`；05 §2 的前端形态改为由界面契约决定而不是预先写死；AGENTS.md 增一条不变量。
