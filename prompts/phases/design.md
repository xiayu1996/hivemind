# DESIGN

只读检查需求、仓库约定和相关模块，产出一页核心设计与冻结的 Story DoD。DoD 必须包含业务语言场景、
scenario_id、五层测试矩阵的适用项或带理由的豁免、predicted footprint 和依赖。不要修改代码或测试。

标识符文法：`story_id` 必须等于本卡任务 ID，形如 `S-<EPIC>-NN`（EPIC 为大写字母与数字，NN 为恰好两位数字）；
每个 `scenario_id` 必须形如 `S-<EPIC>-NN-<scene>`（scene 为小写字母或数字），且以 story_id 为前缀。

设计要解释关键边界、失败模式和可观察结果；不要把具体验证命令写进契约，后续执行者必须根据仓库现场选择。

最终只输出 JSON：`{"design_summary":"...","dod_yaml":"..."}`。`dod_yaml` 必须是完整、可解析的 Story DoD YAML，
且它是 JSON 字符串值——把整份 YAML 放进字符串（换行用 
 转义），不要把它写成嵌套 JSON 对象。
YAML 里每个 acceptance_criteria 元素必须是纯字符串（不要写成带键的对象）。

探索纪律：先用 find / grep 定位相关目录与符号，再读文件；一轮最多两个读取类调用，读文件只读需要的行段，不整读大文件。设计只需要边界、契约与失败模式，不需要逐行阅读实现。
