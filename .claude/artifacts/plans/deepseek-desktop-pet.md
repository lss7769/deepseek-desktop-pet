# deepseek-desktop-pet Implementation Plan

> Status: APPROVED
> Source: .claude/artifacts/designs/deepseek-desktop-pet.md (ALIGNED · 仅个人自用)
> Mode: default
> Iterations: 1 / 3
> Author: ns（大一 · 计算机科学与技术）
> Last updated: 2026-10-16

## Requirements summary

把一个 ALIGNED 的 spec（Windows 自用 DeepSeek 桌宠，接入 `deepseek-v4-flash` / `deepseek-v4-pro` 与 dsh）转成可执行实施计划，覆盖 M1–M5。约束：自用、无签名/上架、形象用现成二创图并注明出处。

## Acceptance criteria

- AC-1 启动后 ≤3s 出现透明、无边框、置顶的桌宠窗口；点击角色像素有响应，点击透明像素鼠标事件穿透到下层窗口。
- AC-2 点击角色 → 气泡显示一句来自 `deepseek-v4-flash`（非思考模式）的中文台词，或命中本地预设台词。
- AC-3 输入「讲解快排」类硬请求 → 调用 `deepseek-v4-pro`（思考模式），宠物显示「思考」动画，最终以气泡/面板返回结果。
- AC-4 断网或 API Key 失效时，宠物仍展示本地动画并有预设台词，进程不崩溃、不输出错误堆栈到界面。
- AC-5 源码、日志、配置文件中均不出现明文 API Key（Key 存于 Windows Credential Manager / DPAPI）。
- AC-6 当日 token 消耗达到设定上限后，自动切换到「仅本地台词」模式。

---

## RALPLAN-DR

### Principles

- **最小代码**：先跑通再美化；M1 完全不联网，只验证窗口与交互。
- **范围纪律**：只做 spec 的 In scope，不做多端 / 训练 / 上架 / dsh GUI。
- **可视可验证**：每个里程碑结束都能在桌面上肉眼看到行为变化。
- **成本可控**：默认 flash + 固定缓存前缀 + 每日预算上限。
- **安全**：API Key 不进源码、不进日志。

### Decision drivers

1. **上手速度**（大一新生 + 自用 + 求快）— 最高权重。
2. **生态成熟度**：透明窗口 / 点击穿透 / Live2D 是否有现成轮子。
3. **环境一致性**：dsh 本身要走 Node，技术栈能否统一。

### Viable options

**Option A：Electron + 精灵图/序列帧（M3 再上 Live2D）** ← 选定
- 实现思路：Electron 主进程建透明置顶无边框窗口，渲染层放角色与气泡；Brain 层用 Node 直连 DeepSeek API。
- 改动文件（新建）：`deepseek-desktop-pet/package.json`、`electron/main.js`、`electron/preload.js`、`src/renderer/*`、`src/brain/*`
- Pros：JS/HTML/CSS 门槛最低；透明/置顶/穿透/托盘都有成熟 API；与 dsh 同属 Node 环境，不用两套工具链。
- Cons：打包体积大（约 150MB+）；常驻内存偏高。

**Option B：Tauri v2 + Rust**
- 实现思路：Rust 主进程 + 前端动画，体积小、性能好。
- Pros：体积小（几 MB）、内存低。
- Cons：**需要装 Rust + MSVC 构建工具链**（本机目前无 Rust、无 g++），对大一新生是明显绕路。

**Option C：Fork Open-LLM-VTuber 的 pet mode 改造接 DeepSeek**
- 实现思路：复用其已解决的透明窗 / 穿透 / Live2D，只替换模型适配层。
- Pros：跑通最快，表现力强。
- Cons：需读懂他人大型代码库，改造耦合度高；与「想练手」目标冲突。

**Rejected rationale**：Option B 被砍因环境成本（2）。Option C 不整体 fork，仅作 M3 形象/Live2D 的**参考来源**（避免高耦合）。

### Implementation steps

