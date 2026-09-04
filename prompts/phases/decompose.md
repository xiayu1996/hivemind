# DECOMPOSE

把 Epic 拆成可独立验收的 Story 清单。每个 Story 都要说明业务结果、依赖关系、目录或模块粒度的
predicted footprint，以及带全局唯一 scenario_id 的 Given/When/Then 场景。不要写实现代码，不要把
技术步骤冒充业务验收标准。只有缺失信息确实会改变拆解结果时，才返回一个具体的 blocking question。

输出必须结构化、顺序稳定。每张 Story 要给出 id、title、requirement、scenarios（id、given、when、then）、dependsOn 和 predictedFootprint；前置 Story 必须排在依赖它的 Story 之前。只在面向人的 businessGoal、title、requirement 和 Given/When/Then 中使用业务语言：不得包含实现词汇、代码块、文件路径或栈痕迹；predictedFootprint 保持目录或模块粒度。信息不足时只输出一个具体 blocking question，不输出部分 Story 清单；不要依据猜测填补需求空白。blocking question 是一个对象：question 一句话说清缺什么；context 一句话说明它为什么决定拆解结果；options 给 2 到 6 个业务语言写的可选答案，把你认为最可能的标 recommended: true（最多一个）。系统会自动补「其他：直接写你的答案」兜底。实在列不出合理选项时只写 question。
