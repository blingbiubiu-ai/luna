# Luna 架构与逻辑审查报告及优化计划

- 日期：2026-11-15
- 基线：`f04065c Initial Luna workspace`，外加工作区原有的未提交改动 `src/tasks/task-report-service.ts`
- 范围：本轮**只深入审查了 Task 生命周期链路**，即创建 → Run 执行 → 报告 → 取消/重启 → 启动恢复 → 状态卡 → Main 结果投递。Session 入站与队列、插件加载、Dashboard、Feishu 适配层只在 Task 链路涉及的地方看过，**没有做系统审查**，见第 5 节。

---

## 1. 现状梳理（Task 链路）

| 环节 | 负责模块 | 持久化 |
|---|---|---|
| 命令入口（create/update/restart/cancel） | `src/tasks/task-command-service.ts` | `runner_operations`（操作账本） |
| Run 生命周期 | `src/tasks/task-run-supervisor.ts` | `task_runs`、`tasks.status`、task timeline |
| Run 执行与 prompt 物化 | `src/kernel/task-run-handler.ts` | `task_runs.materialized_prompt`、context packs |
| 执行权限 | `src/runners/invocation-service.ts`、`invocation-store.ts` | `runner_invocations`、`runner_jobs`、`access_tokens` |
| 远端执行 / 取消 | `src/runners/runtime-agent-transport.ts` | `runner_jobs` 游标与状态 |
| 撤销与结算的后台收敛 | `src/runners/job-reconciler.ts`（通过 `invocation-recovery-pump.ts` 周期 tick） | 同上 |
| 最终报告 | `src/tasks/task-report-service.ts` | `task_report_commands`、报告 artifact、task-result outbox |
| 状态卡 | `src/tasks/task-run-notification-service.ts`、`task-run-notification-recovery.ts` | `task_run_notifications`、`notification_attempts` |
| 启动恢复顺序 | `src/kernel/kernel.ts:339-345` | Run 恢复 → operation 恢复 → 状态卡恢复 → task-result 恢复 |

审查中逐项核对过、**没有问题**的部分：

- `_markTerminal`（`task-run-store.ts:243`）只允许从 `running` 迁移到终态，旧 Run 无法覆盖新 Run 的结果。
- 状态卡串行 lane 按 DB 共享（`task-run-notification-service.ts:76` 的模块级 WeakMap）。kernel 里有 4 处新建 service 实例，但它们共用同一条 lane，和文档描述一致。
- 终态卡片更新是幂等的：已经是 terminal 的 notification 会被跳过。
- 启动恢复时，报告已被接受的 Run 会根据持久化的回执补完成，不会重复执行。

---

## 2. 已修复的问题

### 2.1 【确认的 bug】restart 不吊销被取代 Run 的执行权限

- **位置**：`task-run-supervisor.ts` 修改前的 `restartTaskRun`（约第 173-191 行）
- **证据**：`cancelTaskRun` 在事务里调用 `InvocationService.revoke()`，会吊销 invocation 和相关 token；`restartTaskRun` 只调用 `markCancelled` 再 `abort()`。运行中 Job 的吊销只发生在 transport 的 abort 监听器里（`runtime-agent-transport.ts:115-120`），而这个监听器要等 Job 创建之后才挂上。
- **触发条件**：旧 Run 还在准备阶段（`prepareRunnerFiles`、`client.verify`、上传 runner 文件）时收到 `task update/restart`。这时 invocation 已经注册、token 已经签发，但 abort 监听器还没挂上。
- **后果**：旧 invocation 一直是 `active`，token 一直有效，直到下一次服务启动才由 `JobReconciler` 清理。由于 `requireActive` 还会检查"最新 Run"，这个 token 实际上被 `run_inactive` 拦住，安全风险有限；但 invocation 账本会残留未结算记录，`finally` 中"只结算 revoked invocation"的清理逻辑也不会执行。
- **修复**：新增 `_cancelRun()`，restart 和显式 cancel 共用：Run 状态、Task 状态（可选）、吊销 invocation 和 token、写 timeline 在同一个事务里提交，然后才 abort 本地进程。两套取消实现合并成一套。
- **行为变化**：restart 后旧 Run 的 token 立即失效（以前要靠"最新 Run"检查间接拦截）。对外接口不变。
- **回归测试**：`tests/runtime/task-run-supervisor.test.ts` 中的 "restart revokes the superseded run's authority even before its transport attached an abort listener"。对修改前的代码运行会失败，修复后通过。

