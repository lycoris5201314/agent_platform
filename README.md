# Agent Foundry Local

一个本机单用户优先、保留多租户接口的持久化 Agent 平台。它复用 Codex App Server，并在外层实现任务状态机、SQLite 队列、租约/心跳、持久信号、审批、Docker 沙箱、隔离式会话记忆、多 Agent worktree 和验证闭环。

## Windows 桌面版（推荐给日常使用者）

运行 `release/Agent-Foundry-Setup-0.30.0-x64.exe` 完成安装。桌面版会自动启动 Web、API 和任务调度器。关闭主窗口后任务会留在系统托盘继续运行；从托盘选择“退出”会安全暂停正在执行的任务、关闭服务并释放端口，任务在下次启动后继续。自 v0.3.1 起只发布 Setup 安装版，不再生成 Portable 版本。

桌面版内部仍使用两个仅绑定到 `127.0.0.1` 的随机临时端口，这是 Web 界面与本机 API 通信所必需的实现细节。端口由 Windows 自动选择，不对局域网开放，并随应用退出自动释放。

点击“新建对话”会先打开一个临时对话栏：未发送时不会创建数据库记录，也不会出现在左侧任务列表；首次发送后才生成正式任务，标题默认取首行文字。按 `Esc`、点击“稍后继续”或切换到其他对话时，文字和附件会在本次应用会话中保留，再次新建即可恢复；只有点击“丢弃草稿”才会清空。草稿不写入磁盘，退出应用后自动消失。工作区可直接从 Windows 磁盘选择。

左侧对话按项目文件夹分组，使用完整目录路径识别项目，因此不同磁盘上的同名文件夹不会混在一起。同一项目的新对话、对话分支和使用独立 worktree 的子 Agent 都留在原项目组；项目标题可以折叠，历史版本创建的分支会在启动时自动补齐项目归属。

搜索框右侧的筛选按钮可按运行状态、Provider、模型和项目联合过滤对话。筛选在 SQLite 全量任务库中先执行、再分页，选项会显示实际对话数；不会只在当前已显示的 100 条中筛选。对话分支和 worktree 依然按原项目归类。

左侧任一对话都可以像聊天软件一样拖到主窗口外，变成没有任务侧栏的独立窗口；标题栏也提供“弹出窗口”作为可靠入口。不同对话窗口各自保留输入框、附件、事件流与工作区面板，可以同时发送和观察任务；同一个对话只允许一个独立窗口，重复弹出会聚焦已有窗口。点击“放回主窗口”可回到主窗口并自动选中该对话。实际同时运行数量由“设置与运行时”中的 Worker 并发和 Provider 并发控制。

左侧“活动”视图集中显示运行中、等待用户处理和有未读结果的任务；未读完成/失败结果会标粗并显示“新”。应用在后台或正在查看其他任务时，可发送 Windows 桌面提醒，点击提醒会直接返回对应对话；提醒策略可在“设置与运行时”选择“仅后台”“始终”或“关闭”。快捷键 `Ctrl + Alt + U` 可打开活动视图。

任务运行后，执行卡片展示命令、工具调用、审批、等待、验证与错误，并实时合并显示 Codex App Server 提供的详细推理摘要。这里展示的是模型公开的摘要，不是私有原始思维链；同一推理步骤和工具操作的增量会归并为一条，Token 用量、输出分片、环境准备和记忆读写等后台事件仍完整持久化，但不会挤满对话页面。

用户消息和 Agent 回复使用安全的 GitHub Flavored Markdown 渲染，支持标题、**加粗**、列表、引用、链接、行内代码、代码块和表格；原始 HTML 不会作为页面代码执行。

对话输入框和新对话草稿支持从资源管理器拖入图片，也支持直接粘贴剪贴板图片；图片在发送前显示缩略图和文件名，可逐张移除。也可以只发送图片而不输入文字，普通文件附件仍以文件卡片显示。

输入区始终约束在窗口可视范围内。窗口高度较小、Windows 高缩放或附件较多时，附件改为单行横向滚动，输入正文区域自行滚动；低高度窗口会隐藏快捷键提示，避免遮挡发送按钮。

