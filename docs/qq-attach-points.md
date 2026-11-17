# QQ 进程内接入点：与 NapCat 的共同点、差异与未知项

范围
- NapCat 证据相对 `napcat-fork/NapCatQQ-fork/`；duskfox 证据相对本仓库。
- 只描述源码可观察的事实；不据此推断“是否会被检测/风控”。未知项单列，并写明需要什么证据才能确认。

## 1. 接入点表（NapCat）

| # | 接入点 | 做法 | 证据 | 使能 | 失败模式 | 状态 |
|---|---|---|---|---|---|---|
| 1 | Windows 宿主注入 | NapCatWinBootMain.exe + Hook DLL 把 `resources/app/package.json` 换成品 `qqnt.json`（main→loadNapCat.js） | napcat-shell-loader/launcher.bat、qqnt.json、loadNapCat.js | Electron 主进程跑 NapCat JS，同进程 dlopen 内核 | 注入/清单替换被拒则按官方形态启动，不生效 | 脚本已确认；DLL 内部未知 |
| 2 | 纯 Node 无头宿主 | node.exe + wrapper.node 等 14 个文件 + index.js | napcat-develop/index.js、napcat-core/index.ts | 无 GUI 驱动内核（Windows.Node 包） | 依赖 DLL 缺失时 dlopen 报错 | 已确认 |
| 3 | wrapper.node 加载 | `process.dlopen`，路径 versions/<ver>/wrapper.node 等回退 | napcat-core/index.ts:64-111 | 60+ NodeIKernel*Service | 路径/依赖错直接抛 | 已确认 |
| 4 | 登录服务初始化 | `NodeIKernelLoginService.get()` → `initConfig({appid,clientVer,commonPath,platVer,hostName,machineId...})` | napcat-shell/base.ts:92-108,688 | 扫码/快速/密码登录 | appid/qua 缺失时 throw | 已确认 |
| 5 | 二维码回调 | 自建 Listener：onQRCodeGetPicture / SessionUserScaned / SessionFailed(1,3) 自动续期 / onLoginConnected | base.ts:124-221,612-623 | 扫码登录、扫描态、过期自愈 | 注册顺序 addKernelLoginListener→connect；同步事件可能丢（推测）；waitForNetworkConnection 无超时 | 代码确认；时序推测 |
| 6 | session 与 listener | StartupSessionWrapper.create + getNTWrapperSession('nt_1') → session.init(cfg, adapters, listener) → startNT | base.ts:552-586,687-702；napcat-core/wrapper.ts:212-221 | 会话上线、消息/资料/上下线事件 | onOpentelemetryInit 不回调则 Promise 永挂 | 已确认（并更正旧分析：无 addKernelSessionListener 调用，实为 session.init 第 4 参） |
| 7 | 数据库口令 | 登录前挂 `onCmd('OidbSvcTrpcTcp.0xcde_2')` 取 recv，解壳取 inner.value | base.ts:651-668；napcat-core/index.ts:143 | DatabaseApi 直读 nt_msg.db | 包早于监听到达 → 口令空，静默不可用 | 机制确认；时序推测 |
| 8 | 数据包 hook | MoeHoo.<platform>.<arch>.node + initHook(send,recv,cb,o3HookMode)，四级索引 exact>cmd>type>all | napcat-core/packet/handler/client.ts:28-58,171-234 | 观察全部收发、发任意 SSO、38 个 transformer | MoeHoo 缺失/平台不在表 → 协议层降级，OneBot 主干仍可用 | 调用确认；hook 实现未知 |
| 9 | 版本偏移表 | external/packet.json: `<version>-<build>-<arch>` → {send,recv} | packet.json（1010 行）、client.ts:202-214 | 定位 hook 点 | 未适配版本 → 协议层整体失效 | 表确认；生成方式未知 |
| 10 | bypass 开关 | wrapper 加载后 `enableAllBypasses({hook,window,module,process,container,js})`，默认全 true | base.ts:674-679；napi2nativeLoader.ts:7-20 | 推测：关闭客户端侧若干检查 | 导出缺失时静默跳过 | 调用确认；作用对象推测 |
| 11 | 进程管理 | master+worker；10s 内 3 次异常退出 → exit(1)；restart-prepare→5s→shutdown→2s→kill→taskkill /F | napcat-shell/napcat.ts:37-41,154-212 | WebUI 重启、崩溃拉起 | worker 不退最长约 8s 才强杀 | 已确认 |
| 12 | WebUI 令牌/端口透传 | worker → master 传 {type:'restart', secretKey, port}，master 以 env 拉起新 worker | napcat.ts:242-250,395-415 | 重启后浏览器不用重登 | 首选端口被占则漂移 | 已确认 |
| 13 | 版本/AppID/QUA | 内置 appid.json；未命中扫 major.node（"QQAppId/" 或旧字节序列）；QUA 由版本/build 拼 | napcat-common/src/helper.ts:187-247 | 填 initConfig/engine | 结构变更 → 回落硬编码，日志“版本兼容性不佳” | 已确认 |
| 14 | 引擎初始化 | `engine.initWithDeskTopConfig({app_type:4, qua, global_path_config...})` | base.ts:67-90 | 以桌面端形态初始化内核 | 与客户端不一致时行为未知 | 已确认 |
| 15 | 命名管道日志 | Windows \\.\pipe\NapCat_<pid>，stdout 重定向，64KB 高水位 | napcat-shell/pipe.ts:12-60 | 官方 launcher/PTY 拿日志 | 管道不存在 → 5s 超时，被 catch 成日志 | 已确认 |
| 16 | 时间同步 | `hookGlobalDateNow` 用 MSFService.getServerTime 改写全局 Date.now，每小时重同步 | napcat-core/index.ts:199-220 | 进程内时间戳与服务器一致 | 失败仅记日志 | 已确认 |

