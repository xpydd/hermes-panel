# Hermes Panel

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-4B44CC?logo=tauri)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite)](https://vite.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-3-6E9F18?logo=vitest)](https://vitest.dev/)
[![License](https://img.shields.io/badge/License-Apache%202.0-D22128?logo=apache)](https://www.apache.org/licenses/LICENSE-2.0)

一个基于 **Tauri v2** 的 Hermes Agent 桌面管理工具，把 Hermes 的本地运维动作集中到一个可用的桌面控制台里。

**目标用户**：使用 Hermes Agent 的所有人员。

**技术栈**：
- **框架**：Tauri v2 — 使用 Rust 构建极简二进制体积，实现原生跨平台体验
- **前端**：React 19 + TypeScript 5 — 现代声明式 UI，保证类型安全
- **构建**：Vite 7 — 快速热更新与生产构建
- **测试**：Vitest + Playwright — 单元测试与端到端视觉回归测试

**项目特色**：
- 🚀 极小安装包 — Tauri 打包后体积远小于 Electron 应用
- 🎨 原生体验 — 直接调用系统能力，避免 WebView 样式不一致问题
- 💻 终端交互 — 交互式命令仍在系统终端执行，保持与 Hermes CLI 的原生交互体验
- 🛡️ 数据安全 — 配置备份和命令历史保存在 `~/.hermes-panel/`，会话消息历史来自 Hermes 自身的 `state.db / sessions` 数据
- 🌍 多语言支持 — 内置简体中文（zh-CN）与英文（en-US）界面切换
- ⚡ 实时监控 — 定时轮询 Hermes 状态，仪表盘实时展示核心指标

## 功能规划 (Roadmap)

### ✅ 已实现功能
- [x] **仪表盘概览**：实时展示 Hermes 安装状态、版本号、Gateway 健康状态、当前身份与模型、待修复问题数等。
- [x] **初始化安装**：支持官方一键安装、源码安装、setup / model / gateway setup 入口，具备任务进度追踪。
- [x] **状态检测**：集成 `hermes status`、`doctor`、Gateway 状态及本地依赖检查，提供健康度评分。
- [x] **异常修复**：自动诊断问题严重程度，提供修复建议与一键修复入口，支持自动备份。
- [x] **模型配置**：支持 OpenRouter 等多 Provider 管理，提供 `config.yaml` / `.env` 原始编辑及 Diff 预览。
- [x] **消息历史**：优先读取 `state.db`，支持 `sessions/*.json` 回退，具备关键词搜索与过滤功能。
- [x] **Profiles 管理**：支持创建、切换、导入导出、重命名及删除。
- [x] **多语言支持**：内置简体中文与英文界面切换。
- [x] **系统集成**：支持开机启动、关闭到系统托盘、自动更新检测。

### 🛠️ 待实现功能 (TODO)
- [ ] **模型连接测试**：增加模型配置的连通性测试 (Link Testing)，实时反馈 API Key 或 Base URL 是否有效。
- [ ] **会话渠道**：支持会话渠道 (Session Channels) 的配置，提供更丰富的消息源接入。
- [ ] **高级日志分析**：对 Hermes 错误日志进行更深度的摘要与分析。
- [ ] **插件系统**：支持用户自定义运维脚本或插件。


## 开发

```bash
npm install
npm run tauri dev
```

## 测试

```bash
# 单元测试
npm test

# 端到端测试（需先启动开发服务器）
npm run tauri dev
npx playwright test
```

## 打包

```bash
# 构建当前架构的安装包 (默认已开启 dmg)
npm run tauri build

# 构建 Intel 芯片 (x86_64) 的 DMG
npm run tauri build -- --target x86_64-apple-darwin
```

## 说明

- 交互式命令仍然在系统终端中执行，避免桌面 UI 去硬接管 Hermes CLI 的交互流程。
- 配置备份和命令历史保存在 `~/.hermes-panel/`。
- 会话消息历史来自 Hermes 自身的 `state.db / sessions` 数据，而不是应用自己再维护一份副本。

## 开源协议

本项目基于 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 开源。
