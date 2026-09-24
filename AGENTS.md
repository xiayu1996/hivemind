# AGENTS.md

hivemind 是 7x24 自主交付服务：从看板接需求，规划者把它写成产品契约、技术方案与构建计划，
构建者在一条集成分支上逐项测试先行地实现，每一项都由看不到构建过程的独立评审在真实运行的产品上对着契约验收，
通过才落地；做完整体终审，交给人确认。
改动 `src/` 之前先读 [docs/design/00-overview.md](docs/design/00-overview.md)。
旧系统完整保留在 `legacy/`（冻结，只供查阅，不再运行）；从它带过来的结论见 [docs/legacy-knowledge.md](docs/legacy-knowledge.md)。

## 分支门禁

`main` 只经 PR 推进，两层门禁：GitHub 的 ruleset（仓库侧，唯一挡得住的一层，禁止直推、强推与删除）与 `.githooks/pre-push`
（本地，由 `npm run prepare` 设 `core.hooksPath` 装上，让拒绝发生在网络调用之前并给出改法）。
直接在 `main` 上提交后再想推，唯一的出路是 `git switch -c <branch>` 把提交带到分支上；不要用 `--no-verify` 绕本地钩子——仓库侧照样拒。

## 预发布立场：地基优先于兼容

**首次真实部署后删除本节。** 当前没有任何部署实例、没有外部使用者：

- 目录、模块、导出可以自由重命名，但必须同 PR 更新全部引用。
- schema 改动后**重新生成唯一的初始迁移**（`rm -rf drizzle && npx drizzle-kit generate --name init`），不累积迁移；本地库删掉重建。
  库里记着已应用迁移的哈希，文件变了会拒绝启动并提示删库。
- 第一次真实部署之后，迁移才变成只增不改的历史。

## 仓库布局

```
src/
  main.ts       组合根与命令行：全仓唯一知道每个 adapter 的地方
  config.ts     实例配置（~/.hivemind/config.yaml）、secrets、配方加载
  ports.ts      主循环与外界的全部边界
  loop/         主循环：engine（一次 tick）→ requirement（推进一个需求一步）→ author / build / revise / review 四种步骤 + evaluate
  domain/       纯函数：契约、计划、项目配置、配方、停点、验收结论的规则
  gates/        门：repo-checks（仓库检查）、evidence（证据比对）、fence / tool-guard / danger-rules（写权限与命令红线）
  agents/       会话的描述：模型文件、prompt 组装、结果提交工具、runAgent（催交、交回、记账）
  adapters/     pi（唯一 import pi 的模块）、browser（playwright）、git、app、process、board-local、notion/
  resilience/   错误分类、熔断、额度窗口解析
  store/        drizzle schema（权威）、Store（全部读写）、db（打开、迁移、哈希守卫）
config/         models.yaml（provider 与各角色的候选模型）、messages.yaml（给人看的全部文案）、recipes/*.yaml（流程配方）
prompts/        base.md、roles/*（三个角色）、steps/*（每种步骤）
drizzle/        drizzle-kit 生成的迁移，不手改
legacy/         旧系统
```

## 命令

```sh
npm test            # vitest；含真实 git + 真实浏览器 + 脚本化模型的主循环端到端测试
npm run lint        # oxlint src
npm run typecheck   # tsc --noEmit，strict
npm run db:check    # 迁移必须恰好是 schema 生成出来的样子

node src/main.ts preflight [--probe]   # 配置、凭据（只看在不在，不刷新登录）、仓库、看板、浏览器；--probe 给每个模型发一条最短请求
node src/main.ts run                   # 常驻：一个库只允许一个进程（租约 + fence）
node src/main.ts submit --repo <name> --title <text> [--body-file <path>] [--recipe <name>]   # 本地看板
node src/main.ts status [<ref-or-id>]
node src/main.ts approve <ref-or-id>   # 本地看板：批准它正在等的那一版
node src/main.ts comment <ref-or-id> <text>
node src/main.ts budget <ref-or-id> <usd>
node src/main.ts providers [reset <id>]   # 查看熔断；人修好凭据或额度后清掉
```