在新对话或连续对话的输入框键入 `/` 会打开快捷命令菜单，可继续输入名称筛选，并用方向键和 Enter 执行。当前可直接打开状态、文件、本轮变更、终端、模型、推理深度、压缩、分支、审阅、委派、停止、设置和反馈导出等入口。

按 `Ctrl + K` 可打开全局快速切换器。它直接查询 SQLite 中的完整未归档任务库，不受左栏当前分页限制；可按标题、提示词或工作区搜索对话，也可搜索新建、自动化、持续目标、活动、终端、工作区和设置等命令。使用方向键选择并按 Enter 打开，结果会显示项目、状态和未读标记。

左侧“自动化”可创建执行一次、固定间隔、每天或每周运行的 Agent 任务，并支持编辑、暂停、恢复、立即运行、删除和查看运行历史。计划保存在 SQLite 中；关闭窗口但保留托盘运行时会准时触发，完全退出期间错过的计划会在下次启动时补运行一次。每次执行都会创建独立对话，因此模型过程、审批、文件变更和验证结果都可追溯。也可以在输入框键入 `/automations` 直接打开。

新建对话时可开启“持续目标”，设置最多轮次，并选择 1 小时到 3 天的持久截止时间或不限制。模型每轮完成验证后必须通过结构化工具上报继续、完成或阻塞，以及进度、摘要和下一步；平台只在明确上报继续且未达到轮次/时间上限时重新排队。目标卡片会显示进度、截止时间和下一步，可随时暂停、恢复、追加三轮或结束；到期后可显式延长 4 小时。模型未上报、需要用户输入、遇到阻塞或达到任一上限时都会安全停下，应用关闭期间截止仍会由 SQLite 恢复检查生效，沙箱和审批边界不会因自动续跑而放宽。

左侧“持续目标”打开全局看板，可同时查看不同项目下所有未归档目标。看板区分自动推进、等待前置、需要处理和已完成，集中展示轮次、截止时间、Token 预算、最近总结与下一步。每个未完成目标可选择一个或多个前置目标；依赖写入 SQLite，调度器在所有前置安全完成前不会运行下游目标，并拒绝循环或跨租户依赖。输入 `/goals` 也可快速进入。

右侧文件栏可脱离任务根目录浏览本机磁盘，进入子目录、返回上级或回到当前 Agent 工作区；停止状态下可将浏览位置设为任务的新工作区。文本文件可直接编辑，PDF 和常见图片可内嵌预览，其他二进制文件可交给 Windows 默认程序打开。

每个任务可独立选择模型、推理深度、Codex 沙箱权限（只读/工作区写入/完全访问）、审批策略（非可信操作询问/请求批准/无需批准）以及审批人（用户/自动风险审查）。同一连续对话可在下一轮前调整这些设置。Docker 是外层容器隔离；Docker bridge 模式下模型 App Server 与命令仍共享容器网络，详情会标记为 `unrestricted`，当前版本尚未实现二者的网络命名空间拆分。

模型下拉框只列出已经配置 API Key 且可用于 Codex Responses 协议的 Provider。OpenAI 从 Codex `model/list` 读取实时模型目录；第三方 Provider 当前使用已验证并保存的默认模型配置，避免把未经验证的任意模型名发送给运行时。

每轮对话开始时会记录独立工作区快照，结束后只显示本轮新增、修改或删除的文件以及行数，不再把工作区所有历史未提交变更混在一起；本轮新增文件会作为产物入口显示。分支复制真实对话历史和 Codex rollout，不会插入“继续此分支对话”伪消息。压缩会等待 Codex 完成通知并展示压缩前后上下文占比。

首轮任务完成后，无需重新创建任务：在同一会话底部继续输入消息即可。后续消息会复用原工作区、模型配置和 Codex Thread。完整对话与最近上下文会写入本地 SQLite 记忆，关闭或重启 EXE 后仍可继续；新建任务会创建独立 Codex Thread，且默认只检索本对话记忆。

