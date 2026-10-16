# deepseek-desktop-pet 方案 Spec

> Status: ALIGNED
> Author: ns（大一 · 计算机科学与技术）
> Last updated: 2026-10-16
> Mode: default

## Background

目标：在 **Windows** 上做一个 DeepSeek 主题的可爱「桌宠」，形象贴合网络流行的 DeepSeek 拟人形象；桌宠可接入 DeepSeek 官方模型（`deepseek-v4-flash` / `deepseek-v4-pro`）与 DeepSeek Harness（`dsh`）能力。**用途：仅个人自用。**

## 调研结论（已核实 2026-10-16）

| 项 | 结论 | 来源 |
|---|---|---|
| 模型 | `deepseek-v4-flash` / `deepseek-v4-pro` 为当前在售 API 模型；1M 上下文、最大 384K 输出；支持思考模式、JSON Output、Tool Calls | DeepSeek API 文档 |
| 旧模型名 | `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 弃用，分别等价于 v4-flash 的非思考 / 思考模式 | DeepSeek API 文档 |
| 价格 | flash：输入 0.02（缓存命中）/ 1 元、输出 2 元（每百万 token）；pro：0.025 / 3、6 元 | DeepSeek API 文档 |
| 接入地址 | OpenAI 格式 `https://api.deepseek.com`；Anthropic 格式 `https://api.deepseek.com/anthropic` | DeepSeek API 文档 |
| Harness（dsh） | DeepSeek 官方开源 Agent Harness，MIT，开发者预览 v0.1，「一切皆插件」（模型/工具/技能/会话/沙箱/存储/循环/调度/UI 均可替换）；`npx @deepseek-ai/dsh web` 启动本地 Web UI，另有 headless 模式 | DeepSeek 官方 / deepseekharness.online |
| DSH Desktop | 社区已有 dsh 的桌面 GUI（原生目录选择、自定义 Agent 预设 `.dshpreset` 导入导出）→ 本方案要做的是「桌宠悬浮层」，不是又一个 Harness GUI | GitHub |
| 形象 | DeepSeek 官方只有抽象蓝色鲸鱼 Logo，**从未推出/认领任何拟人形象**；网上「鲸鱼娘 / Whale-chan / 蓝色大肥鱼 / D 老师」均为网友二创 | 媒体报道 |
| 桌宠技术 | Tauri v2 / Electron 可实现无边框、透明、置顶、点击穿透窗口；Live2D 已有成熟「pet mode」实现（Open-LLM-VTuber） | CrabNebula / Open-LLM-VTuber |

## In scope

- Windows 10/11 桌面透明置顶桌宠外壳（自由拖拽、点击透明区域穿透）
- 角色动画（待机/说话/思考/睡觉等状态）与情绪表现
- 接入 DeepSeek API：v4-flash（闲聊/情绪/动作 JSON）+ v4-pro（按需难题）
- 宠物人格设定（Persona）与本地预设台词
- 与 dsh 的集成（第 2 阶段：sidecar 或 UI 插件）
- API Key 安全存储、每日 token 预算与降级

## Out of scope

- macOS / Linux / 手机端（先只做 Windows）
- 自建模型训练 / 微调
- 商业化、上架应用商店、代码签名、多用户配置（**自用，不做**）
- 完整的 dsh Harness GUI（已有 DSH Desktop，不重复造）
- 部署到 Web（`iga-pages` 属 Web 部署能力，与桌面应用无关；若后续要做项目官网/预览页再另开）

## Assumptions

- 运行环境：Windows 10/11，本机已装 Node.js（dsh 与部分技术栈需要）
- 用户自行申请并配置 DeepSeek API Key（按量付费，仅自己用）
- 第 1 阶段先做「能跑起来的最小可爱桌宠」，不追求 3D / 高精度 Live2D
- **桌宠为本地个人自用程序**（Q1 已定）：不需要签名/上架/多用户配置；形象可用现成二创图并注明出处

## Solution（架构草图）

三层解耦：

**1. 宠物外壳层（Pet Shell）**
- 技术选型：**Tauri v2 优先**（体积小、原生透明窗口、Rust 侧可做逐像素命中测试），**Electron 备选**（生态成熟、Live2D/Node 库直接可用）
- 关键能力：无边框 + 透明背景 + 置顶 + 点击穿透（透明像素穿透、角色像素可点）+ 托盘图标 + 自由拖拽/贴边
- 动画：精灵图/序列帧（简单）或 Live2D（表现力强但需模型资源授权）；**逐像素 alpha 命中测试**决定是否接收点击
- 交互：左键点击 / 双击 / 右键菜单 / 快捷键唤起

**2. 大脑层（Brain / Model Adapter）**
- 直连 `https://api.deepseek.com`（OpenAI 兼容格式）
- 分级调用：默认 `deepseek-v4-flash`（非思考模式）做闲聊、情绪与动作 JSON；遇到「讲解/推理/写代码」类硬请求，升级到 `deepseek-v4-pro`（思考模式）
- 对话→动作：让模型输出 JSON（如 `{"emotion":"happy","action":"wiggle"}`）驱动动画
- 成本优化：固定 system prompt 前缀 → 命中缓存（0.02 元 vs 1 元 / 百万 token）；设每日 token 预算，超限降级为本地台词
- 安全：API Key 存 **Windows Credential Manager / DPAPI**，不写进源码与日志；涉及桌面操作的工具调用需二次授权

