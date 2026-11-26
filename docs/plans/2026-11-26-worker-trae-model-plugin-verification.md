# Worker TRAE 模型插件基础版验收

基础版在 `codex/worker-trae-model-plugin`（Core）和 `codex/trae-provider-plugin`
（外部插件）两个独立 worktree 完成。原始工作区的未提交修改未搬入。
当前实现架构见 [Worker Model Providers](../designs/worker-model-providers.md)。

## 已实现

- 通用 Worker 模型插件契约、发布物/校验清单验证、能力协商与私有管理 API。
- Worker 账号加密、不可变修订、CAS/幂等导入、私有 Bun 子进程、Responses/SSE 和取消。
- 执行作用域 Key、Job/assignment/模型源核对、固定 Worker、终止/禁用撤销。
- Profile 模型源修订、配置指纹、执行引用、Worker 上的真实 Codex 连接测试。
- Dashboard 文件导入、账号状态、模型刷新、Codex 插件模型选择和激活。
- 外部 `trae-provider@0.1.0`，锁定 Magpie 插件 0.3.7，包含独立本机 SSO/export 助手。
- 插件发布 `.tgz` 和 marketplace 索引；生产部署未更新。

## 验证

Core 相关回归 86 个测试通过；Dashboard 185 个测试通过；外部插件 3 个测试通过。
最终 Worker 账号/流式/授权测试另行复跑通过，含暂时断线后恢复同一活跃执行 Key。
两个仓库相关 typecheck、build 和 `git diff --check` 通过。发布包摘要与索引匹配。

自动化覆盖账号加密/AAD/归属、导入冲突和失败保留、模型限制、管理面隔离、
SSE/非流式、流式取消、进程崩溃、Worker 冲突、Profile source 修订与验证位置。
外部插件使用锁定的真实适配器和模拟上游验证目录、工具与推理转换。

本地使用独立 Luna Home 和 Worker 数据，在持久终端启动当前构建的真实 Service。
确认 8090 监听，登录真实 Dashboard，完成 fixture 插件启用、文件导入、模型目录、
Codex Profile 保存、绑定 Worker 上的真实 Codex CLI 容器验证和激活。
随后普通 Dashboard 会话经正常 Job 调度和 Worker 模型 API 返回预期文本。
最终构建重启后，通过 API 复验连接、普通会话完成和终止授权记录清理。
截图和含本机路径/测试标识的细节放在 Git-ignored `docs/local/worker-trae-test/`。

## 验证边界

真实 TRAE SSO、21 个模型目录和 `gpt-6.1-sol` 的 Worker/Codex 连接测试已验证。
账号由 Luna 新 SSO 授权取得，没有导入 Magpie 已保存的凭据；普通业务 Job 的真实 TRAE
长会话、工具调用和长期运行仍未做本轮验证。
基础版仅 Codex/OpenAI Responses、单账号、固定 Worker；其他范围仍按原方案排除。
子进程是可信插件的故障隔离，不是 OS 安全沙箱。旧账号和发布物修订保留，没有自动回收。

## 0.2.1 授权登录修复与真实验收

Dashboard 提供“登录 TRAE CN”，授权由 Service 中转到 Worker，复用加密账号修订、
模型目录和 Profile 逻辑。“从 Provider 添加”自动绑定账号/Worker/API；已有凭据导入
保留为备用入口。基础版的模型配置和连接测试使用 Codex/OpenAI Responses。

同一浏览器和同一字节账号对比确认：TRAE 接受 `/authorize?flowId=…` 回调路径，
拒绝原先的 `/api/model-providers/login/callback?flowId=…`，并误报 Non-China 员工限制。
Service 现使用 `/authorize`；原 API 回调仍兼容。两个入口共用 Dashboard 会话、登录流
归属、参数重复/体积限制及无凭据重定向。TRAE 适配器在启动登录前拒绝不匹配的路径。
原始客户端状态和 CN 校验仍由 Worker 子进程中的上游适配器执行。

修复前 Service→Worker 回调路径契约和插件拒绝错误路径的测试均失败；修复后通过。
本轮 16 个 Core 回归和 6 个插件测试通过，Core/Dashboard/插件 typecheck、build 通过。
当前发布物为 `trae-provider@0.2.1`，已更新 marketplace 并安装到隔离测试 Home。

重启当前工作树的真实 Service，确认 8090 新进程监听，从 Dashboard 点击登录、完成
字节 SSO，自动得到 `wanghuajie.0@bytedance.com` 的 ready 账号和 21 个模型，页面展示
Responses 协议和真实 Worker/Runner API。从模型列表添加 `gpt-6.1-sol`，真实 Worker
上的 Codex 容器连接测试成功。Worker 保存 AES-GCM 凭据，Service 仅保存摘要；测试后
临时授权记录为 0。模型列表已滚动验证末尾，截图和复验脚本保存在 Git-ignored
`docs/local/worker-trae-test/`。本轮未更新生产部署，也未激活测试配置替换原 fixture。

## 0.2.2 插件声明回调路径