可在“设置与运行时”直接填写 Provider API Key；密钥由 Windows DPAPI 按当前 Windows 用户加密后写入本地数据库，界面和 API 不回传明文。`agent.env` 仍可用于开发和应急配置，保存后桌面应用会直接重新加载 Provider 与模型并刷新界面，无需重启。没有 Key 时可使用 Mock runtime。

遇到问题时，可在“设置与运行时”点击“生成并打开文件夹”。应用会刷新数据目录下的 `问题反馈资料`，导出全部对话、关键与底层事件、审批、自动化定义/历史和脱敏日志；API Key、`agent.env`、SQLite 数据库、附件正文和工作区文件正文不会复制。对话文字和本机路径仍可能涉及隐私，发送前应检查该目录。

开发者重新生成 Setup 安装版：

```powershell
npm install
npm run desktop:dist
```

构建完成后除 Setup 外，还会刷新 `release/Agent Foundry/` 可直接运行目录，并保留其中已有的 `agent.env`。正式验收使用 `npm run release:verify`：它会真实启动两个独立对话窗口，并在窄窗口、150% 缩放和 20 个附件的组合下验证发送按钮可见且可点击；再从发布目录启动应用。检测到兼容 Key 时必须真实完成一次模型任务，随后验证 Setup 的全新安装、内置 Codex 和 Windows 终端。

Windows 原生模式是默认执行后端，不需要安装 WSL2、Ubuntu、Docker Desktop 或 Git。Codex App Server、验证和交互式 PowerShell 终端均直接在 Windows 上执行，并统一套用当前任务的 Codex Windows 沙箱档位。Git 仅在分支、worktree、差异与提交等 Git 功能中需要。WSL2 与 Docker 保留为可选后端；未配置代码签名证书的自建 EXE 可能触发 Windows SmartScreen 提示。

## 当前能力

