# 安装与本地演示

需要 Git、Node.js 20.11 或更新版本、npm。Windows 与 Linux 均可运行框架和模拟账号。

```bash
git clone https://github.com/Seeeaa/DuskFox.git
cd DuskFox
npm ci
npm run build
node dist/main.js --driver mock --simulate --workdir ./.demo --host 127.0.0.1 --port 18890
```

打开 `http://127.0.0.1:18890/`。首次启动后，管理令牌保存在 `.demo/config/webui.json` 的 `token` 字段。输入令牌即可进入控制台。模拟账号、二维码、好友和消息都是本机生成的演示数据，不会登录 QQ。结束时按 `Ctrl+C`。

如需运行真实 QQ，请另外准备 QQ 客户端和能提供桥接 HTTP 接口的原生运行时。框架侧设置环境变量 `DUSKFOX_BRIDGE_TOKEN`，再用 `--driver bridge --bridge-url http://127.0.0.1:<桥接端口>` 连接；接口字段见 [运行时契约](native-runtime.md)。当前没有可复现的一键部署包，真实账号接入和部分动作仍在实机验证中。

控制台侧栏的退出操作只退出网页管理会话，不会退出 QQ。不要将管理令牌或桥接令牌提交到仓库。
