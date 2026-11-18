# 原生运行时对接与“摆脱 noVNC”的扫码方案

本文分两部分：
1. 框架侧（本仓库）已经做了什么；
2. 运行时侧（QQ 进程内的桥接）还需要做什么，以及如何在不重启、不退登测试号的前提下验证。

## 1. 框架侧：两种登录语义已经落地

`/api/qr` 现在是一个状态机，字段含义：

| 字段 | 含义 |
|---|---|
| `state` | `none`（已在线）/ `waiting`（有可扫码图）/ `scanned`（已扫码，等手机确认）/ `confirmed`（已确认）/ `expired`（过期或失败）/ `unavailable`（暂时没有码） |
| `image` | PNG/SVG data URL，控制台直接显示 |
| `expiresAt` | 毫秒时间戳；运行时不给时按“首次出现 + 120s”推算 |
| `seq` | 每次出新码自增，便于前端判断变化 |
| `refreshable` | **false 表示不能主动刷新**（被动模式） |
| `loginMode` | `active` / `passive` / `unknown` |
| `hint` | 给操作员看的原因说明，控制台原样显示 |

控制台行为：
- `refreshable=false` → “刷新二维码”按钮置灰，并在二维码下方显示原因（例如“被动模式：请在 QQ 客户端窗口里刷新二维码”）；
- `state=scanned` → 图片隐藏并提示“已扫码，请在手机上确认”；
- 主动模式下点刷新会等待运行时异步返回图片（最多 6 秒），拿到后自动替换。

对应测试：`tests/bridge.test.ts` 里的
“桥接二维码：被动模式提示不可主动刷新，切主动后等待异步图片”和“兼容异步二维码契约”。

## 2. 为什么被动模式以前离不开 noVNC

从运行时源码（旧 `bridge_webui.cjs`）可以看到三个事实：

1. **二维码只能由 QQ 窗口触发**。被动模式下，桥接只挂 `NodeIKernelLoginListener`，
   等 QQ 渲染进程调用登录服务的“取码”接口时，`onQRCodeGetPicture(pngBase64QrcodeData)` 才会回调；
   桥接把这个 base64 存进 `state.qr`。如果窗口没有停在扫码页，就没有码。
2. **监听器注册受 wrapper 观测门控**。`attachLogin()` 只在 `state.nativeProbe.wrapperObserved` 为真后执行，
   而该标志来自 `process.dlopen` 的猴子补丁。如果桥接装载得比 QQ 加载 `wrapper.node` 更晚，
   标志永远不会置位 → 状态停在 `starting`，页面上什么都不会出现（交接记录里的现象）。
3. **主动取码历史上崩过**。`loginService.getQRCodePicture()` 是在 `waiting_login` 3 秒后无条件调用一次，
   当时出现 SIGABRT 且没有日志，无法归因。该调用本身是客户端接口，风险点更可能在
   “调用时机/重复调用”，而不是接口存在。

三者叠加的结果：无头 Linux 上想扫码，只能把 QQ 窗口开出来人看 —— 这就是 noVNC 的由来。

## 3. 方案：让“窗口存在”与“人看见窗口”解耦

**核心判断**：被动模式需要的是“渲染进程存在并请求了二维码”，而不是“有人盯着屏幕”。
因此用 Xvfb 提供一个虚拟显示即可，二维码由桥接镜像到 WebUI，操作员在浏览器里扫码。
noVNC 只用于人操作窗口，这一环可以去掉。

### 3.1 推荐路径 A：被动 + Xvfb（改动最小、最稳）

```bash
# Linux 无头机器，QQ 以虚拟显示运行；无需 VNC
Xvfb :99 -screen 0 1440x900x24 &
DISPLAY=:99 /opt/QQ/qq --no-sandbox &
# 桥接随 QQ 主进程加载（沿用现有注入方式），HTTP 端口 16082
```

验证顺序（全部只读，不动登录态）：
1. `curl -H "Authorization: Bearer <token>" http://127.0.0.1:16082/api/status` 应看到
   `phase=waiting_official_qq_login`（未登录）或 `online`（已登录）。
2. 在 QQ 窗口（Xvfb 里，或用一次 VNC/x11vnc 临时看一眼）点开“扫码登录”。
3. 再查 `/api/status`：`qr_ready=true`；`GET /api/qr` 返回 PNG。
4. 框架侧：`GET /api/qr` 返回 `state=waiting, refreshable=false, loginMode=passive`，控制台显示二维码。

### 3.2 推荐路径 B：受控主动取码（真正的“零点击”）

运行时在满足以下全部条件时，**串行、限次**调用一次 `getQRCodePicture()`：