### 2.2 【确认的 bug】被 JobReconciler 取消的 Run，状态卡一直停在"运行中"

- **位置**：`job-reconciler.ts:64-73`（`completeCancelledBusiness`），以及 `task-run-supervisor.ts` 修改前 `_executeRun` 中两处 `if (signal.aborted || !this._isActiveRun(run)) return;`
- **证据**：`InvocationRecoveryPump` 会周期调用 `JobReconciler.recover()`；对于 `requireScope` 校验失败的 invocation（执行者被停用、session 被归档、Agent/Shadow 作用域变化），会直接写 `task_runs.status = cancelled`，**不触发任何状态卡通知**。supervisor 随后发现 Run 不再 active，静默返回。
- **后果**：Feishu 和 Dashboard 上的状态卡一直显示运行中，要等下次服务重启，`TaskRunNotificationRecovery._recoverTerminalUpdates` 才会补发。
- **修复**：新增 `_notifyExternalCancellation()`。当 Run 已经是 `cancelled`、但 supervisor 自己的 signal 没有被 abort 时（说明是外部取消；restart、cancel、shutdown 都会 abort signal），补发一次 `onRunCancelled`。终态卡片更新幂等，且按 run 串行，不会和 restart 路径的通知竞争。不会产生 Task-result Main 调用。
- **回归测试**：同一文件中的 "a run cancelled by another authority without aborting the process closes its status card"。对修改前的代码运行会失败，修复后通过。

### 2.3 【简化，保留工作区原有改动】报告提交只保留一处鉴权

- **位置**：`src/tasks/task-report-service.ts` 的 `active()`
- **内容**：删除了内联重复的 token 有效性、最新 Run、执行者状态检查，统一改用 `InvocationService.requireActive`。
- **核对结论**：`requireActive` 和 `requireScope` 覆盖了原有的全部检查（token 未吊销且未过期、userId 匹配、最新 Run 正在运行且 runner context 匹配、执行者为 active），另外还要求 Job 处于 pending/active，比原来更严格。正常上报时 Job 一定是活跃的，所以没有行为回退。
- **对外差异**：错误码 `token_inactive`、`run_inactive`、`actor_inactive` 保持不变，只是 token 失效时的 message 从 "Task token is inactive" 变为 "Runner token is inactive"。新增一种拒绝：invocation 的 Job 已经终止时返回 `invocation_inactive` 409。

### 2.4 文档

`docs/designs/tasks-task-runner.md` 的 "Explicit task cancellation" 一节补充了统一取消规则和 JobReconciler 外部取消关闭状态卡的说明。

---

## 3. 简化机会

### 3.1 【已实施】S1：Task Run 取消只保留一个终态迁移入口

- **原问题**：`job-reconciler.ts` 的 `completeCancelledBusiness` 直接 `UPDATE task_runs`，绕过 `TaskRunStore._markTerminal` 的"只能从 running 迁移"保护，也不写 `runner.cancelled` timeline，所以 Dashboard 时间线看不到这次取消。
- **改动**：改为调用 `TaskRunStore.markCancelled` 并追加和 supervisor 相同格式的 `runner.cancelled` 事件。只依赖 store 层（`TaskRunStore` 和 `TimelineStore` 都只依赖 data 层），没有引入 `runners → tasks supervisor` 的反向依赖。Task 状态仍然只在该 Run 是最新 Run 时才更新。
- **行为变化**：这条路径取消的 Run 现在会出现在 task 时间线上。另外 `markCancelled` 会把 `final_report_artifact_id` 置空，这条路径以前会保留它（只在报告已接受后又被外部取消时才有区别），现在和 supervisor 的取消规则一致。这个边界语义仍归 H1 决定。
- **回归测试**：`tests/runtime/invocation-authority.test.ts` 中的 "reconciler cancels a revoked Task invocation through the guarded run transition and records it on the timeline"。对修改前的代码运行会失败，修复后通过。

