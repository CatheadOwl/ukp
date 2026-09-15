---
description: ukp grounding rules seed（GRD-1..6）——ukp 发布面文档机制陈述的接地期望形态：术语口径锚 spec 术语包、证据阶梯、术语三择一裁决、曲解大忌、未探索当不存在大忌、参考包充分性；生成时控制写作、评审时原样嵌入 dispatch prompt
---

# grounding rules（对象：ukp 发布面文档——README / CHANGELOG / CONTRIBUTING 中关于 UKP 自身机制与 provider 边界的机制陈述与术语）

ukp grounding 评审（review-evals 族 grounding-review 技能）的 **rules SSOT seed**，双端消费：生成时（经 `ukp/AGENTS.md` 指针加载）控制写作——机制名词与机制陈述必须对得上 spec 术语体系；评审时 dispatch prompt **原样嵌入**本文件，finding 引用 rule id。id 一经引用即不改号，作废标「已废弃」不复用。GRD-4/5 自 value-statement seed VAL-2 的大忌文本**转移**而来（本文件是其通用 SSOT；VAL-2 保留价值文档场景的引用）。术语 SSOT 层级：`docs/spec/*`（确定行为契约）＞ 线内 spec（`workunits/ukp_propose/spec/`、`workunits/ukp_remote/worklines/`）＞ 部署手册（`handbooks/ukp-remote-deployment/`）。

- **GRD-1〈terminology-pack-required〉**：机制术语的口径 SSOT 是**术语参考包**——即冻结的 spec 术语表（docs/spec 契约词：发现文档/host 门/instance_uid/TOFU 钉证/envelope/sidecar/docid/propose 三态等）；指同一机制实体不得自造同义新词。评审派遣时参考包随 prompt 冻结提供，目标域没有则先建，不得空跑。
  探针：无（口径核对在评审维度）。基线：should-fix。
- **GRD-2〈evidence-ladder〉**：核查证据按成本升序三层，逐 finding 声明所用层——①随 prompt 提供的术语参考包（冻结、便宜）；②本地证据层（docs/spec/*、workunits 线内 spec、handbooks/ukp-remote-deployment）按需取读；③自行探索 ukp/src 源码，仅当①②覆盖不到该声称，且显式记录（探索是兜底不是默认）。
  探针：无。基线：should-fix（跳层不声明）。
- **GRD-3〈terminology-adjudication〉**：机制名词逐条**三择一**裁决——**对得上**（spec 术语）/ **自造词**（指真实实体但 spec 查无此词）/ **指错实体**（spec 有该词但语义不符）。后两者是表达错位，与事实谬误同级对待：读者拿这个词去 spec/文档查证不到。
  探针：预扫（对象文档反引号机制词 + 机制名词清单 grep，命中逐条裁决）。基线：should-fix；发布面指错实体为 blocker。
- **GRD-4〈misreading-sin〉**（转移自 VAL-2，通用 SSOT 在本条）：对 spec/证据层已有结论的转述不得丢限定词、不得反转边界——**曲解即事实错误**（例：把「门级 token 认证」写成「每端点独立 token」、把「仅自签/私有 CA 钉证」写成「所有 https 钉证」）。
  探针：无。基线：should-fix，发布面为 blocker。
- **GRD-5〈unexplored-as-absent-sin〉**（转移自 VAL-2）：负向声称（「不支持 X / 尚无 X / 只有 Y」）必须携带**正面核实**（spec/源码级证据）；证据未覆盖某主题 = **未知**，不是没有——未探索领域只能表述「未探索/未知」，不得写成否定句。
  探针：无。基线：should-fix，发布面为 blocker。
- **GRD-6〈pack-adequacy〉**：术语参考包词条必须携带**可判别内容**——wire 类词条带方法与路径、schema 类词条带字段集与约束；不足以裁决对象声称的词条视同层①缺失，评审者必须升层核实并回写参考包，不得对着薄词条直接 MATCHES。
  探针：无。基线：should-fix（对薄词条直接 MATCHES 的裁决视为漏裁）。

## intentional-design 豁免清单（防误报）

- 首版空——随评审运行回填（回填条目须带来源运行日期）。