Node `>=26`，直接运行 TypeScript（type stripping，导入写 `.ts`，只用可擦除语法），ESM，npm，没有构建步骤。
部署与运维见 [docs/runbook.md](docs/runbook.md)。

### 本地验证顺序

单测 → 主循环端到端测试 → 真实模型（`preflight --probe`，再用本地看板跑一条小需求），按此顺序推进，不跳级。
报告结果时只写实际执行过的命令。

## 凭据与配置

凭据一律走 `~/.hivemind/secrets.env`（chmod 600，否则拒绝启动）与 `~/.pi/agent/auth.json`，**永不进仓库、永不进日志、永不粘进对话**。
secrets 只读进内存，按请求传给 provider；**不进 `process.env`，也不进会话与检查跑的任何命令**：它们只拿到白名单环境
（`baseEnvironment`）加实例配置 `passEnv` 显式列出的变量。唯一的例外是 git / gh 进程拿到推送与开 PR 所需的 `GH_TOKEN`（有才给）。日志逐行经 `redactor` 脱敏（已知 secret 值 + 令牌形态）。
提交前确认 `git diff` 中没有任何令牌形态字符串（`sk-` / `ghp_` / `eyJ` 开头的 JWT 等）。
查进程不要用打印完整命令行的方式（`pgrep -fl`、`ps -ef`），子进程的环境与参数里可能有凭据。

## 架构不变量

- **主循环单写者、顺序执行**：一个进程、一个库、一次一个会话；每个需求一条集成分支、一个 worktree。没有并行 Story、没有合流，
  所以没有冲突要解。一个单位的工作做完就落库，进程在任何地方死掉，至多重做被打断的那一个单位。
- **仓库就是记忆**：产品文件在目标仓库的 `.hivemind/` 下（PRODUCT.md、acceptance.yaml、DESIGN.md、ARCHITECTURE.md、
  project.yaml、plan.yaml、research/），跟代码同一个提交历史。每个会话从零开始，系统 prompt 里带着它们；不做 session fork，
  不存对话。`PROGRESS.md` 与 `acceptance/*.json`（重放脚本）由循环按自己的记录生成。
- **三个角色，写权限按角色切**：规划者只能写 `.hivemind/**`，构建者能写 `.hivemind/**` 以外的一切，评审什么都不能写。
  工具层拒绝越权写入，会话结束后 `enforceFence` 再把越权改动原样撤回——两层都在，因为 bash 能绕过第一层。
- **只有三道门，全在构建者会话里跑**：① 仓库检查（`project.yaml` 的 setup + checks，构建者改不了它）；
  ② 真实运行的产品上的验收（先无模型重放此前通过的全部场景，再由评审判本项的场景；每个 passed 必须引用 harness 自己拍下的快照或输出，
  且证据里真有契约 `visible` 列的每一条；failed 必须逐字引用契约原句）；③ 写权限围栏。任何一道不过，清单回喂**同一个**构建者会话，
  它已经读过的东西都还在。除此之外的检查都是信号，不是门。
- **只有三种停点**：没有进展（一项尝试 `maxItemAttempts` 次 → 规划者返工 `maxReplans` 次 → 停；终审打回超过 3 次 → 停；
  循环自身连续出错 5 次 → 停）、预算用完、只有人能答的问题。加上三种等待：等批准（绑定到那一版的 commit）、等回答、等模型恢复。
  新增停点要先改设计文档。
- **人的输入只有两种：批准与评论**。批准只对它绑定的那一版有效；评论在任何时候都是反馈——审批中的评论让该步带着它重写，
  构建中的评论让规划者修订计划，停下的需求上的评论让它带着意见继续。人改了某个已通过验收项的场景，循环按内容摘要自动把那一项重开重做，
  不靠模型自报。