### 3.2 【已实施】S3：合并重复的建 Run / 启动代码

- `startInitialRun` 和 `restartTaskRun` 共用 `_launchRun()`：建 Run、注册 controller、把 Task 标记为 running、通知、开始执行。restart 通过 `beforeCreatedNotification` 钩子保持原来的顺序（先发旧 Run 的取消通知，再发新 Run 的创建通知）。
- `_existingRestartRun` 和 `_existingRunForSource` 两层纯转发合并成一个函数。
- 纯重构，无行为变化；现有 supervisor 套件全部通过。

### 3.3 【评估后保留】S2：Task 状态的两个事实来源

| 证据 | 保留原因 |
|---|---|
| `tasks.status`（各写入方同步写）和 `taskWithLatestRunStatus`（`task-status-projection.ts`），dashboard 也有 `latestRunStatus ?? row.status`（`dashboard-api/tasks.ts:426-433`） | 逐个核对了写入方（supervisor 的 start/restart/cancel/fail/complete、启动恢复、reconciler），目前都会保持两者一致，没有发现会产生分歧的路径。删除投影的话，旧版本写入的历史行（如果存在不一致）会直接显示错误状态；删除同步写入则要改 dashboard 列表查询和删除流程。两种改法都没有证据表明能带来收益，按\"证据不足就保留现状\"的原则不改。如果以后要改，建议先补一个覆盖全部写入方的\"两者一致\"不变量测试 |

---

## 4. 需要进一步确认的假设

| # | 假设 | 现象 | 需要的信息 |
|---|---|---|---|
| H1 | 报告已接受、之后又被取消的 Run，语义可能不一致 | `markCancelled` 会清空 `final_report_artifact_id`（`task-run-store.ts:191-199`），但 `TaskReportService.submit` 已在提交时写入 task-result outbox，Main 可能已收到 `completed` 结果，而 Run 最终是 `cancelled` | **需要你决定**：报告被接受后，cancel/restart 是否应该改为"完成"？还是保持取消，但撤回尚未投递的 outbox 项？ |
| H2 | 每条入站消息路由约 160 ms，偏慢 | 诊断 group-activation 测试时测到：两条连续消息的 `received_at` 相差约 160 ms，其中包括 artifact 化、写消息、follow-up 判定和若干 DB 操作 | 需要在正常负载的机器上测一次，判断是这台机器的 IO 问题还是路由本身慢 |

---

## 5. 测试现状（与本轮改动无关的失败）

全量测试：**1455 通过 / 22 跳过 / 8 失败**。8 个失败都和本轮改动无关：

| 测试 | 结论 |
|---|---|
| `luna-group-chat-activation` › accepted activation follow-ups coalesce like ordinary queued messages | HEAD 上同样失败。合并窗口 20 ms，但这台机器上每条消息路由约 160 ms；把窗口放宽到 600 ms 后通过，属于**时序敏感的测试** |
| `luna-group-chat-activation` › batched quiet activation follow-ups can complete without a batch card | HEAD 上同样失败。窗口放宽后**仍然失败，原因未查明** |
| `luna-context-pack-flow` 的 4 个测试 | 单独运行通过，只在全量运行时失败，疑似测试之间互相干扰或依赖执行顺序 |
| `work-session-e2e` › coalesced work-session messages clear every processing reaction | HEAD 上单独运行同样失败，原因未查 |
| `runtime` › built runtime initializes a fresh luna database with migrations | HEAD 上单独运行同样失败，原因未查 |

---

## 6. 验证记录

