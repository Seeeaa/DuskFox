# duskfox 与 NapCat / SnowLuma 功能差距（2026-11-17）

口径
- `NapCat`：本地快照 `napcat-fork/NapCatQQ-fork`（packages/napcat-onebot、napcat-schema、napcat-core）。
- `SnowLuma`：本地快照 `snowluma/` v2.4.2（packages/onebot、bridge、protocol、webui）。
- `duskfox`：本仓库 HEAD，动作数由 `src/onebot/actions/*` 实际注册决定。
- 状态定义：
  - **已实现**：框架代码 + 自动化测试可验证（不依赖真实 QQ）。
  - **契约已定**：框架侧与驱动契约已完成，需运行时实现（真实 QQ 才能验证）。
  - **不支持**：动作未注册，调用返回 `retcode 1404`；能力被声明为 false。
  - **部分**：能力存在但覆盖面小于 NapCat。

## 1. 总览

| 维度 | NapCat | SnowLuma | duskfox | 状态 |
|---|---|---|---|---|
| OneBot 动作数 | 206（+别名 → 618 项） | 222 | 17 | 部分（核心通讯闭环） |
| 消息段类型 | 24 | ~22 | 12 | 部分（缺 mface/xml/miniapp/node/onlinefile/flashtransfer/music/poke/dice/rps/contact/location） |
| 事件 notice 类型 | 14 + notify 6 子类 | 与 NapCat 对齐（注释明示） | 8 | 部分 |
| 连接形态 | 5 类适配器（http/ws×2/http-client/sse）+ 插件适配器 | 4 类 + SSE + 反向 WS SDK | 5 类 | 已实现（缺 x-signature/quick_action） |
| 扫码登录 | loginService 主动取码 | **无登录能力** | 主动/被动两种语义已定 | 契约已定（真实 QQ 未验） |
| 群消息 | 收发、临时会话、群管理 41 个动作 | 收发 + 群管理 24 个动作 | 收发（框架+驱动契约） | 已实现（mock/契约测试） |
| 媒体 | 图片/语音/视频/文件/合并转发（依赖宿主上传/Rkey） | 同上 + 闪传 fileset | 媒体段**透传**，无上传/下载通道 | 部分 |
| 好友/群资料 | 15 个动作 | 支持（含荣誉/相册/空间） | 好友列表、群列表、陌生人、群成员（单个/列表） | 部分 |
| 消息查询 | get_msg、历史消息、合并转发查询 | 支持 | get_msg（本地 500 条窗口） | 部分（无历史/转发） |
| 请求处理 | 8 个 | 2 个 | 2 个（好友/加群） | 已实现 |
| 插件 | 进程内插件 + 白名单 | 无插件 | 进程内插件（事件钩子） | 部分（无路由注册） |
| WebUI | 6099，JWT，TOTP | 5099，TOTP，备份/更新 | 6099，会话令牌，SSE | 已实现（覆盖面小于两者） |

## 2. 动作面

| 组 | NapCat 代表动作 | duskfox | 说明 |
|---|---|---|---|
| 系统（28） | get_login_info / get_status / get_version_info / can_send_image / can_send_record / set_restart / clean_cache | 5 个已实现 | 缺 set_restart（进程控制走 /api/instance/restart）、clean_cache、cookies/csrf、rkey |
| 消息（20） | send_private_msg / send_group_msg / send_msg / delete_msg / get_msg / get_forward_msg / get_*_msg_history / handle_quick_operation / set_msg_emoji_like | 5 个已实现 | 缺合并转发、历史消息、快捷操作、表情回应 |
| 群（41） | get_group_list / get_group_info / get_group_member_list / set_group_ban / set_group_kick / set_group_card / set_group_whole_ban / 群文件 / 群公告 / 精华 / 打卡 / 待办 | 1 个已实现（get_group_list） | **群管理全部不支持**（需要运行时提供写能力）；群成员列表已实现 |
| 好友/资料（15） | get_friend_list / get_stranger_info / get_friends_with_category / send_like / set_qq_profile / set_input_status | 2 个已实现（列表/陌生人） | 资料写入、点赞、状态设置不支持 |
| 文件/媒体（37） | upload_group_file / get_group_root_files / get_image / get_record / download_file / 闪传 | 0 | **不支持**：框架没有上传/下载通道，只有消息段透传 |
| 请求（8） | set_friend_add_request / set_group_add_request / get_group_system_msg | 2 个已实现 | 系统消息列表不支持 |
| 扩展（57） | Ark / 小程序 / Qzone / 相册 / 收藏 / AI 语音 | 0 | 明确不实现（与连接器目标无关） |

合计：duskfox 注册 **17** 个动作（`GET /api/actions` 可核对），其中
- 已实现且测试覆盖：13
- 新增并通过契约测试：get_msg、get_group_member_list、set_friend_add_request、set_group_add_request

## 3. 事件面

