import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";

const paragraph = (content: string) => ({
  object: "block", type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content } }] },
});
const heading = (content: string) => ({
  object: "block", type: "heading_2",
  heading_2: { rich_text: [{ type: "text", text: { content } }] },
});

const secrets = await loadSecretsFile();
const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token: secrets.get("NOTION_TOKEN")! }) });
const dataSourceId = secrets.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID")!;

const created = await gateway.request({
  method: "POST", path: "/v1/pages", priority: "interaction",
  body: {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      "标题": { title: [{ type: "text", text: { content: "S-VAL-001 数值格式化工具" } }] },
      "任务 ID": { rich_text: [{ type: "text", text: { content: "S-VAL-001" } }] },
      "目标仓库": { select: { name: "hivemind" } },
      "目标分支": { rich_text: [{ type: "text", text: { content: "main" } }] },
      "优先级": { select: { name: "P1" } },
      "AI 状态": { select: { name: "待启动" } },
    },
    children: [
      heading("需求描述"),
      paragraph("目标: 为控制台与成本展示提供统一的人类可读数值格式化工具: 美元金额保留两位小数并带千分位分隔, 字节数按 B/KB/MB/GB 自适应单位。"),
      paragraph("验收: 仓库新增 src/util/format.ts, 导出纯函数 formatUsd 与 formatBytes; 0、负数、超大值、非法输入等边界行为由配套单测明确; npm test 全绿; 不改动任何既有模块的行为。"),
      paragraph("说明: 本卡用于验证单卡全流水线(需求→设计→开发→独立验证→合并→MR), 范围刻意最小化; 独立产出一个 PR, 未经人工评审不得合并, 禁止直接推送主分支。"),
    ],
  },
});
console.log("validation card created:", (created.data as { id: string }).id);
process.exit(0);
