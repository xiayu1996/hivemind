# DECOMPOSE

把 Epic 拆成可独立验收的 Story 清单。每个 Story 都要说明业务结果、依赖关系、目录或模块粒度的
predicted footprint，以及带全局唯一 scenario_id 的 Given/When/Then 场景。不要写实现代码，不要把
技术步骤冒充业务验收标准。只有缺失信息确实会改变拆解结果时，才返回一个具体的 blocking question。

输出必须结构化、顺序稳定，并明确指出可并行与必须串行的 Story；不要依据猜测填补需求空白。
