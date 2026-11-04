- 区分开发面（本agents.md引导）和发布面（SKILL.md引导）

- 发布面rules
  
  - package.json白名单定义公开件（模仿npm tarball）
  
  - 英文、产品介绍体
  
  - 正本是 CLI 自述（`--help` /`ukp guide`）。
    
    - 本skill是cli的薄入口。
    
    - 改 CLI 面后不要来此同步任何热数据。
  
  - 关键词（knowledge endpoints / CLI / 入口）
  
  - 两段唯一需要额外说明的概念（ukp:// 交接、propose 提案）

- 开发面rules
  
  - 非package.json白名单定义即是开发面文件，禁止从 SKILL.md 链接或提及；开发面的维护规则住本文件，不住 SKILL.md。

- TODO
  
  - 删除setup.mjs手动模式
    
    - junction 整目录暴露（白名单复用）