| 事件 | NapCat | duskfox |
|---|---|---|
| message.private（friend / 临时会话） | 支持 | friend：已实现；临时会话：仅字段透传（sub_type 固定 friend） |
| message.group | 支持 | 已实现（驱动契约 + mock） |
| message_sent | 支持（report_self_message） | 已实现（本次改为 post_type=message_sent） |
| friend_recall / group_recall | 支持 | 已实现（驱动契约） |
| group_increase / decrease / admin / ban / upload | 支持 | 已实现（驱动契约） |
| group_card / essence / group_msg_emoji_like / notify(poke,title,group_name,gray_tip,input_status,profile_like) | 支持 | **不支持**（未注册构造器） |
| online_file_* / bot_offline | 支持 | 不支持（bot_offline 可用 lifecycle.disable 表达，未单独建模） |
| request friend/group | 支持 | 已实现（含处理动作） |
| meta_event lifecycle/heartbeat | 按连接独立产生 | 已实现（按连接下发 lifecycle.connect） |

## 4. 网络面

| 项 | NapCat | duskfox |
|---|---|---|
| HTTP 服务端 | `/<action>`，GET/POST，CORS 可配，可选同端口 WS（`/api` 不发事件） | 同形态；缺根路径文本、缺 `x-signature` |
| HTTP 上报 | POST + `x-self-id` + `x-signature: sha1=HMAC`，响应可回 `quick_action` | POST + `X-Self-ID`，**无签名、无 quick_action** |
| WS 服务端/客户端 | 支持，命中心跳 30s，客户端可校验证书 | 支持，心跳/重连可配，无证书校验选项 |
| SSE | 独立适配器 + `GET /_events` | 支持 `/events`，**无 Last-Event-ID 续传** |
| 鉴权 | token（Bearer / access_token） | 相同 |
| 消息格式 | array / string（CQ） | 相同 |

## 5. 媒体与富内容

NapCat 的关键事实：图片/语音/视频/文件都**不经过自建上传**，而是把文件放进 QQ 客户端的 RichMedia 目录由客户端上传；URL 需要 Rkey；
合并转发需要 `UploadForwardMsgV2`/`FetchForwardMsg` 数据包通道。

duskfox 现状：
- 消息段可以**收发透传**（驱动收到什么段就转什么段），但**不能主动上传文件**，也不能为用户消息补 URL；
- `get_image`/`get_record`/`upload_*_file`/`get_forward_msg` 均未注册，调用得到 1404；
- 若运行时在 v2 契约里实现 `mediaDownload`，框架已有能力位，但没有对应动作实现（下一步）。

**结论：媒体是本轮明确不支持的项，不做“假装支持”。**

## 6. 登录面（与 SnowLuma 的关键差异）

- SnowLuma **完全没有登录能力**：只接管已登录的 QQ 客户端（全仓无 QR/密码代码）。
- NapCat 有 loginService，可主动 `getQRCodePicture()`，也有纯 Node 无头包。
- duskfox：框架已定义两种登录语义（主动/被动），并修正了被动模式的呈现；**真实取码依赖运行时**，
  本轮无法验证（见第 8 节）。

## 7. 我们能复用 / 不能复用

| 对象 | 能复用 | 不能复用 |
|---|---|---|
| NapCat | 协议行为（notice 子类型、message_id 规则、`/api` 角色、x-signature 思路）、版本闸门思路 | 源码/二进制（非 OSI、禁商用、禁公开修改版） |
| SnowLuma | action 单一真源派生文档、per-account 配置、SSE 推送、版本闸门 | 代码与原生 addon（明确禁止“基于其开发另一个项目”，且为专有二进制） |
| 通用 | OneBot v11 规范本身 | — |

## 8. 本轮无法验证的部分（真实 QQ）

- 服务器 SSH 22 端口 TCP 可连但立即 "Connection closed"；16082 端口 TCP 可连但 HTTP 无响应。
- 本机无 QQ 桥接（16082 未监听）、无 Docker；电脑上的 QQ 是大号，按要求不触碰。
- 因此：真实 QQ 的收消息、发消息、群/媒体/资料能力**均未验收**，状态保持“契约已定/不支持”，
  未把 mock 结果写成真实 QQ 成功。

## 9. 补齐优先级（建议）

1. 运行时实现 v2 契约（`/api/send`、`/api/friends|groups|stranger|group-member(s)`、`/api/recall`、`/api/request`、`features`），
   框架侧已就绪，接上即可点亮对应能力。
2. 群消息真实收发（运行时提供群会话发送与 onRecvMsg 群消息解析）。
3. 媒体：先做“收到媒体段附带 URL”（运行时解析 element 的 url），再做 `get_image`/`get_record` 下载；
   上传能力需要客户端 RichMedia 路径，属于运行时职责。
4. 消息历史/合并转发：需要运行时的数据包通道，框架侧只做动作壳与超时。
5. notice 扩展（card/essence/emoji_like/poke）：框架加构造器 + 运行时加事件源，成本低。