- v0.27.0 增加受版本标签控制的 Windows GitHub Release 流程。推送 `vX.Y.Z` 标签后，云端先强制核对标签与 `package.json`，在干净 Windows 环境执行锁定依赖安装、全套源码/协议测试、Setup 构建、解压版启动以及全新目录静默安装启动；全部通过后才上传 Setup、blockmap、`latest.yml` 和 SHA-256，并保留 30 天 Actions 产物。应用内更新不再依赖开发者手工拼装 Release 文件。
- v0.27.1 隔离共享子 Agent 与文件树测试的并发步骤，并让发布失败日志能够稳定指向真实环境差异。
- v0.27.2 修复 Windows 目录联接或符号链接工作区的文件树路径：服务端统一使用已校验的真实根目录计算相对路径，并新增目录联接回归测试。GitHub Actions 的临时目录正是此类路径，因此云端发布与用户选取联接目录现在采用同一条受测逻辑。
- v0.27.3 显式安装 Electron 43 桌面运行时，避免全新 `npm ci` 环境只有 JavaScript 包却没有桌面二进制；同时强制 `electron-builder --publish never`，确保安装器只有在解压版和全新安装验证全部通过后才由发布步骤上传。
- v0.27.4 让解压版验收使用与桌面程序相同的 Node 环境文件解析器；空白 API Key 不会再吞掉下一行模型配置并被误判为已配置。无密钥云端运行打包运行时检查，有本地密钥时仍执行真实 Provider 验收。
- v0.28.0 增加租户隔离的全局任务活动 SSE：并行任务、自动化、持续目标、分支和子 Agent 的状态会即时刷新左侧列表、筛选计数和未读提醒，不再等待 8 秒轮询。高频全量任务请求改为 60 秒故障兜底，空闲时每窗口请求量降低约 87%，SSE 重连后会自动补一次快照。
- v0.29.0 为新对话增加会话级草稿保护：按 `Esc`、点击“稍后继续”或切换对话不再误删尚未发送的文字和附件，再次新建会恢复原内容；显式点击“丢弃草稿”才清空。草稿只留在当前应用内存，不会把潜在敏感提示词明文写入磁盘。桌面冒烟测试会真实输入草稿，依次验证隐藏、恢复和丢弃，并放宽较慢电脑上的能力中心检测等待，减少测试环境与用户环境不一致。
- v0.30.0 将 `Ctrl + K` 升级为全库快速切换器：输入时以防抖方式查询 SQLite，而不是只过滤左栏已加载任务；结果同时覆盖命令与最近/匹配对话，显示项目、状态和未读标记，并支持方向键与 Enter 完成无鼠标切换。桌面冒烟测试会真实搜索一个不依赖当前左栏选择的任务并用 Enter 打开，再搜索英文命令并用 Esc 关闭。
- v0.26.0 为本机对话数据增加在线一致性备份：设置页显示 SQLite `quick_check` 健康状态、备份数量和最近时间，可在任务仍运行时点击“立即备份”。后端使用 SQLite 原生在线备份 API 把 WAL 中已提交事务一并复制到 `.partial` 临时文件，对副本再次运行完整性检查后才原子改名；失败不会留下伪成功文件。只有 owner 可创建包含全库数据的备份，操作写入审计。回归测试会打开备份副本并确认真实任务记录可查询。
- v0.25.0 区分“用户停止任务”和“正常退出应用”：托盘退出或系统正常关闭时，正在准备、执行或验证的任务会保留 Codex Thread 与 checkpoint，原子放回持久队列且不消耗重试次数；下次启动自动继续。关闭阶段禁止调度器再次领取任务，并记录可见的安全暂停事件。新增关闭真实应用、重开 SQLite、再启动并完成原任务的端到端回归测试；用户点击停止仍保持明确的 `cancelled` 语义。
- v0.24.0 将随安装包携带的 Codex 从 0.146.1 升级到 0.155.1，并增加基于 bundled CLI 实时生成 TypeScript 协议定义的契约测试：构建会核对源码使用的每个 App Server 方法是否仍受当前版本支持。审计因此移除了从未存在的 `thread/backgroundTerminals/*` 端点和已下线的 `collaborationMode/list` 调用；设置页直接显示实际 bundled Codex 版本。生产依赖同步升级并通过 `npm audit --omit=dev` 的 0 漏洞检查。
- v0.22.0 将官方 Codex 插件机制接入能力中心：可浏览已安装与市场可用插件、搜索、安装/卸载，并添加、更新或移除本地及 Git 插件市场。服务端只调用 Codex CLI 的结构化 JSON 接口，复用 Agent Foundry 的隔离 `CODEX_HOME`，校验所有插件/市场标识并记录审计；发布验证会在临时目录离线真实完成一次“发现 → 安装 → 卸载”，不会改动用户插件。
- v0.23.0 补齐插件连接授权闭环：能力中心会把 `notLoggedIn` MCP 标为待连接而不是绿色可用，点击“连接”后通过官方 `mcpServer/oauth/login` 启动独立授权会话，保持 App Server 与本机回调存活并轮询完成通知；浏览器未自动打开时仍提供显式授权链接，失败可见且应用退出会回收残留进程。Docker 回调尚未映射时会明确拒绝，避免生成必然失败的授权流程。
- v0.21.0 为长期任务库增加数据库级组合筛选：左侧栏可按进行/等待/完成/停止状态、Provider、模型和项目联合查找，并显示全量分组数量与命中总数。筛选在 SQLite 分页前执行，补充租户/归档/状态和 Provider 索引；项目条件会跟随根任务，所以分支与 worktree 不会漏出原项目。前端用请求序号丢弃旧搜索/筛选响应，避免快速切换时旧结果覆盖新条件。
- v0.20.0 为持续目标增加持久化前置依赖：全局看板可直接建立、跳转和移除依赖，并单独统计“等待前置”目标。队列在 SQLite 查询层排除未满足的下游目标，前置终态完成后自动解锁；服务端拒绝自依赖、循环、跨租户、非持续目标和运行中改依赖，被依赖的归档目标也不会被误删。
- v0.19.0 修正平台 Token 统计语义：每个验证通过的回合只写一条规范化记录，优先使用 Provider 的本轮 `last` 用量，不再把线程累计 `total` 重复相加，也不会把上下文窗口大小误当消耗。设置页按 Provider 展示输入、输出、缓存输入、总 Token 和已验证回合；旧版本未生成规范记录的历史回合不会被猜测补算，真实 DeepSeek 发布验收会强制确认新统计非零。
- v0.18.0 增加全局持续目标看板：跨对话集中显示自动推进、需要处理和已完成数量，以及每个目标的进度、轮次、截止时间、Token 预算、最近总结和下一步。看板直接复用持久目标状态机，可暂停、恢复、追加轮次/时间/Token、结束或返回原对话；查询按租户隔离并排除普通和已归档任务，页面按需加载且只在可见时刷新。
- v0.17.0 增加本机数据生命周期管理：设置页直接显示使用中/归档对话、消息、事件、附件及数据库体积和实际保存位置；已归档对话可二次确认后永久删除。后端只允许删除终态且没有子 Agent 的归档对话，先释放 Docker 沙箱，再级联删除数据库记录和应用复制的附件，绝不删除用户工作区文件，并保留不含正文的审计记录。
- v0.16.0 让异常恢复状态与数据库事实一致：应用重启和 Worker 租约过期会返回“已重新入队/已达到上限并进入死信”两种明确结果，不再把失败误报为恢复成功。对话内新增恢复提示卡；自动重试会显示错误原因、下次时间和当前机会，可立即重试或停止，立即重试保留自动重试预算而不是偷偷重置计数。
- v0.15.0 为持续目标加入跨重启 Token 预算：创建时可选 50K–1M 或不限制，优先使用 Provider 上报的本轮用量，否则对线程累计用量做持久差分；上下文压缩或换线程造成计数回绕时会从新基线继续。达到预算后当前轮仍安全完成并验证，但不会自动排下一轮；目标卡显示已用/预算，用户可显式追加 100K 后恢复。不换算不可靠的跨 Provider 金额。
- v0.14.0 为长对话加入真正的后端轮次分页：详情默认只读取最近 30 轮，点击“加载更早”后每次扩展 30 轮直至完整历史，并按加载范围同步扩大事件窗口。界面显示已加载/总轮数，加载旧消息时保持当前滚动位置；并合并晚到的实时事件，避免较慢的详情响应覆盖更新的数据。
- v0.13.0 修复超长对话超过 1000 条运行事件后详情页反复回到最旧窗口、实时流断点错位和本轮变更查找失效的问题：详情接口默认返回最近 800 条并携带真实总数，增量流继续按游标向前读取；任务运行器只查最近事件，历史本轮差异与问题反馈包则按需读取完整事件。右侧详情会明确显示“已加载 / 总数”，避免把窗口数据误认为完整历史。
- v0.12.0 修复长期使用后第 101 个旧对话无法找到的问题：任务 API 返回真实总数，支持最多 1000 条的渐进加载，并在 SQLite 全部历史中搜索标题、任务正文、工作区和分区；侧栏每次按需再显示 100 个。分页或搜索结果不再误删未加载任务的未读状态，当前正在查看但暂时不在结果页中的对话会保留显示上下文。
- v0.11.0 为持续目标加入可选持久截止时间：创建时可选 1/4/12/24/72 小时，截止值进入 SQLite 和模型约束；当前轮允许安全收尾，但不会再自动排下一轮。应用关闭期间到期的排队/等待任务会在恢复时停止，内存等待句柄同步释放；目标卡片显示截止时间，到期后需由用户明确延长 4 小时才能恢复。
- v0.10.0 在设置页显示实际桌面版本、平台与架构，并提供检查更新入口；检查结果、可用版本和下载状态会反馈到界面，独立的更新器错误事件会写入脱敏诊断日志并发送通知，不再成为未处理异常。自动安装仍要求 GitHub Release 中存在对应安装包和更新元数据；私有仓库还需要发布端访问凭据。
- v0.9.0 移除启动阶段同步导出全部问题反馈资料，反馈包改为需要时即时生成；生产版默认只记录警告以上日志，空闲任务监视由每 4 秒降至每 12 秒。对话列表只在窗口可见时刷新，连续事件请求会合并，切换对话后的过期响应不会覆盖当前文件侧栏，减少长期运行的磁盘与网络开销并消除跨对话竞态。
- v0.8.0 用可操作的“能力中心”替代原始 JSON：按当前工作区展示 Skills、MCP 连接/工具数/授权状态、权限配置和模型能力，可直接启停 Skill、重载 MCP、选择 Skills 目录与 config.toml；一次检测只启动一个 Codex App Server，而不是六个进程。Windows 原生运行时会隔离宿主 Codex 会话、实际使用所选 config.toml，并以无需管理员预配置的 `unelevated` 沙箱回退配合显式权限配置，避免界面显示“工作区可写”而实际只读。
- v0.7.0 将 Markdown、自动化任务和交互终端拆为按需加载模块，主控制台脚本由约 587 KB 降至约 97 KB；长对话默认仅渲染最近 30 轮，可按批次查看历史，并有自动化体积预算测试防止回退。

