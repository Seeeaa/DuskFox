# 文件下载

文件（以及视频原片之外的普通文件）走两条通道取本地字节：先用原生的 downloadRichMedia，
超时或失败后退到 FileAssistant。两条都失败时把两边的失败原因一起带出去。

## 下载链

- 已有完整本地文件：直接复用。
- 否则先按原消息 msgId + elementId 调 downloadRichMedia，最多等 120 秒。
- 失败后调用 file-assistant.cjs 的 FileAssistant.download({fileUuid, fileId, ...})，这条通道同样预算 120 秒。
- 两条通道都失败时，抛 AggregateError，保留两边的原始原因。备用通道成功时，errors 里仍保留前一条通道的失败。

FileAssistant 用当前 QQ 会话的 getFileAssistantService()：

1. 查询和下载前先注册监听，避免漏掉同步回调。
2. 接受 fileUuid 或 fileId，标识原样保留，不删 UUID 的前导斜杠。
3. 有消息 ID 和文件名时，先 searchFile 查目录，按消息 ID、会话、文件名/大小或精确标识定位实际记录，不凭同名文件随手匹配。
4. 查到已下载的完整 filePath 就直接复用；否则 downloadFile([id]) 并监听 onFileStatusChanged。
5. 按回调 id 匹配目标，fileStatus=2 且 fileProgress=0 后取 filePath，检查文件存在与声明大小。
6. 同一下载合并进行；成功路径写回媒体路径缓存。停止或切换会话时取消等待并解绑监听。

只有明确访问媒体下载或探针时才启动这条通道；消息接收、get_msg 回填、转发展开都不会预下载。

## 探针接口

注册在 runtime/bridge/routes/account.mjs。

```http
GET /api/media/probe?message_id=<原生消息ID>&kind=file
Authorization: Bearer <bridge令牌>
```

调用的是 QQ bridge 的地址（容器内通常是 http://127.0.0.1:16082），不是控制台登录接口。
可附加 selector=<原生elementId>，用于同一消息里的多个文件。

接口只查询和下载，返回本地路径与 stat 大小；不发送、撤回、删除消息，不写配置，也不回整文件 base64。
路径属于 QQ 运行时环境。

RichMedia 超时、备用通道成功时：

```json
{
  "ok": true,
  "path": "/home/node/.local/share/.../report.pdf",
  "size": 606883,
  "channel": "FileAssistant",
  "errors": [
    {
      "channel": "downloadRichMedia",
      "operation": "downloadRichMedia",
      "fileUuid": "/6ed16abf-...",
      "fileId": "",
      "elapsedMs": 120001,
      "error": "MEDIA_DOWNLOAD_TIMEOUT: downloadRichMedia msg=... element=...",
      "stack": "Error: MEDIA_DOWNLOAD_TIMEOUT: ..."
    }
  ]
}
```

两条都失败：

```json
{
  "ok": false,
  "path": "",
  "size": 0,
  "channel": "FileAssistant",
  "errors": [
    { "channel": "downloadRichMedia", "operation": "downloadRichMedia", "error": "原始错误原文" },
    { "channel": "FileAssistant", "operation": "downloadFile", "error": "原始错误原文" }
  ]
}
```

正常结果一律 HTTP 200，看 ok 判断成功与否；不支持的 kind 返回 400，运行时没有探针能力返回 501。
channel 可能是 local、downloadRichMedia、FileAssistant 或 probe。

## 与现有接口的关系

- /api/media 的路由和 base64/name/size 响应格式没变，只是内部多了 FileAssistant 后备，原来的 URL 后备也保留。
- 文件段仍保留 dfm file_id，另补 file_uuid 与 native_file_id 两个原生标识，不替换现有定位方式。
- 为了容纳两条串行的 120 秒通道，Fox 请求 bridge 的文件下载/探针预算设为 250 秒，OneBot get_file 动作为 260 秒；
  图片、语音、视频和其他动作的预算不变。
- 日志前缀 [bridge] file-download，带 channel、operation、fileUuid/fileId、elapsedMs、path/size 或原始 error/stack。