**3. 能力层（dsh，第 2 阶段）**
- 方案 A（推荐）：把 dsh 作为 **sidecar 子进程**，桌宠通过其 headless 模式/本地接口发起任务，桌宠只做「入口 + 表情反馈」
- 方案 B：把桌宠做成 dsh 的一个 **UI 插件**（合成度更高，但受 v0.1 预览版稳定性约束）
- 理由：dsh 仍是 v0.1 开发者预览，先把核心桌宠做稳，再接入

## Build vs Reuse（可行性对比）

| 路线 | 成本 | 风险 | 适用 |
|---|---|---|---|
| 从零做（Tauri v2 + 精灵图） | 中 | 需自研透明/穿透/命中测试 | 想学技术栈、要 Windows 轻量 |
| 从零做（Electron + Live2D） | 中 | Live2D 模型授权 | 想要最好表现力 |
| Fork Open-LLM-VTuber 桌宠模式 | 低 | 需改造 DeepSeek 适配 + 形象资源 | 想最快跑通、强复用 |

建议（自用场景，求快）：先用 Fork / 参考 Open-LLM-VTuber 的 pet mode 快速跑通玩法，再决定要不要自研 Tauri 版本。

## 分阶段路线图（里程碑）

- **M1** 能跑的最小桌宠：透明置顶窗口 + 一张待机图 + 点击冒泡本地台词（不联网）
- **M2** 接入模型：接 v4-flash，点击闲聊、情绪 JSON 驱动动画
- **M3** 形象与表现：换成鲸鱼娘形象（现成二创图 + 注明出处），待机/说话/思考/睡觉动作
- **M4** 分级与成本：硬任务切 v4-pro；加 token 预算、缓存前缀、Key 安全存储
- **M5** 接入 dsh：sidecar 起 dsh，桌宠作为任务入口与状态指示
- **M6**（可选）打包为本地安装包（自用，无需签名/商店发布）

## Edge cases & risks

| 类别 | 说明 |
|---|---|
| 边界条件 | 多显示器 / DPI 缩放 / 全屏游戏下置顶行为；贴边吸附 |
| 失败模式 | 断网 / Key 失效 / 超预算 → 降级为本地动画与台词，不崩溃、不弹栈 |
| 风险（IP） | 「鲸鱼娘」为网友二创（上善无形 的 OC Mingyue、ZipZipPipe 贴纸），非官方；**仅个人自用风险可接受**（注明出处）；若日后公开，改用原创设计或官方抽象蓝鲸 Logo |
| 风险（稳定） | dsh 为 v0.1 预览，接口可能变；建议旁路集成 |
| 缓解 | dsh 放第 2 阶段；功能开关可降级；形象出处可随时替换 |

## Acceptance criteria

- AC-1 启动后 ≤3s 出现透明、无边框、置顶的桌宠窗口；点击角色像素有响应，点击透明像素鼠标事件穿透到下层窗口。
- AC-2 点击角色 → 气泡显示一句来自 `deepseek-v4-flash`（非思考模式）的中文台词，或命中本地预设台词。
- AC-3 输入「讲解快排」类硬请求 → 调用 `deepseek-v4-pro`（思考模式），宠物显示「思考」动画，最终以气泡/面板返回结果。
- AC-4 断网或 API Key 失效时，宠物仍展示本地动画并有预设台词，进程不崩溃、不输出错误堆栈到界面。
- AC-5 源码、日志、配置文件中均不出现明文 API Key（Key 存于 Windows Credential Manager / DPAPI）。
- AC-6 当日 token 消耗达到设定上限后，自动切换到「仅本地台词」模式。

## Open questions

- ~~Q1 自用还是公开发布？~~ → **已定：仅个人自用**（不做签名/上架，Key 自己配）。
- ~~Q2 形象来源~~ → **已定：用现成网友二创图（Whale-chan 等），个人自用 + 注明出处**；后续可换官方抽象蓝鲸 Logo。
- **Q3** 外壳技术栈最终选 Tauri v2 还是 Electron（是否用 Live2D）—— 交由 dev-plan 定。
- **Q4** dsh 集成用 sidecar 还是 UI 插件 —— M5 前再定。

## Core entities (ontology)

| Entity | Type | Key fields | Relationship |
|---|---|---|---|
| Pet Shell | 组件 | window(transparent, topmost, click-through), hit-test | 承载 Persona 与 Action |
| Persona | 配置 | name, system_prompt, voice | 决定 Brain 输出风格 |
| Brain (Model Adapter) | 组件 | base_url, model_tier, api_key_ref | 调用 DeepSeek API |
| Action / Emotion | 数据 | emotion, action, duration | 由 Brain 的 JSON 输出驱动，作用于 Pet Shell |
| dsh Sidecar | 进程 | profile(headless), task | 由 Pet Shell 触发 |

## Interview metadata

- Mode: default
- Waves: 2
- Final ambiguity: ~18%（Q1/Q2 已解决，Goal/Scope/AC 清晰）
- Status: PASSED
