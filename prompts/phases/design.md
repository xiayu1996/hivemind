# DESIGN

只读检查需求、仓库约定和相关模块，产出一页核心设计与冻结的 Story DoD。不要修改代码或测试。

DoD 是后面每个阶段的判据：CODE 按它写测试，盲审按它核对，走查按它看屏幕。**写到两个互不见面的读者
对着同一条 `then` 得出同一个结论**：一个只读代码，一个只看屏幕。做不到这一点的词（「简洁」「清晰」「摘要」）
必须用字面样例定义。

标识符文法：`story_id` 必须等于本卡任务 ID，形如 `S-<EPIC>-NN`（EPIC 为大写字母与数字，NN 为恰好两位数字）；
每个 `scenario_id` 必须形如 `S-<EPIC>-NN-<scene>`（scene 为小写字母或数字），且以 story_id 为前缀。

每条 scenario：
- `given` / `when` / `then` 业务语言；`then` 点名可观察物（哪段文字、哪个字段、哪个状态）与边界（什么被排除）。
- `layers`：unit / integration / snapshot 由 CODE 用测试证明；e2e / ui 由 VERIFY 在真实浏览器里证明。
  只声明真的会被证明的层；用户可见的行为流要有 e2e 或 ui。
- 含 e2e 或 ui 层的 scenario 必填 `source`（数据从哪张表、哪类事件、哪个既有接口来）和 `examples`：
  至少一条 `shows`（用户会看到的字面文本）和一条 `excludes`（不得出现的内容）。走查只能据 `then` 与这些样例否决。
- `seed`（可选）：`given` 在屏幕上需要的样例数据，用一句人话描述（如「一个仓库下有 3 个 Story，1 个已交付，1 个停着」）；
  走查前会把它交给仓库的造数命令，让评审者打开的页面上真有东西可看。

`acceptance_criteria` 每条必须有归宿：`scenarios: [<id>...]`（由这些场景的测试证明），或 `constraint: <由什么代码检查兜底>`。
没有归宿的标准写不进去——它只会在评审时被人眼发现，那时已经晚了一轮。

`out_of_scope` 列出走查不得据以否决的事项（可为空数组，但必须写）；`relies_on` 列出本 Story 依赖其正常工作的
既有页面、路由或服务（它们坏了不算本卡的失败）。

设计要解释关键边界、失败模式和可观察结果；不要把具体验证命令写进契约，后续执行者必须根据仓库现场选择。

最终只输出 JSON：`{"design_summary":"...","dod_yaml":"..."}`。`dod_yaml` 必须是完整、可解析的 Story DoD YAML，
且它是 JSON 字符串值——把整份 YAML 放进字符串（换行用 \n 转义），不要把它写成嵌套 JSON 对象。

```yaml
story_id: S-EPIC12-03
design_summary: <一页纸核心设计，业务语言>
scenarios:
  - id: S-EPIC12-03-active
    given: 存在正在推进且不等待用户回答的 Story
    when: 用户打开首页
    then: 第二组按最近事件时间排序，每项显示标题、一句描述最近事件的话和相对时间
    layers: [unit, integration, ui]
    source: event_log 中该卡最新一条非 rpc.* 事件，按事件类型映射为人话
    seed: 两个正在推进的 Story，其中一个最近事件是「正在写代码」
    examples:
      - kind: shows
        text: "一眼查看当前行动 · 正在写代码 · 3 分钟前"
      - kind: excludes
        text: "CODE · CODE"
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: 进行中分组不包含终态、失败、已交付或等待回答的事项
    scenarios: [S-EPIC12-03-active]
  - text: 首页保持只读
    constraint: guard 策略在 VERIFY 拒绝写工具；路由表无写接口
out_of_scope:
  - 375px 宽度下的导航栏布局
relies_on:
  - /tasks 任务视图页面
predicted_footprint: [src/console, console-ui/src]
depends_on: []
```

探索纪律：先用 find / grep 定位相关目录与符号，再读文件；一轮最多两个读取类调用，读文件只读需要的行段，不整读大文件。设计只需要边界、契约与失败模式，不需要逐行阅读实现。
