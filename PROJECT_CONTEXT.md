# Project Context

> **最后更新**: 2026-01-15 20:51
> **当前焦点**: 持续优化插件功能并在市场上正式运行

## 最近核心进展

- **自动化发布**: 成功发布插件到 VS Code Marketplace (v0.1.4)，实现 GitHub Actions 标签触发的自动发布流水线。
- **双远程仓库**: 配置 GitHub（公开）+ Azure DevOps（私有备份）双平台发布策略。

## 最近对话摘要

- **2026-01-15 20:51**: 完成 VS Code 插件发布与自动化部署 (v0.1.4)；修复 Node 20 兼容性问题；实现 sync-github.sh 自动推标触发 Actions。
- **2026-01-15 20:06**: 配置 GitHub/Azure DevOps 双远程仓库发布；创建选择性同步脚本（排除 docs/.agent/scripts/conversation_records）。
- **2026-01-15 18:52**: README 全面更新以反映 SwitcherProxy v10 功能；优化 OAuth 对话框移除超长链接显示。
- **2026-01-15 15:53**: SwitcherProxy v6→v10 调试：修复 VBScript 语法错误、taskkill 执行问题、跨平台重构。
