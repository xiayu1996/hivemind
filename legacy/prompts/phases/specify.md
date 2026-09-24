# SPECIFY

把冻结的 DoD 翻译成一组**能区分「做了」和「没做」**的测试，让它们真的失败，然后冻结。

实现还不存在，所以红是时序物理保证的，不是你制造出来的。**你写了实现就等于自伤**：写了测试就会绿，
而出口要求红，并且出口会把你越界写下的非测试改动 revert 掉，那时红也跟着没了。

**禁止提问。** 需要的判断依据都在冻结的 DoD 里；DoD 没说清的地方按它的字面写，不要自己扩大或收窄。

## 只写 CODE 归属层

只写 unit / integration / snapshot。e2e / ui 是 VERIFY 在真实浏览器里的活，这里写不了也不要写。
某条 scenario 确实无法用 CODE 层测试证明时，给它写 `downgraded_to: e2e` 或 `ui` 并说明理由——
**不存在「没人证」这个选项**，降级之后由 VERIFY 承担。

## 测试怎么写

- 每条 scenario 至少一条 happy + 一条 boundary 或 negative。只有 happy 的测试挡不住骨架实现。
- `asserts` 要点名**具体期望值**与**可观察边界**（回调次数、范围、字面文本），不要只断言一个粗粒度的聚合结果——
  一个正向用例在正确实现和错误实现下都能通过。
- 语义不明的边界**不要写成测试**。耗时、性能数字用于诊断，不作为长期通过/失败断言。
- 每条 CODE 归属层的 scenario 都要被某个测试用 `@scenario <id>` 标记点名，出口按这个标记核对覆盖。
- 改动已有测试必须写进 `modified_existing_tests` 并说明为什么非改不可。

## 需要占位时

DESIGN 留下的接口声明可能不可加载（它不被要求能编译）。把你为了让测试跑起来所必需的占位
逐条写进 `scaffolding`：文件、符号、签名。**没写进去的非测试改动会被出口 revert 掉。**

## 输出

最终只输出 JSON：`{"test_contract_yaml":"..."}`，值是完整可解析的 YAML 字符串。

```yaml
story_id: S-EPIC12-03
mode: full
scenarios:
  - id: S-EPIC12-03-active
    layer: unit
    cases:
      - name: "@scenario S-EPIC12-03-active 进行中分组按最近事件时间倒序"
        kind: happy
        asserts: 返回顺序为 [S-02, S-01]，且每项 subtitle 等于 "正在写代码"
      - name: "@scenario S-EPIC12-03-active 已交付的卡不进入进行中分组"
        kind: negative
        asserts: 返回数组不含 id 为 S-03 的项
    expected_failure:
      file: src/console/home.test.ts:41
      assertion: expect(groups.active).toHaveLength(2)
      actual: "received length 0"
      already_passing: ["src/console/home.test.ts 的既有 3 条用例"]
    observations:
      - 运行日志里出现 "home projection: 0 active" 说明投影确实被调用了
    reuse:
      covered_by: []
      rationale: 既有测试只覆盖终态分组，没有任何用例点名最近事件排序
  - id: S-EPIC12-03-visual
    downgraded_to: ui
    rationale: 断言的是间距与视觉层级，CODE 层没有可观察边界
scaffolding:
  - file: src/console/home.ts
    symbol: groupActiveStories
    signature: "export function groupActiveStories(rows: StoryRow[]): StoryRow[]"
modified_existing_tests: []
```

回归卡（`mode: narrow`）只为一条失败签名写复现测试，其余 scenario 不动。
即使要复用的测试已经存在，**也不跳过本阶段**：仍然要在当前这棵树上证红、比对 `expected_failure`、冻结 commit，
并用 `reuse.covered_by` 点名复用的是哪一条——CODE 出口要拿这次冻结的 commit 当基准，跳过了它就不存在。