`workerModelProviders[].login.callbackPath` 现在由插件声明。TRAE 插件声明 `/authorize`，
核心按已安装 manifest 注册路径并生成回调 URL，未声明时使用通用 API 回调。核心不再
内置 TRAE 路径，模型配置页面仍使用通用 Provider 接口。登录流冻结路径并拒绝从其他
路径回传同一 flow；manifest 拒绝 URL、路径参数、通配符、遍历及内置路由命名空间。

本轮 13 个登录/回调/Profile 回归、30 个插件注册/marketplace 回归及 6 个外部插件
测试通过；Core、Dashboard、插件 typecheck 和 build 通过。`trae-provider@0.2.2`
已打包、更新索引并安装到隔离测试 Home。重启真实 8090 Service，重新从 Dashboard
发起 SSO，确认回调来自插件声明的 `/authorize`；新登录自动保存为 ready 账号并加载
21 个模型。数据库只读复验确认当前 0.2.2 发布摘要、加密凭据和 Service 账号摘要匹配。
本轮未重复模型推理测试，先前 0.2.1 的真实 Codex 连接验证仍为 transport 实测依据。

## 0.2.3 DeepSeek 连接测试兼容修复

真实 `deepseek-v4.1-flash` 配置测试失败约 8 秒；截取真实 Codex 请求确认包含
`namespace` 客户端工具组和 OpenAI 内置 `web_search`，原适配器只允许 function/custom，
因此在请求到达 TRAE 前返回 HTTP 422 `model_request_unsupported`。同一账号通过
本机 Magpie 的无工具 Responses 请求约 2 秒正常返回，排除了模型不可用这一解释。

TRAE 适配器现允许包含 function/custom 的 namespace，复用上游插件已有的命名空间
转换；仍拒绝未支持的服务器工具。基础 Worker 授权环境设置 `CODEX_WEB_SEARCH_MODE=disabled`，
stdio 和 PTY Codex 都应用 `web_search="disabled"`。普通网关配置保持原有默认行为。

回归覆盖真实锁定适配器的命名空间调用/返回、内置工具拒绝、Worker 环境标记、stdio/PTY
新建和恢复参数。22 个 Core 相关测试和 6 个插件测试通过，类型检查、构建通过。
当前修复插件为 0.2.3，已更新索引并重启真实测试 Service、Worker 和随 Worker 内嵌的 Runner。
使用已有有效凭据重新校验并绑定新发布物，给原失败的 DeepSeek 配置创建版本 2；真实
Worker/Codex 连接测试约 4.1 秒成功，状态 validated。保留原版本的失败记录和其他配置。
诊断与复测证据存于 Git-ignored `docs/local/worker-trae-test/`。

## 0.2.4 缓存对齐与真实命中验证

核对锁定的 Magpie 插件 0.3.7 和官方宿主后，发现 Luna 每次请求重建 auth loader，
导致上游 loader 私有的多轮推理 extra_info 缓存丢失。现按凭据 SHA-256 复用 loader，
最多保留 16 个条目；不同凭据隔离，初始化失败移除条目供下次重试。Responses
cache-control 转换和 cached/cache-write/reasoning 用量继续由上游处理；包装层和 Worker
额外保留 429 类型与有效 Retry-After。

插件 10 个测试通过，覆盖原插件与 Luna 多轮差分、凭据隔离、失败恢复、普通请求字段
及限流语义；Core 21 个相关测试通过，包含完整 Worker 流式用量边界。Core/Dashboard/
插件类型检查和构建通过。0.2.4 发布包摘要、marketplace 和隔离测试安装版本匹配。
已重启当前构建的真实 Service/Worker，并确认 8090、18092、18292 监听。

真实字节账号使用 deepseek-v4.1-flash，经本机 Magpie 与完整 Luna Worker 管理器/
执行作用域 API/私有插件子进程对比。相同第二轮请求，两端均为输入 3693 token、
缓存读取 3584 token、缓存写入 0，命中率 97.05%。分母 input_tokens 已包含缓存。
Magpie 先执行并预热了共享上游缓存，Luna 第一轮已有缓存，不能据此比较冷启动命中率。
隔离测试数据副本和密钥已在结束后删除，原始数值见本机 live-cache-verification.json。

已有 TRAE 测试配置创建新修订绑定 0.2.4；DeepSeek、doubao-seed-evolving、gpt-6.1-sol
真实 Codex 连接测试通过，分别约 3.5、5.7、18.2 秒。gpt-6.2-sol 两次测试仍在
Service→Worker 逆向 RPC 固定 45 秒上限返回 worker_request_timeout，最新修订保留 draft；
连接测试子进程自身为 60 秒上限，此处存在不同层截止时间不一致。未确认这次请求的
上游排队时长或模型最终输出，不能把它算作连接成功，也不能据此判断模型不可用。
当前激活配置仍为原 fixture。缓存面板/任务用量统计尚未接入，完整核对范围见
[Magpie 对齐报告](../reviews/2026-11-26-trae-provider-magpie-parity.md)。
最终只读确认临时测试授权记录为 0，测试容器清理完成。
