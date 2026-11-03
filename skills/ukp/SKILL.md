---
name: ukp
description: "ukp dispatch SOP — named knowledge endpoints (search, read, nav, rg, propose); registry and scope semantics; ukp:// and `{name}:path` cross-project references"
---

# ukp · 知识面派遣（folder as a Service）

## 何时用 / 何时不用

用：按名字寻址本地/远端知识——五动词（search / read / nav / rg /
propose）+ registry 管理 + scope 语义；产出里用 `ukp://` 引用交接
（folder 可迁移，名字不迁）；把改动以幂等提案递给 endpoint owner；
给消费仓配默认端点 / 固定 scope / 工作区 scope 配置（一步命令
`ukp use <e>`，语义见 `ukp guide client`）；解析 `{name}:path` 形跨仓
引用（生态通形，非 ukp 专属——裁定与
夹具见 [references/trigger-design.md](references/trigger-design.md)）：
名在注册表，`ukp read --endpoint <name> <path>` 即开（基径 =
注册根，项目 endpoint 即仓根）；名不在，ukp 让位。

不用：一次性本地文件操作（直接 rg / cat 更省）；agent 进程派遣
（非知识面，不归 ukp）；provider（QMD）自身的配置维护（UKP 指路
不代劳）。

## 命令面（热数据，派遣每次查）

| 动词 | 命令 | 要点 |
|---|---|---|
| 检索 | `ukp search "<q>" --endpoint <e>` | 索引深查（需 QMD）；结果行自带 `read:` 提示（docid 交接，照抄可用）+ 已验证 `ukp://`；`--recursive` 只走 manifest 声明的 dependencies |
| 读取 | `ukp read <uri>` / `<path> --endpoint <e>` / `<docid> --endpoint <e>` | URI **自带权威、不叠 `--endpoint`**；path / docid 形态**要配** `--endpoint`；免 provider；文件迁移 best-effort 找回（git 史 → search） |
| 大纲 | `ukp nav --endpoint <e> [--depth N]` | Markdown 结构，免 provider |
| 字面 | `ukp rg "<re>" --endpoint <e>` | 免索引免声明；`--files` 列文件；结果即 read-ready 引用 |
| 提案 | `ukp propose --endpoint <e> --id <slug> --file <f>` | 幂等建议箱——created / unchanged / updated，仅 updated bump revision；写面 opt-in（manifest 声明才有） |

- **scope**：`--endpoint <e>` 是正名选择器；缺省 = workspace 默认
  （`.ukp/client.toml`，`ukp use <e> [e...]` 一步写入并保持版控可见，
  幂等、整表替换），`-g` = 全本地 registry；动命令前 `ukp
  inspect` 先看命中谁。同一仓双角色（service 同时是消费方）合法：
  client.toml 与 service.toml 各自独立读（`ukp use` 不碰 service 面）。
- **registry**：`ukp list` 现查 bindings + capabilities（不背清单，
  会漂）；**缺省吃 workspace scope**（同消费命令律；无 client config
  全量兜底），`ukp list -g` = 全量（不读 client config——机器解析/
  枚举全部端点名用它，含 `list -g --json`）；新 endpoint = 文件夹内
  `ukp init service --name <slug>`
  （本地名 = manifest 顶层 `name`，后编辑 service.toml 亦可）→ 要写面
  就声明 capabilities → `ukp diagnose` → `ukp register`；远端消费 =
  `ukp register --url ssh://<host>`（TOFU 钉扎）。`register --name`
  仅远端句柄专用（须配 `--url`），本地命名不走它。
- **能力分级**：read / nav / rg 是本地 Service 的派生默认，零 provider；
  search / update 需 QMD 在 PATH（缺则 `list` 报 unavailable，退 rg）。
- **机器面**：`--json`（read 用 `--format json`）；`ukp list --json` =
  离线快照 `ukp.list.v1`（远端 binding 零触网，能力字段为 null，
  字段名跨版本稳定——跨仓治理工具已实依赖，当作稳定契约消费）。

## 程序

1. **查知识**：`ukp inspect` 定 scope → `ukp rg "<词>"` 字面先探（免
   provider）→ 要语义深度再 `ukp search` → `ukp read <引用>` 取正文。
2. **交接**：产出中的知识引用写 `ukp://<e>/<path>`，不落物理路径；
   解析 `{name}:path` 形速记同走 read（名在注册表即可开，基径 =
   注册根）。
3. **提案**：起草文件 → `ukp propose --id <slug> --file <f>`；重提同
   id 不 dup，owner 在 endpoint inbox 裁决。

## 产出契约

- 查询成功：引用开盖即读（`ukp read <uri>` 回到内容）。
- 注册成功：`ukp list` 见名，capabilities 与声明一致。
- 提案成功：propose 报三态之一；revision 只在 updated 时前进。

## 载荷指针

- 深料住 CLI 自带文档面（本 skill 不另抄正本）：`ukp guide service` /
  `client` / `rg` / `remote` / `propose`。
- 契约正本：仓内 `ukp/README.md`（Commands 全表、Remote、Security）。
- 触发设计夹具（`{name}:path` 联想裁定与改面导轨）：
  [references/trigger-design.md](references/trigger-design.md)。
- 测题（首验用）：[evals/evals.json](evals/evals.json)。