- 新增回归测试：2 个，对修改前代码运行失败，修复后通过；supervisor 套件 45/45。
- `bun run typecheck`：通过（root 和 dashboard）。
- `bun run build`：通过。
- 真实服务（2026-11-15 07:51-07:54）：
  1. 停掉 `luna.service`，备份 `/var/lib/luna/data`（含 WAL）到 `/var/lib/luna/backup-pre-verify-20261115/`；
  2. 确认工作区和 `/opt/luna` 的 schema、迁移完全一致，源码只差本轮改动的两个文件；
  3. `luna` 用户无权进入 `/home/jordan`，所以把 `/opt/luna` 复制一份，用工作区的 `dist` 和 dashboard 产物覆盖（`cmp` 确认一致），然后用 `systemd-run` 以 `luna` 用户、相同的 `.env` 和 HOME 启动；
  4. `sudo lsof -nP -iTCP:8090 -sTCP:LISTEN` 显示新进程 PID 610156 在监听；
  5. API：`/api/health` 200；dashboard token 登录 200，`/api/auth/session` 已认证；`/api/tasks?agentId=…` 200；`POST /api/runner/task-reports` 未认证返回 401，用非 Task Runner 身份返回 `task_runner_required` 403；`GET /api/runner/task-reports/:id` 同样返回 403。这些都走到了改动后的鉴权入口；
  6. 启动日志没有 error，Run、状态卡、task-result 恢复都正常完成；
  7. 恢复原服务：`luna.service` 重新运行 `/opt/luna`（PID 610391），health 200，临时目录已删除。
- 第二轮（S1/S3 实施后，10:28-10:30）：重新备份 `/var/lib/luna/data` 到 `/var/lib/luna/backup-pre-verify-20261115b/`，按同样方式启动新构建（PID 623226，`sudo lsof` 确认监听 8090）。health 200、登录 200、`/api/tasks` 200、报告接口 401/403 符合预期，启动日志无 error（包括 JobReconciler 所在的恢复泵）。随后恢复 `luna.service`（`/opt/luna`），health 200。全量测试 1458 通过 / 22 跳过 / 6 失败（均为第 5 节中已有的 group-activation 和 context-pack 失败；work-session 和 runtime migration 这次通过，说明它们也不稳定）。typecheck、build 通过。
- **没能验证的部分**：正式库里当前**没有任何 Task**，真实服务上无法触发 restart/cancel/外部取消。这两个修复的行为只由回归测试覆盖，没有在真实 Run 上观察过。要做端到端验证，需要一个能发出 `luna task create` 的 Main 会话（LLM 和 Feishu 渠道）。
- Dashboard 本轮没有改动，所以没有做浏览器检查。注意 `/tasks` 和 `/dashboard/tasks` 直接访问会返回 404，入口路由要以 `/` 为准。
- **注意**：本轮修复还**没有部署**到 `/opt/luna`，线上运行的仍是旧代码。

---

## 7. 优化计划

按影响、证据和改动成本排序：

| 批次 | 内容 | 前置条件 | 验证方式 |
|---|---|---|---|
| P0 | 部署本轮修复（2.1-2.3）到 `/opt/luna` 并重启 `luna.service` | 你确认部署 | 发起一个真实 Task 后执行 `task update`，确认旧 Run 的 token 被吊销，状态卡显示"已中断" |
| P0 | 决定 H1 的语义 | 你决策 | 按决策补一个测试：报告被接受后再 cancel/restart |
| ~~P1~~ | S1：已完成，见 3.1 | — | `invocation-authority.test.ts` 新增用例 |
| P1 | 修复测试稳定性：查清 quiet-batch、work-session、runtime migration 三个确定失败的原因；context-pack 测试做隔离 | 无 | 全量测试连续 3 次 0 失败 |
| P2 | 系统审查**尚未覆盖**的链路：Session 入站与队列与 #steer、插件动态加载与注册、Feishu 交付与 native progress、Dashboard 权限 | 无 | 每条链路一份发现清单，按本报告格式 |
| P2 | S2：评估后保留现状，见 3.3；如需改动先补不变量测试 | 有证据显示两者会分歧时再做 | 不变量测试，dashboard 回归 |
| ~~P3~~ | S3：已完成，见 3.2 | — | 现有 supervisor 套件 |
| P3 | H2：测量入站路由耗时 | 正常负载的机器 | 分段计时日志 |
