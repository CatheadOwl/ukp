---
description: ukp 包独立性 rules seed——即将拆出独立公开仓的 npm 包 @catheadowl/ukp 的期望形态；评审 dispatch prompt 原样嵌入本文件，finding 引用 rule id
---

# ukp package-independence rules

ukp 包独立性目标的 **rules SSOT seed**，双端消费：生成时（经 `AGENTS.md` 指针加载）控制写作——advisory；评审时（review 技能的 dispatch prompt **原样嵌入** 本文件）对照，finding 引用 rule id。规则只写期望形态；理由归认知层/决策史。id 一经评审/gate 引用即不改号；语义要变视同废弃换号；作废标「已废弃」不复用。

- **PKG-1〈no-dev-repo-links〉**：包内文件（src、README、随包 docs、test、.github）不得含指向开发仓路径的 markdown 链接/图片/定义（`../` 越出包根的相对链接同罪）；按名纯文本引用开发仓证据是接受的出处形态，不算违规。探针：`grep -rE '\]\(\.\./' ukp` + `grep -rnE '\]\(\.\./(product|docs|agent-eval|workunits|ukp_cognition)' ukp`。基线：越出包根的相对链接或发布面断链 = blocker；其余 should-fix。
- **PKG-2〈files-ships-what-docs-reference〉**：`package.json` `files` allowlist 必须覆盖包内文档引用的全部随包内容；文档引用了不随包发布且包外不可达的路径即违规（repo 级文件如 .github/CHANGELOG 属仓内容不算缺项，但 README 若引导读者去读则必须有可达形态）。探针：`npm pack --dry-run --json` 对账。基线：`files` 缺项致断链 = blocker；冗余Shipping = nit。
- **PKG-3〈readme-homepage-skeleton〉**：`ukp/README.md` 作为独立仓主页须含骨架六要素——一句话定位（含能力/价值动词短语，非纯形态词）、安装、quickstart ≤2 屏到首命令、提供面（命令/能力清单）、已知限制、一行开发链接。基线：定位句缺失或读完仍不知这是什么 = blocker；要素缺 = should-fix。
- **PKG-4〈self-contained-reading-sequence〉**：随包文档的阅读序列不得前置未定义术语或开发仓内部语（status board、workunit、ISSUE 编号、外层 workspace 路径）；每句要么自解释要么有包内可达的定义/链接。基线：should-fix。
- **PKG-5〈no-control-plane-narrative〉**：包内不得混入开发仓控制面叙事——status board 状态、roadmap 排期讨论、评审运行记录、workunit 故事、「外层/meta/私有 workspace」自我指涉。历史决策记录（设计取舍理由）以「按名引用 + 包内自包含结论」形态存在是合规的。基线：should-fix；导致读者指向不存在路径 = blocker。
- **PKG-6〈no-committed-artifacts〉**：不得提交构建/运行产物（lib/、dist/、*.tgz、.runs/、sourcaps、以及 tsc 就地射入 src/ 的 .js/.d.ts）。探针：`git ls-files ukp | grep -E 'lib/|dist/|\.runs/|\.tgz|\.map$|src/.*\.(js|d\.ts)$'`。基线：blocker。
- **PKG-7〈ssot-direction〉**：包消费者需要的契约实质（命令行为、schema、capability 契约）SSOT 随包走（包内文档自权威，开发仓 spec 冻结为决策记录）；纯决策史留在开发仓。基线：SSOT 违背致发布后文档指向不存在路径 = blocker；纯重复 = should-fix。
- **PKG-8〈provider-boundary-honesty〉**：对 QMD 的陈述须守住 provider 边界口径——QMD 是外部 provider 不是 UKP 定义；不把 QMD 的配置/collection/index 语义写成 UKP 行为。基线：事实性越界 = should-fix（发布叙事级错位 = blocker）。

## intentional-design 豁免清单（防误报；finding 引用本清单即非 finding）

评审者注意：以下为刻意设计，不是缺陷——

- test/ 中出现的仓库名样例字符串（fixture，如 `ukp-product`）是测试数据不是泄露；
- README/CONTRIBUTING 中的开发协作指引（如何贡献、本地 dev 环）是独立仓自营内容，不算控制面叙事；
- `.github/` CI workflow 与 trusted publishing 模板不进 npm tarball 是常态（repo 级资产）；
- QMD 按名作为外部 provider 出现在关键词/文档中是产品事实，不是宿主泄露。
