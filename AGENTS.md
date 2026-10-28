# AGENTS.md — dsh-session-title-summary

DSH 插件 session-title-summary（纯 host）：每轮对话结束后把新事件折叠进滚动
"大问题 - 小问题"大纲并重命名会话标题。独立仓库，不属于 dsh-web-ui monorepo；
包级规则只写本包特有约定。

## 本包要点

- 纯 host 插件，无 `src/client/`：设置开关经 host 注册 settings section
  （`dsh-session-title-summary` 命名空间），Web 设置界面自动渲染。
- 设置注册用新 API（dsh-settings ≥0.1.2）：`ctx.settings.register(ns, Config, { base })`
  返回 scope，实时值取 `scope.get()`；**不要**再写已移除的
  `installSettingsSection` / `settingsNamespace`。`Session.events` 也已移除，
  事件用 `session.snapshotEvents()` / `ownEvents()` 读取。
- 触发：监听 `agent/turn-stopping`（agent 级事件，宿主插件可靠接收；`session/event`
  是 session-scoped 事件，插件 fiber 收不到）。收尾延迟 600ms 后派生子代理。
- 总结：`spawnFoldSubagent(...)`（host 半区）按运行时探测调用宿主 spawn 入口——
  dsh-subagent ≥0.2.1 用 `subagents.startActivation({provider:'spawn', label,
  signal, delivery:'caller', request})`（label/signal 移到 request 外），≤0.1.x
  回退 `subagents.start('spawn', 扁平request)`；两者皆无则抛错由 catch 降级。
  子代理继承父 agent 模型路由与工作区，主对话不被阻塞（`delivery:'caller'`
  不通知父模型）；结构化输出 + 8192 token 预算防截断。provider/model 配置经
  `agentOptions` 真实改路由（spawn 在创建子代理时合并到父路由之上），不再是
  prompt 提示。
- 结构分区：`src/index.ts` 是 host 半区（事件监听 + 子代理调度 + rename），
  `src/core/` 是纯逻辑（`events.ts` 事件摘要、`summary.ts` 折叠 prompt 与解析、
  `store.ts` 原子文件存储、`home.ts` DSH_HOME 解析）——core 不依赖 cordis，可单测。
- 摘要格式：每行"大问题 - 小问题"（大问题=会话级目标，小问题=其下具体事项），
  同大问题聚组、异大问题空行分隔；当前大问题最多 3-4 条，旧大问题各 1 条。
  摘要存 `$DSH_HOME/dsh-session-title-summary/<sessionId>.json`。
- 摘要语言：默认跟随**用户消息**的语言（system prompt 里 LANGUAGE RULE 强制，
  禁止退回模型默认语言——CJK 后端会漂成中文）；`language` 配置（如 `fr`、
  `English`）显式覆盖，空串等同未设置。
- 依赖注入：`inject = ['sessions', 'sessionTitle', 'subagents']`；peer 声明
  dsh-agent / dsh-llm / dsh-session / dsh-session-title / dsh-settings / dsh-subagent。
- 生命周期纪律：per-session promise 链串行防重；折叠失败只推进游标不重命名，
  不得抛错影响宿主。

## 提交前检查

```sh
pnpm typecheck
pnpm test
pnpm build
```
