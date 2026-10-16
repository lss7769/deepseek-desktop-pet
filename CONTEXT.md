# Context

## Glossary

| Term | Meaning | Notes |
|---|---|---|
| Desk Pet（桌宠） | 透明、置顶、可穿透的桌面宠物程序 | 本项目交付物；Windows 优先 |
| Pet Shell | 桌宠外壳层，负责窗口与动画 | 建议 Tauri v2 / Electron |
| Brain（Model Adapter） | 大脑层，直连 DeepSeek API | 分级：flash 闲聊 / pro 难题 |
| deepseek-v4-flash | DeepSeek API 模型 | 便宜、快；默认闲聊与情绪 JSON |
| deepseek-v4-pro | DeepSeek API 模型 | 贵、强；按需难题/推理 |
| DeepSeek Harness（dsh） | DeepSeek 开源 Agent Harness | MIT；开发者预览 v0.1；一切皆插件 |
| Whale-chan / 鲸鱼娘 / 蓝色大肥鱼 | 网友自创的 DeepSeek 拟人形象 | **非官方**；官方仅有抽象蓝鲸 Logo |
| Persona | 桌宠人格设定 | 名字、system prompt、语气 |

## Aliases / rejected names

- 官方吉祥物：无（DeepSeek 从未推出）
- `deepseek-chat` / `deepseek-reasoner`：2026-07-24 起弃用，勿在新代码使用