- 阶段是 `waiting_login` / `waiting_official_qq_login`，且当前没有二维码；
- 距上次调用 ≥ 90 秒，且全局只有一个在途调用（single-flight 锁）；
- 不在 `checking_session` / `online` / `qr_failed` 冷却期内；
- 调用包在 try/catch 里，异常只记录状态，不冒泡。

如果失败，退回路径 A（被动镜像），不要重试风暴。

### 3.3 与现有“被动依赖窗口”的关键差别

| 项 | 旧行为 | 目标行为 |
|---|---|---|
| 谁触发取码 | 只有 QQ 窗口 | 窗口，或被串行限次的主动调用 |
| 人是否需要看窗口 | 是（noVNC） | 否（Xvfb 虚拟显示 + WebUI 显示二维码） |
| 监听器注册 | 依赖 dlopen 观测门控 | 启动即注册，dlopen 只是快路径 |
| 刷新语义 | 被动模式返回 409，前端仍显示刷新按钮 | 409 + `refreshable=false`，前端置灰并说明原因 |
| 过期/失败 | 只有 `qr_failed` | `state=expired` + `hint`，可重试 |

## 4. 运行时契约 v2（框架已实现，等运行时补齐）

### 4.1 必须实现（否则能力保持“不支持”）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/status` | GET | 至少含 `message_ready`、`self_id`、`phase`、`login_mode`、`qr_ready`；v2 增加 `features` |
| `/api/events?after=` | GET | `{cursor, events:[{cursor,data}]}`；`data` 为 OneBot 形状的 message/message_sent/notice/request |
| `/api/qr` | GET | 200 → `{picture|image, seq, expires_at, phase, login_mode}`；404 → 暂无 |
| `/api/qr/refresh` | POST | 202 接受（随后由 `/api/qr` 给出图片）/ 409 被动不可刷 / 503 不可用 |
| `/api/send` | POST | `{scene, peer_id, segments, reply_to?}` → `{message_id}`；不支持时 404（框架回退 v1） |
| `/api/send-private` | POST | v1 兼容：`{user_id, message}`（纯文本） |

### 4.2 可选（实现了框架就自动点亮对应动作）

| 接口 | 点亮动作 |
|---|---|
| `/api/friends` | get_friend_list |
| `/api/groups` | get_group_list |
| `/api/stranger?user_id=` | get_stranger_info |
| `/api/group-member?group_id=&user_id=` | get_group_member_info |
| `/api/group-members?group_id=` | get_group_member_list |
| `/api/recall` (POST `{message_id}`) | delete_msg |
| `/api/request` (POST `{flag,approve,type,sub_type?}`) | set_friend_add_request / set_group_add_request |
| `/api/media?message_id=&kind=record` | get_record（返回 `{base64,name,size}`，文件未落到本地时 404） |

`features` 是能力开关，框架只会打开运行时**明确声明为 true** 的项，其余保持“不支持”并返回 1200/1404。

`send_segments` / `recv_segments` 按**方向**声明能收发的消息段（`text`/`image`/`record`/`at`/`reply`…）。语音必须两个方向都含 `record`
且 `features.mediaRecord` 为 true，框架才会认为可发送；只声明入站时 `can_send_record` 仍为 `no`。

语音段的 `path` 是 **QQ 容器里的 RichMedia 落盘路径**，不是 Fox 宿主机路径；`url` 只有在运行时真的换到 http 链接时才出现。

### 4.3 需要改的运行时文件（旧 `bridge_webui.cjs`）

1. `attachLogin()`：去掉 `state.nativeProbe.wrapperObserved` 门控；先试 `require('./wrapper.node')`，
   失败再等 dlopen 观测；加 2s 重试与一次性日志。
2. 监听器注册后立即把 `phase` 置为 `waiting_login`（而不是 `starting`），让框架能区分“活着但没码”。
3. 主动取码按 3.2 约束实现，并暴露 `login_mode`、`qr_ready`、`seq`、`expires_at`。
4. `/api/qr` 404 语义：没有码时返回 404 + `{error}`，不要返回 200 空对象。
5. v2 接口按第 4 节实现，`features` 只报真实支持的项。

## 5. 验证与边界

- 验证只用只读接口，**不重启、不退登**已登录的测试 QQ；不向任何真实联系人发消息，除非用户明确要求。
- 电脑上的 QQ 是大号，不用于任何测试。
- 本轮无法执行第 3 节的实测：服务器 SSH 立即断开、16082 端口无响应、本机无桥接（详见交接区与
  `docs/feature-gap.md`）。因此“摆脱 noVNC”目前是**方案 + 代码 + 测试**完成，真实 QQ 未验收。
