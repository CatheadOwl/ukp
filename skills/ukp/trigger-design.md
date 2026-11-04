---
description: "Trigger-design jig for the ukp skill face — `{name}:path` shape token as description bait, candidate-resolver-not-owner boundary, yield on registry miss"
---

# `{name}:path` 触发设计夹具（2026-10-21 owner 裁定）

## 背景

`{name}:path`（如 `ls-gates:docs/architecture.md`）是生态通形：todo-board
条目格式、hooks canonical 引用已在用；解析手段不止一个——`repo` 技能、
todo-dispatch、agent 自知的仓布局都能解。ukp 的差异点：注册表一查即开
（零发现成本）、远端 endpoint 同样可开、开出的内容带 `ukp://` 锚点。

## 裁定

ukp 面只承载**联想**，不承载所有权——使用者看到 `{name}:path` 能想到
ukp 是可用工具之一。落点三处，同 commit 落地：

1. **description 放形元词**——反引号 `` `{name}:path` `` 作字面 pattern
   token（skill-form「引号触发短语」用法）配自然语别名（跨仓引用 /
   cross-project reference）。形状不是固定词，索引里必须有字面锚点，
   联想才发生。
2. **域界定写「候选，非所有者」**——可证伪配方（名在注册表 →
   `ukp read --endpoint <name> <path>` 即开；不在 → ukp 让位）+ 基径
   诚实（注册根起算；项目 endpoint 即仓根，`.dist` 类注册根除外）。
   负边界（注册表 miss 即让位）是防 over-claim 的否决器。
3. **程序交接处半句速记开法**——配方指针，不重复全文。

## 明确否决的备选

- **等价声明**（`{name}:path` ⇔ `ukp://name/path` 成法）：通形非 ukp
  所有，声明所有权即 over-claim。
- **零机器路径通法进 ukp 面**：写入侧纪律归各产物格式的所有者
  （todo-board 条目格式等），ukp 面不下法。
- **todo-board 投影改造 / 写入侧触发**：随上两条一并作废
  （owner 收窄，2026-10-21——只留「看到 → 想到」）。

## 夹具约束（未来改面的导轨）

- description 里的形元词 `` `{name}:path` `` 不得在改写 description 时
  无声丢失——丢了，联想即断。
- 让位条件（注册表 miss → stand down）不得削弱成「先注册再开」的默认
  行为：注册是可选项，不是义务。
- 触发竞争是健康现象：repo / todo-dispatch 将来同咬此形，竞争发生在
  description 索引，否决发生在各自域界定（skill-form 两段式分工）。
- 工具侧若将来支持 `name:path` 直读（win32 盘符冒号歧义待消解），
  配方行随契约变更同 commit 更新。