- Web 控制台：连续对话、安全 Markdown、持久化 Memory、系统文件夹选择器、精简的关键执行过程、停止与重试；最后一条用户消息可撤回到输入框修改后重发
- 持久任务流：队列和 checkpoint 存在 SQLite，进程重启后仍可唤醒定时任务
- 两种 runtime：无需密钥的 `mock`，以及真实的 Codex App Server 双向协议
- 通用 provider 注册表：OpenAI、DeepSeek、自定义 OpenAI-compatible 配置彼此独立
- Windows 原生 workspace：自动创建 Git 工作区，直接在本机准备、执行和验证；无需 WSL2
- 验证闭环：自动识别 Node/Python/Rust，分层执行类型、测试、构建和 Git 检查；失败最多自动修复两次
- 安全默认值：Codex 使用 `workspace-write`，默认关闭网络，审批策略默认为 `on-request`
- 审批闭环：命令、文件变更、工作区操作和用户终端统一显示风险、目录、网络目标与作用范围
- 工作区审阅：懒加载目录树、只读预览、逐文件 diff、暂存/取消暂存/丢弃审批
- 执行记录：稳定 turn/step/tool ID，耗时、退出码、Token、重试次数和大输出 artifact 引用
- Windows ConPTY 终端：每个任务可打开持续交互式 PowerShell，会话支持彩色输出、输入、窗口缩放，并继承该任务的只读/工作区/完全访问沙箱档位
- Windows 桌面集成：对话拖出独立窗口与多对话并行、系统托盘后台运行、任务完成/失败/等待审批通知、活动任务防休眠、窗口位置与尺寸恢复、系统深色模式、右键编辑菜单、图片拖放/粘贴和发送前缩略图预览
- 可靠队列：优先级、Worker lease/heartbeat、Provider/租户并发、指数退避、死信和幂等记录
- 长期任务：Codex 可调用 `durable_wait`，释放 Worker；到期或重启后继续，不依赖长时间 `sleep`
- Docker 沙箱：每任务独立容器、资源限制、工作区/附件/会话挂载和空闲回收
- 长任务：定时 `durable_wait` 与未知时长 `wait_for_external_signal`，均可释放 Worker 并从 SQLite checkpoint 恢复
- 多 Agent：子任务、Git worktree、handoff、合并审批和冲突安全撤销
- 多租户接口：Bearer 鉴权模式、RBAC、行级隔离、DPAPI 密钥、审计与配额
- Codex 管理：模型能力、Skills、MCP、权限目录、MCP 热重载及 OAuth 连接