- **预算按 API 等价价格计，订阅也计入**：订阅也是钱，一个忽略订阅的上限在大部分流量上什么都没管。
- **易变处是数据，不是代码**：provider、模型、effort、候选顺序在 `config/models.yaml`；流程在 `config/recipes/`；
  prompt 在 `prompts/`；给人看的文案在 `config/messages.yaml`。代码里不出现任何字面 model id，也不出现给人看的中文。
- **pi 在进程内**：`src/adapters/pi.ts` 用 pi 的 agent SDK 直接跑会话，是唯一 import pi 的模块。瞬时错误同模型退避重试；
  其他错误记入熔断并在**同一段对话里**换到下一家 provider 的候选继续；上下文溢出单独分类，不碰熔断。
- **KV 缓存命中靠确定性**：系统 prompt 静态在前（基线 → 角色 → 步骤 → 需求 → 按路径排序的产品文件），工具按固定顺序，
  `sessionId = runId`，`cacheRetention: "long"`。`assembleSystemPrompt` 不读时钟、不读文件系统、不取随机数。
- **加一个仓库或一家 provider 是改配置**：仓库在实例配置里；provider 在 models.yaml，pi 不自带的用 `declaration` 声明，密钥只写 secret 的名字。

## 持久化

- **drizzle schema（`src/store/schema.ts`）是唯一真相**，迁移由 drizzle-kit 生成；状态枚举、互斥关系、JSON 合法性写成 CHECK，
  应用层可以有 bug，DB 约束不会被绕过。
- **永远不用 `db.transaction()`**：libsql 会把连接交出去再新开一个，新连接没有我们设的 pragma，`:memory:` 下更是一个空库。
  需要原子的一组写用 `db.batch([...])`。
- **租约是一条原子 UPSERT + 单调 fence**：被取代的持有者拿旧 fence 续租或释放必须被拒；续租失败的进程立刻退出。

## 给人看的产出

- 每个字段先分清读者：给人读的（摘要、决定、问题、场景标题与 given/when/then、验收结论的 `reason`）用中文业务语言；
  给下游读的（计划的目标、架构、代码）怎么准确怎么写。
- 循环自己说的话全部来自 `config/messages.yaml`；看板上不出现内部 id 之外的实现细节。

## 代码风格

- 代码中不出现中文、特殊字符、无意义缩写，也不出现只在某次会话里成立的简称或步骤编号。
- 注释只写必要的，用简洁可读的英文，说明契约、失败模式、所有权与安全用法；不复述代码，不记录推理过程或评审历史。
- 空 `catch` 必须写明它吞掉了什么、为什么其他情况到不了这里。
- 文件以恰好一个换行结尾。
- 禁用某条 lint 规则时就地窄范围禁用并写明理由，不做全局关闭。
- 控制流只在 `src/loop/` 一处；外部世界只经 `ports.ts` 的端口；判定写成纯函数放 `domain/` 或 `gates/`。不预铺框架。

## 测试

- 纯函数决策逻辑（契约 / 计划规则、停点、熔断、错误分类、证据比对、验收结论校验）全部单测覆盖。
- 主循环由 `src/loop/loop.test.ts` 端到端覆盖：真实 git 仓库、真实 headless 浏览器、真实被测产品，三个角色由脚本化模型扮演。
  改动主循环必须让它继续通过，新增的循环路径要在这里加一条。
- 错误分类的文案表逐条断言在 `src/resilience/classify.test.ts`；新增文案要有来源（pi 的 provider 层或真实采集），不手写臆造。
- 测试描述行为而非正确性。行为过时了就连同测试一起改，并在 PR 里说明为什么。

## 编辑本文件

根目录的 `CLAUDE.md` 是指向本文件的符号链接，**编辑本文件**。每条规则保持自解释，细节链接到设计文档；
能压缩就压缩，但不要为了短而丢掉"为什么"——没有理由的规则会被下一个人当成可选项。
