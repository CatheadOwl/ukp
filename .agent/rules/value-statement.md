---
description: ukp value-statement rules seed（VAL-1..5）——ukp 价值陈述（含 QMD-wrapper 嫌疑轴）的期望形态：立场框架、证据锚定、抗收编分档、消费者诚实、发布面 stance 口径；生成时控制写作、评审时原样嵌入 dispatch prompt
---

# value-statement rules（对象：docs/prd 价值文档 + ukp 发布面价值段——README 旗舰句 / Why UKP / NOTE 行）

ukp 价值声明评审（review-evals 族 value-statement-review 技能）的 **rules SSOT seed**，双端消费：生成时（经 `ukp/AGENTS.md` 指针加载）控制价值叙事写作；评审时 dispatch prompt **原样嵌入**本文件，finding 引用 rule id。id 一经引用即不改号，作废标「已废弃」不复用。

- **VAL-1〈stance-not-gap〉**：价值陈述以「**立场 + 工具**」框架书写——价值锚在「命名寻址的稳定命令面 + provider 边界干净」这个立场上；不用 gap-filling 框架（「QMD 缺 X，UKP 补 X」把价值锚在 provider 缺位上），也不把价值窄化为「包装了 QMD 的某个能力」（防 QMD-wrapper 感知——叙事顺序 nav/read 打头即此约束的写作面）。
  探针：无（语义判断；词表化易误伤）。基线：should-fix。
- **VAL-2〈evidence-anchored-mechanism-claims〉**：对机制（wire 面、鉴权、TOFU 钉证、propose 三态、rg 降级语义）的声称必须先锚 spec/证据层再进价值叙事。**两类大忌（曲解 / 未探索当不存在）的通用 SSOT 已转移至 ukp grounding seed 的 GRD-4/5**；本条保留价值文档场景的锚定要求，细则不复述。
  探针：无（核对动作本身是评审维度③）。基线：should-fix（发布面机制错误为 blocker）。
- **VAL-3〈absorption-tiering〉**：QMD-wrapper 嫌疑轴的价值分析必须含**抗收编分档**——构件按「QMD 自建服务/寻址面后蒸发（如 lexical search 档位本身）/ UKP 语义本体（命名端点、Registry/Manifest 契约、capability 声明制、门与 TOFU 信任模型、`ukp://` 交接键）」两档列明，不笼统宣称「QMD 没有」。
  探针：无。基线：should-fix。
- **VAL-4〈consumer-evidence-honesty〉**：消费者证据如实分档——同作者 / 委托 agent / 同类问题 / 跨包独立，逐项标注；现实计数（单一作者 + 委托 agent、零外部用户，`product/value-analysis.md` §5）不得写成外部采用声势。
  探针：无。基线：should-fix。
- **VAL-5〈stance-tone-publish-face〉**：发布面把抽象论断写成 **design stance**（设计立场），不带生态断言口吻；验证状态、止损线、补证任务留控制面不进包；诚实口径纪律（release-readme-value-brief 的 Claims to Avoid：不宣称稳定协议、不冒领外部用户、MVP/demo-but-usable）是发布面下限。
  探针：发布面词表可后补（候选：「已被外部使用」类断言词）。基线：should-fix。

## intentional-design 豁免清单（防误报）

- 首版空——随评审运行回填（回填条目须带来源运行日期）。