> DeepSeek 已为 `deepseek-v4-flash` 提供面向 Codex 的 Responses API，可直接复用 Codex App Server 工具流。`deepseek-v4-pro` 暂时不支持该 Responses API；自定义 provider 只有明确实现 Responses API 时才能用于 Codex。

## 快速开始

开发前置条件：Windows、Node.js 22.13+；Git 建议安装但普通任务不强制。WSL2 Ubuntu 与 Docker Desktop 仅在测试对应可选后端时需要。

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

默认地址：

- Web：http://localhost:3000（以终端输出为准）
- API：http://localhost:8788
- 健康检查：http://localhost:8788/api/health

不设置任何 key 时会自动使用 Mock runtime。真实运行 Codex：

```dotenv
AGENT_RUNTIME=codex
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-5.2-codex
```

使用 DeepSeek 时，编辑项目根目录的 `.env`：

```dotenv
DEEPSEEK_API_KEY=sk-你的DeepSeek密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

重启 `npm run dev`，新建任务时选择“Codex App Server”运行时和“DeepSeek”供应商。不要把 Base URL 写成 `/v1`，也不要选择当前尚未支持 Responses API 的 `deepseek-v4-pro`。

不要提交 `.env`；仓库只保留无密钥的 `.env.example`。

## 为什么长等待不使用 sleep

任务需要等待时，Codex 可调用平台注入的 `durable_wait` 动态工具。系统把状态改成 `waiting_timer`，保存 durable signal、`next_wakeup_at` 和 checkpoint。短等待可精确恢复原工具调用；长等待或重启后在同一 Codex thread 中重新检查结果。

```text
queued → preparing → waiting_timer ──到期/重启恢复──→ queued
                     ↓
                  cancelled

