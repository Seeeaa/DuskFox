# DuskFox 架构

QQ 进程保留官方客户端的启动、登录和会话生命周期。DF 观察官方账号初始化，账号确认且消息服务可用后接入收发。桥接恢复复用现有会话；后台不自动取码。控制台的手动登录入口继续有效。

## QQ 侧

- runtime/bridge/entry.cjs 引导官方客户端、捕获会话、装配 HTTP 服务。
- native-kernel.cjs 保留构造函数和领域装配，作为现有调用方的统一门面。
- kernel/session.cjs 管账号授权、会话有效性、消息监听绑定和在线状态。
- kernel/login.cjs 管登录回调、手动登录和登录时间。
- kernel/messages.cjs 管消息接收、去重、查询、发送编排与撤回。
- kernel/elements.cjs 是原生元素与 OneBot 消息段的转换入口，实时消息、查询和转发节点共用。
- kernel/media.cjs 管媒体下载和转发展开，media-upload.cjs 管 RichMedia 上传，media-files.cjs 管素材落地和转码。
- kernel/groups.cjs、contacts.cjs、requests.cjs 各自维护群、联系人和请求能力。
- kernel/meta.cjs 管消息元数据持久化和账号记录，diagnostics.cjs 管原生结构摘要。
- server.mjs 负责 HTTP 装配、鉴权、一次 JSON 解码和路由表分发。routes/session.mjs、routes/account.mjs、routes/simulator.mjs 各自注册 method/path 与处理函数，没有第二份路径清单；模拟路由只在模拟内核注册。
- event-stream.mjs 维护事件顺序、游标和有界缓冲，login-pump.mjs 隔离二维码调度，capabilities.mjs 生成三向能力和完整契约 v3 报告。Fox 直接消费 capabilities，运行时保留旧 features 字段供旧客户端读取。

各领域分别实例化，通过显式 ctx 接收 state、options 和 kernel 门面。跨领域调用走门面方法，共享可变字段只写 ctx.state。native-kernel.cjs 不再向原型复制领域方法；kernel/state.cjs 统一分配数据，门面只提供委托方法和 HTTP 所需的只读属性。领域模块不创建独立 QQ 会话。

## Fox 侧

- src/driver/bridge.ts 负责装配、启动和轮询计时。
- src/driver/runtime-state.ts 保存账号状态、能力、登录展示状态、实例和事件游标，供登录、事件与动作组件共用。
- src/driver/bridge/transport.ts 只负责 HTTP 请求和原生错误传递。
- src/driver/login/coordinator.ts 负责显式登录指令与二维码展示，不因状态查询启动认证。
- src/driver/bridge/events.ts 负责事件消费和消息元信息。
- src/driver/bridge/operations.ts 负责动作转发与列表结果包装。
- src/onebot 保留动作注册、ID 映射、事件补全和 HTTP/WS/SSE 传输。

消息段统一使用 { type, data }。桥接驱动原样保留消息段数组，协议层只在引用 ID 映射或 CQ 字符串输出时处理内容。未知段和扩展字段保留在数组输出中。驱动不再依赖 OneBot 的段转换模块。

## 后续功能扩展

新增媒体类型先在 elements 和媒体领域落地，通过 send / recv / download 分别声明能力。Fox 无需增加一份入站字段映射。

新增群管理、文件和其它动作，原生调用放对应领域，HTTP 入口放路由，OneBot 参数和返回约定放动作模块。既有动作注册与能力声明继续复用。

QQ 版本变化先修改入口或相关 kernel 领域，保持 HTTP 契约和段格式稳定。需要 OIDB 的能力按命令增量增加 packet 模块，不预先引入整套协议层。

向 NC 功能范围扩展时按领域增加实现，不按每个 API 复制一套宿主、状态和转换代码。结构调整与具体功能实现分别推进；本次不新增 NC 功能清单。

## 本次迁移范围

生产代码、部署文件清单和已有消息段样本已同步迁移。本次只编写代码，未运行构建、测试、QQ 实测或部署。

## 能力契约与代码格式

契约 v3 的能力唯一来源是运行时 capabilities.mjs，RuntimeState 不再推导 send / recv / download 或兼容能力位。src/driver/bridge/legacy-capabilities.ts 只解释 v1/v2 数据，部署全部切到 v3 后删除。types.ts 的能力构造工具只供模拟驱动和旧契约适配使用。

共享状态集中不等于各领域数据完全独占。当前用显式 ctx/state 表达关联，增加原生状态字段时统一落到 kernel/state.cjs，跨领域行为通过 kernel 门面调用。

.editorconfig 统一 UTF-8、LF 和两空格。npm run format 使用现有 TypeScript 格式化器直接写入，npm run format:check 供后续独立检查使用。
