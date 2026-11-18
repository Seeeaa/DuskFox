# DuskFox

把普通 QQ 消息接到 OneBot v11，供 AstrBot 等机器人框架使用，附带 Web 控制台。

目前开放 Linux x86_64 Docker 内测。建议准备 2 GiB 可用内存，并先用测试号。

```bash
git clone https://github.com/Seeeaa/DuskFox.git
cd DuskFox
docker compose -f deploy/linux/compose.yaml up -d --build
docker compose -f deploy/linux/compose.yaml exec -T fox node -p "JSON.parse(require('fs').readFileSync('/state/config/webui.json','utf8')).token"
```

用最后一行输出的令牌打开 `http://127.0.0.1:16084/`，在账号页扫码。OneBot HTTP/WS 默认监听本机 `13000` 端口；接入令牌的读取方法见[安装说明](deploy/linux/README.md)。远程服务器可用 SSH 隧道访问控制台。

构建时从 QQ 官方地址获取固定版本客户端，仓库不附带 QQ 安装包。官方 CDN 下载不通时，可按安装说明自行提供同版 `QQ.deb`。全新环境的安装流程仍在验证。

[本地演示](docs/install.md) · [许可](LICENSE)
