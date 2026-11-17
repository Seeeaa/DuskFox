# DuskFox QQ 接入点

当前桥接由原生运行时、框架驱动、OneBot 协议层和 WebUI 组成。

- `runtime/bridge/entry.cjs`：在专用 QQ 运行时中注册登录与消息监听，并启动桥接服务。
- `runtime/bridge/native-kernel.cjs`：将原生会话、好友/群资料和消息调用适配为桥接契约。
- `runtime/bridge/server.mjs`：提供状态、二维码、事件、发送和资料接口。
- `src/driver/bridge.ts`：协商运行时能力，轮询事件，处理超时与重连。
- `src/onebot/`：将框架动作与事件映射为 OneBot v11。

实机边界：扫码授权、消息网络就绪和消息送达分别验证。图片上传与群列表仍有未解决的原生错误。Windows/Linux 的 QQ 安装路径和加载环境须分别验证。