补充：NapCat 还会在登录期调用 `NodeIO3MiscService.reportAmgomWeather/setAmgomDataPiece`（base.ts:681-743），
目的未见文档，只能观察到调用点（推测：复刻官方登录期上报）。

## 2. 与 duskfox 的共同点与差异

duskfox 的接入方式：**不碰 QQ 进程**。QQ 客户端由用户启动并登录，运行时（另一个进程）在自己的进程里
使用官方登录服务得到会话，通过 HTTP 契约把事件与动作交给框架；框架只做 OneBot 协议与运维。

| 维度 | NapCat | duskfox | 结论 |
|---|---|---|---|
| 谁起 QQ 进程 | NapCat（换入口/纯 Node） | 用户/系统 | 完全不同 |
| 谁装载 wrapper.node | NapCat 自己 dlopen | 官方客户端自己 | 完全不同 |
| 谁发起登录 | NapCat 调 loginService | 官方客户端 UI | 完全不同 |
| 会话建立 | 自造 WrapperSessionInitConfig → session.init/startNT | 用 QQ 已建会话 | 完全不同 |
| 事件来源 | addKernelMsgListener/ProfileListener 等 | 运行时观察到的回调/包 → HTTP 事件流 | 入口不同、语义同源 |
| 发包 | wrapper API 或 SSO 直发 | 运行时自己的通道 | 实现不同，线上格式同为 SSO+protobuf |
| 数据库 | 抓 0xcde_2 口令读 nt_msg.db | 不需要（消息来自会话） | 完全不同 |
| 版本/AppID/QUA | 必须自拼 | 官方客户端持有 | 完全不同 |
| 反检测相关 | 6 项 bypass 开关 | 无对应实现 | 不共享；运行时侧是否有等价处理未知 |
| 无头 | 纯 Node 包 | 依赖 QQ 有可显示的窗口（被动模式） | NapCat 更强 |

**共同点只有最底层**：都使用官方内核与官方认证结果、都用 SSO 命令 + protobuf 线上格式、都把
“官方客户端能力”翻译成 OneBot 语义。**差异在于创建期 vs 运行期**：NapCat 拿走创建期接入点
（入口、dlopen、loginService、session 初始化、appid/QUA），duskfox 只存在于运行期（观测与转发）。

推论（工程层面，不是风控结论）：duskfox 不需要维护版本偏移表、appid 表、bypass、QUA，
因此对 QQ 版本变更的敏感面更小；但它拿不到“主动登录/无头”这些创建期能力，扫码能力受制于客户端窗口。

## 3. 未知项

| # | 未知项 | 现在只能看到 | 需要的证据 |
|---|---|---|---|
| 1 | NapCatWinBootHook.dll 如何替换清单 | 21KB 成品二进制；qqnt.json 的 verHash 用途未言明 | DLL 反编译/导出表 + ProcMon 启动文件序列 |
| 2 | verHash 是否参与完整性校验 | 字段存在 | 篡改后启动行为对比 |
| 3 | MoeHoo/napi2native 的 hook 实现 | 只有 initHook 签名与返回语义 | 反编译，或上游源码 |
| 4 | packet.json 偏移的生成方式 | 手写表，无生成脚本 | CI/维护脚本，或同版本二进制比对 |
| 5 | bypass 六项实际绕过什么 | 只有 option 名与默认值 | 反编译逐项定位 |
| 6 | o3HookMode 语义 | 配置项 → initHook 第 4 参 | 同版本 0/1 两次运行包差异 |
| 7 | 二维码回调注册时序是否安全 | 顺序 add→connect | 带时间戳的 instrumented 运行日志 |
| 8 | 0xcde_2 抓包窗口 | init 后、handleLogin 前挂监听 | 完整登录包序列 |
| 9 | duskfox 运行时的内部实现 | 本仓库只有 HTTP 契约 | 运行时源码（不在本仓库） |

以上任何一条都不足以支持“是否被检测”的结论；本轮不做此类判断。
