# DuskFox 功能状态

当前版本 1.2.1。离线测试与专用测试号实测范围不同，安装者应使用自己的测试号验收。

| 能力 | 当前状态 |
|---|---|
| OneBot v11 HTTP、正向/反向 WebSocket、事件上报 | 框架已实现，离线测试通过 |
| WebUI 登录、状态、网络与日志 | 已实现，专用测试实例使用中 |
| 专用测试号扫码、私聊文本收发、群文本发送 | 已实机验证 |
| 好友/群资料与 UID/UIN 映射 | 已有接口，部分边界仍待实测 |
| 私聊/群图片发送 | 专用测试实例已验证基本路径 |
| AstrBot 消息回路 | 专用测试实例已验证基本路径 |
| 消息 ID 与统计跨 Fox 重启 | 已落盘；超出保留窗口的消息可能不可查询 |
| SMTP 邮件通知 | 本版新增，待用户邮箱实测 |
| 语音入站（record 段 + get_record） | 已实现，离线闭环通过；真实 QQ 未实测 |
| 语音发送 | 已实现但默认关闭（QQ_BRIDGE_RECORD_SEND=1），需要 ffmpeg；未在真实 QQ 验收 |
| 文件与合并转发 | 已实现；测试号基本可用，部分边界仍待实测 |
| 视频 | 暂不提供 |

## 语音（record）说明

- 入站：原生 `pttElement` 归一化成 OneBot `record` 段，字段为 `file`（文件名）、`path`（**QQ 容器内的 RichMedia 落盘路径**）、
  `file_size`，能拿到 http 链接时才有 `url`。QQ 客户端收到语音后不一定已把音频落盘，`get_record` 会先触发一次下载再读文件。
- 出站：`record` 段的 `file` 支持本地路径、`file://`、`http(s)` 和 `base64://`；非 silk 音频会用 `ffmpeg` 转成 QQ 需要的
  `ntsilk_s16le`（24kHz 单声道），所以运行环境需要 ffmpeg，或用 `QQ_BRIDGE_FFMPEG` 指定路径。
- 能力：`send_segments` / `recv_segments` 按方向声明；默认只声明语音入站，`can_send_record` 如实返回 `no`。
- 未实测项列在 `/api/status.pending_native`：`downloadRichMedia` 参数与回调字段、silk 转码后的 `pttElement` 是否被客户端接受。

运行时依赖官方 QQ 客户端。QQ 版本更新后，原生接口可能变化。
