- 区分开发面（本agents.md引导）和发布面（SKILL.md引导）

- 发布面rules
  
  - 公开白名单 = `[SKILL.md, reference/manifest.md]` 两件（外层 `ukp/package.json` `files` 精确收，npm tarball 与公共仓机械事实）；`reference/manifest.md` 是 manifest 声明语法的 normative 正本（发布面说明书），meta 层 spec 引用它；内层其余文件（含 owner 另用的 package.json）不在白名单即不发布
  
  - 英文、产品介绍体
  
  - 正本是 CLI 自述（`--help` /`ukp guide`）。
    
    - 本skill是cli的薄入口。
    
    - 改 CLI 面后不要来此同步任何热数据。
  
  - 关键词（knowledge endpoints / CLI / 入口）
  
  - 两段唯一需要额外说明的概念（ukp:// 交接、propose 提案）

- 开发面rules
  
  - 非package.json白名单定义即是开发面文件，禁止从 SKILL.md 链接或提及；开发面的维护规则住本文件，不住 SKILL.md。

