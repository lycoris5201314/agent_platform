# v0.53.3 发布验收记录

验收日期：2026-10-13。结论：本轮指定 Windows 环境验收通过；正式包可匿名下载、安装和启动，安装后的真实 DeepSeek 对话及完整窗口回归通过。

## 版本和正式资产

- [GitHub Release：v0.53.3](https://github.com/lycoris5201314/agent_platform/releases/tag/v0.53.3)
- [下载 Windows x64 Setup](https://github.com/lycoris5201314/agent_platform/releases/download/v0.53.3/Agent-Foundry-Setup-0.53.3-x64.exe)
- [云端验收记录](https://github.com/lycoris5201314/agent_platform/actions/runs/38387312889)：`success`
- 标签对应提交：`323ce0397b4315faf181e716dedce76ef160cf54`
- 文件名：`Agent-Foundry-Setup-0.53.3-x64.exe`
- 下载大小：`199717100` 字节
- SHA-256：`36b46f1e00aa3e31a280ad795229eea1745259e24691c1afcaf015e6a30ad2e9`

通过公开 Release 链接下载，未携带 GitHub 身份凭据，HTTP 返回 200；实际文件大小与 GitHub 资产信息一致。下载文件的 SHA-256 同时匹配 Release 校验文件和 GitHub 资产摘要。本机网络使用已有的 Clash 7890 代理，这不是对所有网络环境可达性的保证。

## 本轮修复

1. 历史导航“回到最新”按真实滚动范围定位，内容或视口尺寸变化后继续跟随底部；主动浏览历史时停止跟随。
2. 已分批加载的正文不再使用占位高度虚拟化，避免滚动时重算高度与历史定位竞争；拖动导航滑块也会取消底部跟随。
3. 保留并验收 v0.53 的底部消息输入框拖动、位置复位，以及 v0.52 的图片预览和弹窗拖动修复。
4. 公开仓库的更新检查不再强制要求 GitHub 令牌；重写 README，明确功能来源、使用方法与边界。

此前 v0.53.0 / v0.53.1 云端验收失败；v0.53.2 本机打包验收再次发现问题后主动取消发布，未把这些版本当作验收成功的安装包。

## 验收覆盖

| 层级 | 实测内容 | 结果 |
| --- | --- | --- |
| 干净云端 Windows | 类型检查、Lint、101 项单元测试、生产构建、3 项渲染/包体检查、App Server 协议和发布流程检查 | 通过 |
| 云端发布包 | 解压程序启动与关键 UI、Setup 全新安装与关键 UI、卸载清理 | 通过后才发布 |
| 本机常用解压目录 | `release/Agent Foundry/Agent Foundry.exe` 启动、真实 DeepSeek 调用、内置 Codex 和 ConPTY、关键 UI | 通过，原 `agent.env` 字节级保留 |
| 公开下载文件 | 匿名下载、字节数、SHA-256、安装后读取 `app.asar` 版本 | 通过，确认为 0.53.3 |
| 下载后安装的程序 | Web/API 启动、内置 Codex 0.155.1、Windows ConPTY、真实 DeepSeek 对话 | 通过 |
| 下载后完整窗口流程 | 历史搜索/定位、延迟布局、阅读位置、图片解码、弹窗和输入框拖动、窗口缩放、移动后发送、设置页、草稿恢复、两个独立对话窗口 | 通过 |
| 测试清理 | 同步卸载临时安装，删除临时安装目录与其中复制的 Key 配置 | 通过 |

本机系统为 Windows 11 25H2 x64（系统版本 10.0.26200）。真实模型测试使用已配置的 DeepSeek `deepseek-v4-flash`，要求返回 `RELEASE_RUNTIME_OK`，不要求模型执行文件工具。窗口场景使用独立 Mock 数据以保持回归可复现；不能把这些 UI 测试解释为所有模型、工具和业务任务都已验证。

首次公开下载包的完整 UI 测试超过 180 秒限时，安装、启动、真实模型及关键 UI 当时已成功。随后仅为验收进程添加 `--disable-background-timer-throttling`，避免窗口被其他应用遮挡时浏览器后台计时器节流；同一下载文件、相同功能断言及 180 秒时限下完整流程通过。未修改安装包、未增加超时、未跳过失败断言。

## 重现方式

在本仓库开发环境中，先退出 Agent Foundry，再用已下载的正式文件运行：

```powershell
node tests/verify-installer.mjs "下载目录/Agent-Foundry-Setup-0.53.3-x64.exe" --full-window
```

需要增加真实模型检查时，显式提供已有本机配置文件：

```powershell
node tests/verify-installer.mjs "下载目录/Agent-Foundry-Setup-0.53.3-x64.exe" --full-window --provider-env "本机配置目录/agent.env"
```

`--provider-env` 是发布后的验收脚本扩展，不改变已发布应用二进制。配置只复制到隔离临时安装目录，不输出 Key 内容、不上传仓库，最终随该目录清理。真实模型测试会产生少量对应服务商的 API 用量；CI 不使用个人 Key。

本次机器上的详细日志保存在被 Git 忽略的 `build/github-download-check-20261013/` 下，包括 `unpacked-0533-check.log`、`installer-0533-local.log`、`downloaded-0533-acceptance.log`（首次超时）及 `downloaded-0533-acceptance-timers.log`（最终通过）。不公开用户配置或对话数据。

以上证明指定环境和场景通过，不保证所有电脑、杀毒策略、模型权限、网络和项目依赖均相同。安装包尚未进行商业代码签名，Windows 仍可能提示 SmartScreen 警告。