**M1 — 能跑的最小桌宠（不联网）**
1. 初始化项目与依赖 — 新建 `deepseek-desktop-pet/package.json`（`electron` 依赖）、`.gitignore`
2. 透明置顶无边框窗口 — `electron/main.js`：`new BrowserWindow({ frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, hasShadow:false, resizable:false })`
3. 角色渲染 + 点击冒泡本地台词 + 拖拽 — `src/renderer/index.html`、`src/renderer/pet.js`、`src/renderer/style.css`（`-webkit-app-region: drag` 实现拖动）
4. **透明像素穿透、角色可点** — `electron/main.js`：`setIgnoreMouseEvents(true, { forward:true })` + 渲染层 `mousemove` 做 alpha 命中；Windows 下亦可 `BrowserWindow.setShape`（参考 HAYA-PET 做法）
5. 托盘图标与退出 — `electron/main.js`

**M2 — 接入模型**
6. DeepSeek 适配层 — `src/brain/deepseek.js`：向 `https://api.deepseek.com/chat/completions` 发 OpenAI 兼容请求，`model: "deepseek-v4-flash"`
7. Persona + 本地预设台词 — `src/brain/persona.json`、`src/brain/quotes.zh.json`（persona/system 前缀固定 → 利于缓存命中）
8. 情绪/动作 JSON 驱动动画 — `src/brain/deepseek.js` 用 `response_format:{type:"json_object"}`，渲染层按 `emotion/action` 切帧
9. 降级逻辑 — `src/brain/deepseek.js`：请求失败/超时 → 回落本地台词（对应 AC-4）

**M3 — 形象与动作**
10. 换形象 — `src/assets/pet/`（放入 Whale-chan 二创立绘）+ `src/assets/pet/CREDITS.md` 注明出处
11. 四态动画状态机（待机/说话/思考/睡觉）— `src/renderer/pet.js`

**M4 — 分级与成本**
12. 硬请求升级 v4-pro（思考模式）— `src/brain/deepseek.js` 加 router（关键词/长度/显式按钮）
13. 每日 token 预算与计数 — `src/brain/budget.js` + `config/app.config.json`
14. API Key 安全存储 — `keytar`（Windows Credential Manager）或 DPAPI；`config/app.config.json` 只存引用、不存明文
15. 缓存前缀固化 — `src/brain/persona.json`

**M5 — 接入 dsh**
16. sidecar 起 dsh（headless）— `src/brain/dshBridge.js`：子进程调用 `npx @deepseek-ai/dsh`，桌宠通过本地接口投递任务
17. 桌宠作为任务入口 + 状态指示（思考中/完成）

## Workspace setup

- 已核实：`d:\code` **不是 git 仓库**（`git rev-parse --is-inside-work-tree` → fatal）。本项目建议单独建仓：
  - `mkdir d:\code\deepseek-desktop-pet`，进入后 `git init`
- 首次写文件前执行 `git status --short` 与 `git branch --show-current`。
- 全新仓库、个人自用小项目：可直接在 `main` 开发；若想隔离里程碑，用 `git worktree add -b feat/m1-desktop-pet ../deepseek-desktop-pet-m1`。
- 现有 `d:\code\todo-cli`、`d:\code\my-first-repo` 与本项目无关，不要混入改动。

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| 点击穿透实现踩坑（穿透一次就再也点不到角色） | `setIgnoreMouseEvents` 配合渲染层 mousemove 动态开关；M1 就用记事本窗口做穿透验证 |
| 全屏游戏/多显示器下置顶失效 | 接受该限制（自用），需要时提供「置顶开关」托盘项 |
| Live2D 模型授权/格式复杂 | M1–M2 先用序列帧；M3 再评估，必要时参考 Open-LLM-VTuber |
| 闲聊烧钱 | 固定缓存前缀（0.02 vs 1 元/百万）+ 每日预算硬上限（AC-6） |
| API Key 泄露 | 只存 Credential Manager，源码/配置/日志零明文（AC-5） |
| dsh v0.1 接口变动 | 放 M5，用 sidecar 旁路集成，不侵入核心 |
| 二创形象版权 | 仅个人自用 + 注明出处；日后公开再换原创或官方 Logo |

## Verification steps

- **AC-1**：启动计时看窗口；用记事本置于下层，点击透明区应能点到记事本，点击角色区有反应。
- **AC-2**：点击角色看气泡出现中文台词；拔网线对照本地台词。
- **AC-3**：输入「讲解快排」，查日志确认 `model=deepseek-v4-pro` 且思考模式开启，宠物出现「思考」动画。
- **AC-4**：断网启动进程，确认不崩溃、界面无错误堆栈。
- **AC-5**：全仓与日志 `grep` API Key 片段，应搜不到。
- **AC-6**：把每日预算调到极小（如 100 token）触发降级，确认切到「仅本地台词」。

