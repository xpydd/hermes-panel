# Hermes Panel

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-4B44CC?logo=tauri)](https://v2.tauri.app/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite)](https://vite.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-3-6E9F18?logo=vitest)](https://vitest.dev/)

一个基于 **Tauri v2** 的 Hermes Agent 桌面管理工具，目标不是做宣传页，而是把 Hermes 的本地运维动作集中到一个可用的桌面控制台里。

**目标用户**：使用 Hermes Agent 的开发者及运维人员

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

**当前版本聚焦这些能力**：

- **仪表盘概览**：一目了然展示 Hermes 安装状态、版本号、Gateway 健康状态、当前身份与模型、待修复问题数、会话总数等关键指标
- **初始化安装**：官方一键安装、源码安装、setup / model / gateway setup 入口，支持任务进度实时追踪与步骤详情
- **状态检测**：`hermes status`、`doctor`、Gateway 状态、本地依赖检查，提供逐项健康度检测（ok / warning / error / info）
- **异常修复**：自动诊断问题严重程度（low / medium / high），提供修复建议与一键修复入口，支持危险操作二次确认与自动备份
- **模型配置**：支持 OpenRouter 等多 provider 管理，常用表单配置、`config.yaml` / `.env` 原始编辑、diff 预览对比变更
- **消息历史**：优先读取 `~/.hermes/state.db` 的 Hermes 会话和消息，失败时回退 `~/.hermes/sessions/*.json`，支持按关键词搜索过滤
- **Profiles 管理**：创建、切换、导入导出、重命名、删除，关联身份与模型配置
- **设置面板**：语言切换、开机启动、关闭到系统托盘等个性化选项
- **自动更新检测**：检查 Hermes 官方最新版本，提示可用的更新

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
npm run tauri build -- --debug
```

当前 `bundle.targets` 默认只打 macOS `.app`，先避开开发阶段的 DMG 失败问题；需要 DMG 时再显式指定对应 target。

## 说明

- 交互式命令仍然在系统终端中执行，避免桌面 UI 去硬接管 Hermes CLI 的交互流程。
- 配置备份和命令历史保存在 `~/.hermes-panel/`。
- 会话消息历史来自 Hermes 自身的 `state.db / sessions` 数据，而不是应用自己再维护一份副本。
