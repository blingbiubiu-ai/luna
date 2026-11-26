# TRAE Provider 与 Magpie 插件宿主对齐核对

核对对象为 Luna `trae-provider@0.2.4`、锁定的 `@byted-qzb/magpie-plugins@0.3.7`，
以及 Magpie 官方插件宿主源代码。Luna 直接调用 `TraeCodeCnPlugin`，没有重写 TRAE
raw-chat 协议；但独立宿主必须正确复用 loader、传递上下文和保留输出语义。

## 已修复并验证

| 项目 | 问题及当前结果 | 验证 |
| --- | --- | --- |
| SSO 回调 | 路径由插件声明 `/authorize`，核心动态注册和校验登录流路径 | 真实 SSO 与目录成功；自定义路径/默认路径/拒绝错路径回归 |
| Codex 工具 | 原包装层误拒 namespace；现保留 function/custom 与 namespace 的调用名称和结果 | 锁定真实适配器工具转换测试；DeepSeek 真实 Codex 连接成功 |
| loader 生命周期 | 原先每次请求重建 loader，丢掉 loader 内的 extra_info 推理缓存；现按凭据摘要复用，并隔离不同凭据 | 修复前差分失败；修复后多轮工具 extra_info 与原插件一致 |
| 缓存字段 | 原插件的 cache-control 和 Responses usage 均保留，未另行估算 token | 差分核对 cached/cache-write/reasoning 数值；完整 Worker 流式接口回归 |
| 限流 | 429 的类型和 Retry-After 原先被丢掉；现保留类型及受限重试头 | 原插件与包装层差分；Worker 不丢 Retry-After，过滤其他头 |
| 普通请求字段 | system/developer、JSON schema、reasoning effort、max output tokens、parallel tools、custom/namespace 工具按原插件转换 | 四组原插件与 Luna raw-chat 请求逐项相等 |

## 真实缓存测试

测试使用真实字节账号、`deepseek-v4.1-flash`、固定合成参考内容和连续两轮请求。
Magpie 使用本机已运行的网关；Luna 使用隔离 Worker 数据副本、真实 Worker 管理器/
执行作用域 API/私有插件子进程，以及校验过的 0.2.4 发布物。副本只用于测试，结束后
删除。请求实际发往 TRAE，没有模拟缓存数字。

| 第二轮 | 输入 token（含缓存） | 缓存读取 token | 写入 token | 命中率 |
| --- | ---: | ---: | ---: | ---: |
| Magpie | 3693 | 3584 | 0 | 97.05% |
| Luna | 3693 | 3584 | 0 | 97.05% |

定义为 `cached_tokens / input_tokens`。OpenAI Responses 的 input_tokens 已含缓存，
不能再次加 cached_tokens；Magpie 内部把 input/cache-read/cache-write 分开存放，
其缓存读取 / 总 prompt 的口径与上式相同。

执行顺序是 Magpie 先预热、Luna 后请求，因此 Luna 第一轮已读到缓存。本结果证明
相同第二轮计数和实际缓存命中，不证明所有模型/请求都达到同一比例，也不把本地
extra_info 缓存的命中当成服务端 token 缓存命中。

真实数值、时间和复测脚本在 Git-ignored `docs/local/worker-trae-test/`。

## 发布与模型连接复验

0.2.4 已打包并安装到本地隔离测试 Home，发布包、marketplace 与当前安装摘要一致。
Service/Worker 使用当前构建重启；8090、18092、18292 已确认监听。
插件 10 个测试、Core 21 个相关测试、Core/Dashboard/插件类型检查和构建均通过。

升级绑定到新发布物的配置中，DeepSeek、doubao-seed-evolving、gpt-6.1-sol 真实 Codex
连接测试分别约 3.5、5.7、18.2 秒成功。gpt-6.2-sol 两次在约 45 秒返回
`worker_request_timeout`；其新修订仍为 draft。逆向 RPC 固定 45 秒上限早于 Worker
测试子进程的 60 秒截止时间；本次未取得上游排队时长或最终返回，不能将其记为成功。
该超时独立于上表已验证的缓存结果。当前激活配置仍保留原 fixture。
测试结束后只读确认临时授权记录为 0，连接测试容器已退出并清理；历史 Job 绑定记录保留。

## 仍未接入的宿主能力

| 项目 | 当前边界 |
| --- | --- |
| Luna 任务级用量/缓存面板 | Responses usage 完整返回，但 Codex turn.completed 的 usage 尚未纳入 Luna 任务统计；不能声称 UI 缓存统计已完成 |
| 完整模型元数据 | 当前目录仅映射 contextWindow、tools、reasoning；输出窗口、推理档位、图片能力等未完整开放，也没有把目录上下文自动写入 Codex 参数 |
| 插件用量 hook | 原 TRAE CN auth.usage 是登录状态和到期检查，未直接挂到 Luna；它本身不提供订阅额度 |
| 网络配置 | Magpie 的按账号代理、系统 CA 注入等宿主能力未完整迁移；当前私有子进程使用最小环境 |
| 排队与负载选项 | 原插件默认保活、排队提示和断流处理保留；宿主队列选项、负载报告、路由组/fallback 控制未接入 |
| 诊断信息 | 固定 API 错误分类保留；插件 stderr/logid 不落到 Luna 日志，连接测试仍把未分类失败收敛成固定提示 |

上述项目与已同意的基础版范围应区分：多账号、路由组、其他客户端协议、服务器
web search、response 存储/previous_response_id、用量/账单面板原先不在基础版范围内。
它们不能凭“复用了插件”宣称已经具备。基础版 Codex 关闭 OpenAI 内置 web_search，
没有仿造 Magpie 的搜索服务；客户端函数工具保留。

## 上游依据

- [Magpie loader 按账号复用](https://github.com/yetone/magpie/blob/main/internal/plugin/host.js)：`options` 中的 loaders 缓存。
- [Magpie 缓存统计定义](https://github.com/yetone/magpie/blob/main/internal/usage/usage.go)：Input 不含 CacheRead/CacheWrite，未知缓存不按零命中计入。
- 锁定发布包 `@byted-qzb/magpie-plugins@0.3.7` 的 `It`/`uo` 推理缓存、`go.finish`/`sd` 用量转换、`TraeCodeCnPlugin` 及其 README。