---

## Consensus review

### Planner draft v1（摘要）
选定 Option A（Electron），M1–M5 十七步，每步落到具体新建文件。

### Architect challenge v1
- **Steelman 反方**：Electron 体积/内存对「常驻桌宠」不划算，Tauri v2 才是长期正解；且 Windows 下透明+逐像素命中在 Electron 需要 hack，不如 Tauri 的原生 `set_shape` 干净。
- **反驳是否成立**：部分成立。但 Option B 需要先装 Rust + MSVC 工具链，与 driver 1「上手速度」直接冲突；本机现状（无 Rust）使 Tauri 在 M1 就要多花一大段环境搭建。保留 Tauri 作为 **M6 之后的演进选项**，不进本 plan。
- **Tradeoff tension**：**上手速度 vs 长期体积/内存**。取舍依据：自用、优先跑通 → 牺牲体积选 Electron。
- **Synthesis**：M3 形象层参考 Option C（Open-LLM-VTuber）而不 fork，兼得「快」与「表现力」。

### Critic verdict v1

| 维度 | 状态 | 备注 |
|---|---|---|
| Principle consistency | ✓ | Option A 符合「最小代码/范围纪律」 |
| Alternative exploration | ✓ | 三选项，B/C 有 invalidation rationale |
| Risk mitigation clarity | ✓ | 每条风险有对应 mitigation |
| AC testability | ✓ | 6 条 AC 均可二值验证 |
| Verification concreteness | ✓ | 每条 AC 有可执行验证动作 |
| File/line coverage | ✓ | 实施步骤 100% 指向具体新建文件 |

**Verdict: APPROVED**

**Reservations（仍有保留）**
- 步骤 4（`electron/main.js` 的穿透实现）风险最高，plan 没给回滚路径 —— 若 `setIgnoreMouseEvents + mousemove` 方案在 Windows 上表现抖动，需要改用 `setShape`，届时应把该分支写进 `src/renderer/pet.js` 的注释与 README，而不是临时拍脑袋。
- 步骤 12 的 v4-pro **升级 router 判据未量化**（什么算「硬请求」）。建议在 `src/brain/deepseek.js` 里定义：输入长度 > 200 字符 或 命中「讲解/证明/写代码/为什么」关键词 或 用户点「认真思考」按钮。
- 每日预算的**计数口径**未定（输入+输出都算吗？缓存命中的输入算不算？）。建议按「实际计费 token」计，并在 `config/app.config.json` 写明。

## ADR

- **Decision**：用 **Electron**（Option A）+ 直连 DeepSeek API 的两层结构实现自用桌宠；dsh 以 **sidecar（headless 子进程）** 方式在 M5 接入。
- **Drivers**：driver 1（上手速度）+ driver 2（生态成熟）起决定作用；driver 3（环境统一，与 dsh 同为 Node）。
- **Alternatives considered**：
  - Option A Electron —— **chosen**（门槛最低、生态成熟、与 dsh 同环境）。
  - Option B Tauri v2 —— **rejected**（需先装 Rust + MSVC，与「求快」冲突；留作 M6 后演进）。
  - Option C Fork Open-LLM-VTuber —— **rejected 为整体方案**，仅作 M3 形象/Live2D 参考源（避免高耦合）。
- **Why chosen**：自用场景下「两周内看到桌面上动起来」比「省几十 MB」更重要；Electron 让无 Rust 环境的新生也能直接开跑。
- **Consequences**：
  - 正：开发快、库多、和 dsh 共用 Node。
  - 负：安装包约 150MB+、常驻内存偏高；穿透需自行处理。
  - 约束：M3 形象如换 Live2D，需评估授权与性能。
- **Follow-ups**（本次不做）：
  - Tauri v2 迁移评估（体积优化）。
  - 官网/预览页 + `iga-pages` 部署（仅当项目要对外展示时）。

## Review trail

- Planner draft v1：Option A（Electron）+ M1–M5 共 17 步。
- Architect challenge v1：核心 tension = 上手速度 vs 体积/内存；steelman 指向 Tauri，判定不成立（环境成本）。
- Critic verdict v1：**APPROVED**，附 3 条 RESERVATION（穿透回滚、router 判据、预算口径）。
- Final iterations: 1 / 3