queued → preparing → running → verifying → succeeded
                         └───────────────→ failed → retry → queued
```

数据库位于 `.agent-data/agent-platform.db`，自动创建的工作区位于 `.agent-data/workspaces/<task-id>`。

## 目录

```text
app/                 Web 控制台
server/core/         类型、状态机、配置、SQLite、事件总线、Tool Gateway
server/runtime/      Mock 与 Codex App Server runtime
server/sandbox/      每任务 Docker 沙箱与生命周期
server/security/     鉴权身份和 Windows DPAPI 密钥库
server/terminal/     持续交互式 ConPTY / WSL2 / Docker 终端会话
server/workspace/    Windows 原生、WSL2 与 Docker 工作区命令路由
server/workflow/     调度器和任务执行闭环
server/verification/ 验证器
tests/               渲染测试
```

## API

- `GET /api/health`、`GET /api/config`
- `GET/POST /api/tasks`、`POST /api/tasks/:id/messages|steer|handoff`
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/stream`（SSE）
- `GET /api/task-activity/stream`（租户隔离的任务列表活动 SSE）
- `GET /api/tasks/:id/workspace/tree`（懒加载目录）
- `GET /api/tasks/:id/workspace/file|diff`
- `POST /api/tasks/:id/workspace/changes`（生成审批）
- `POST /api/tasks/:id/terminal`（兼容旧版的一次性命令审批）
- `GET/POST /api/tasks/:id/terminal/sessions`，以及会话的 `stream|input|resize|DELETE`（交互终端）
- `GET /api/artifacts/:id`
- `POST /api/tasks/:id/cancel`
- `POST /api/tasks/:id/retry`
- `GET /api/approvals`
- `POST /api/approvals/:id/decision`
- `GET/PATCH /api/settings`、`GET /api/platform/status|audit`、`POST /api/platform/backup`
- 子任务/合并、fork、compact、review、Skills/MCP API；持续交互终端由平台自己的 Terminal Manager 提供
- 自动化任务 CRUD、暂停/恢复、立即运行与历史 API
- 持续目标进度上报、暂停/恢复、有限轮次自动续跑与跨目标前置依赖 API

## 验证

```powershell
npm run typecheck
npm run test:unit
npm run build
npm run appserver:smoke
npm run sandbox:smoke
npm run desktop:smoke
npm run windows:smoke
npm test
```

参考：[Codex App Server](https://developers.openai.com/codex/app-server/)、[Codex 配置参考](https://developers.openai.com/codex/config-reference/)、[DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)、[Codex GitHub 仓库](https://github.com/openai/codex)。
