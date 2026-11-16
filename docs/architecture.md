# duskfox 架构与取舍

## 1. 分层

| 层 | 目录 | 职责 | 依赖方向 |
|---|---|---|---|
| 组合根 | `src/app.ts`、`src/main.ts` | 装配、生命周期、状态汇总、soft restart | 向下依赖全部 |
| 控制台 | `src/webui/*` | HTTP 路由、会话、SSE、静态资源 | 只依赖 `WebuiContext` 接口 |
| 协议 | `src/onebot/*` | 动作注册、消息段/CQ 转换、事件构造、五种传输 | 依赖 core + driver 接口 |
| 基础 | `src/core/*` | 配置、日志、统计、消息 ID、路径、令牌 | 无业务依赖 |
| 驱动 | `src/driver/*` | 账号状态机与消息收发 | 只依赖 core 的模型与类型 |
| 插件 | `src/plugins/*` | 进程内扩展 | 依赖 service 的公开方法 |

依赖只向下：驱动不认识 OneBot，协议层不认识 HTTP 控制台，界面只认 `Context` 接口。
新增传输、驱动或页面都不需要改动其它层。

## 2. 一次消息的完整路径

```
QQ 运行时
   │ driver.emit({type:'message', message})
   ▼
Application.#events (Emitter)
   │ service.handleMessage(message)
   ▼
OneBotService
   ├─ 过滤：self 消息 / 事件开关
   ├─ stats.incMessagesIn()
   ├─ buildMessageEvent()  ← messageIds.register() 生成数字 id
   ├─ networkManager.publish(event) → 各传输
   └─ 事件环形缓冲 → SSE → 控制台“事件流”
```

反向路径（动作）：

```
Bot --HTTP/WS--> 适配器 --host.dispatch--> OneBotService.dispatch
   ├─ ActionRegistry.invoke：别名 → 能力门禁 → TypeBox 校验 → handler
   ├─ handler → driver.sendMessage() → 原生 message_id
   ├─ messageIds.register(nativeId) → 数字 id
   └─ 响应包 {status, retcode, data, message, wording, echo}
```

## 3. 关键取舍

### 3.1 驱动接口而不是直接内嵌 QQ 代码

QQ 侧代码版本敏感、平台相关、且需要二进制。把“进程内寄生”换成“进程外契约”后：

- 框架本身是纯 Node，Windows / Linux 行为一致，可测试、可容器化；
- QQ 运行时崩溃或重启不影响控制台与配置；
- 未来换实现（原生桥接、自研协议、其它客户端）只替换驱动。

代价是驱动必须把能力翻译成统一模型，因此 `capabilities` 是显式契约，而不是“试试看”。

### 3.2 能力门禁集中在一处

每个动作声明 `requires: ['privateMessage']` 之类的依赖，注册表在调用前统一检查。
不支持的调用返回 `retcode: 1200`，文案说明缺什么能力。这样：

- 驱动可以只实现一部分能力，框架仍然完整（“降级而非崩溃”）；
- 控制台的“能力范围”表由同一份 `capabilities` 推导，界面与后端不会说法不一；
- 新增驱动不用逐个动作写兼容分支。

### 3.3 消息 ID：哈希 + 有界双向表

`message_id` 是 OneBot 客户端唯一持有的消息句柄。做法与 NapCat 相同：`md5(原生id|会话|对象)`
取 31 位正整数，保留最近 5000 条映射，超窗即失效；不落盘。

- 优点：无数据库、无迁移、重启后同一个原生 id 仍得到同一个数字 id（哈希模式）；
- 代价：撤回旧消息会拿到 `1404 消息 ID 不存在或已超出保留窗口`，这是明确可解释的行为。

### 3.4 配置热重载而不是重启进程

配置变更按“绑定参数”和“非绑定参数”区分：

- 端口 / 地址 / URL 变了 → 重建该适配器（只重建这一个）；
- 只改令牌、名称 → 原地更新，Bot 连接不断开。

实现上是 `ConfigStore` 归一化并落盘后发出 `ConfigChange`，`NetworkManager.apply` 做差量对账。
控制台点“保存”会立刻在 `network.json` 看到结果，服务端日志会记录变化数量。

### 3.5 SSE 而不是 WebSocket 做控制台实时流

控制台是单向消费（日志、事件、状态、二维码），SSE 足够且：

- 浏览器原生 `EventSource`，自动重连，无需心跳协议；
- 不占用 `ws` 连接预算，也不与 Bot 传输的鉴权逻辑混淆；
- 断线后 UI 退化为轮询 `/api/status`，功能不受影响。

### 3.6 环形缓冲 + 有界队列

日志内存 1000 条、事件 300 条、消息映射 5000 条、上报队列 500 条、WebSocket 待发 200 条。
所有对外缓冲都有上界，长时间运行不会因为没人消费而涨内存。

### 3.7 诚实降级

没有实现的页面元素一律保留占位并标注“待接入 / 暂不支持”，动作返回明确错误码；
控制台的接口对照表由服务端 `endpoints()` 生成，`wired:false` 的条目前端显示“待接入”。
这样“界面能用”和“功能没做完”不会被混为一谈。

## 4. 扩展点

| 想做的事 | 改哪里 |
|---|---|
| 新增动作 | `src/onebot/actions/*.ts` 加一个 `ActionDefinition`（含 schema 与 `requires`） |
| 新增传输 | `src/onebot/network/` 实现适配器，在 `manager.ts` 注册 kind 与 diff 规则 |
| 新增驱动 | 实现 `AccountDriver`，在 `driver/registry.ts` 登记 |
| 新增控制台接口 | `src/webui/routes/*.ts` + `WebuiContext` 加方法 |
| 新增事件类型 | `core/model.ts` 加结构 → `driver` 发事件 → `onebot/events.ts` 映射 |
| 新增页面 | `src/webui/index.html` 的 `P` 表 + `ORDER` 数组（设计文件在 `webui/design/`） |

## 5. 测试策略

- 纯函数（段转换、ID 映射、配置归一化）：直接单测，无 IO；
- 集成：每个用例在临时目录启动一个完整 `Application`，控制台端口用 0，
  Bot 侧传输也用 0，因此可以并行跑；
- 驱动契约：`mock` 覆盖全链路；`bridge` 用一个假的 HTTP 运行时验证请求/响应的字段与轮询行为；
- UI：`npm run ui` 检查内联脚本语法、页面入口及登录/二维码接口引用；浏览器交互仍需单独验收。

## 6. 已知边界

1. `http-client`（HTTP POST 上报）是单向的：OneBot 规范里上报响应可以携带动作，这里尚未实现。
2. `ws-server` 单端口多客户端，不区分“只收事件/只发动作”的角色（`http-server` 的 WS 挂载支持 `/api` 角色）。
3. 二维码来自驱动，框架只负责展示与计时；原生运行时是否刷新由驱动决定。
4. 插件只能挂钩事件与调用动作，暂不支持注册 HTTP 路由（避免与主路由表生命周期耦合）。
5. 通知通道、自动更新、进程守护（systemd/计划任务）未内置，文档给出外部托管方式。
