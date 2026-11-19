# Linux Docker 内测

适用：`x86_64` Linux、Docker Engine 与 Compose v2。建议至少留出 2 GiB 可用内存和 4 GiB 磁盘空间。每套部署只登录一个 QQ 账号。

镜像在本机构建。默认从腾讯官方 CDN 下载固定版本的 Linux QQ `.deb`；如果下载不通，可自行从 [Dockerfile.qq](Dockerfile.qq) 中的官方地址获取同版安装包，命名为 `deploy/linux/QQ.deb` 后再构建。两种方式都校验 SHA-256。该文件已被 Git 忽略，仓库和镜像仓库均不分发 QQ 安装包。QQ 更新后需重新验证桥接。当前测试服务器从官方 CDN 下载较慢；全新镜像构建尚未完成实测。

```bash
git clone https://github.com/Seeeaa/DuskFox.git
cd DuskFox
docker compose -f deploy/linux/compose.yaml build
docker compose -f deploy/linux/compose.yaml up -d
docker compose -f deploy/linux/compose.yaml ps
```

默认只在宿主机本地监听：控制台 `http://127.0.0.1:16084/`，OneBot HTTP/WS `127.0.0.1:13000`。远程服务器可在自己的电脑上打开 SSH 隧道：

```bash
ssh -N -L 16084:127.0.0.1:16084 -L 13000:127.0.0.1:13000 user@your-server
```

首次启动生成两枚独立令牌，保存在 Docker 卷里。以下命令只在自己的终端读取，不会写入仓库：

```bash
docker compose -f deploy/linux/compose.yaml exec -T fox node -p "JSON.parse(require('fs').readFileSync('/state/config/webui.json','utf8')).token"
docker compose -f deploy/linux/compose.yaml exec -T fox node -p "require('fs').readFileSync('/state/config/onebot.token','utf8')"
```

用第一枚令牌进入控制台。官方 QQ 会尝试恢复已有会话。首次登录时，在账号页点手动取码后用专用测试 QQ 扫码。第二枚令牌用于 OneBot HTTP/WS 客户端。QQ 桥接令牌单独存放在 `bridge-data` 卷里，不需手动复制到配置。容器以普通用户运行，QQ 桥接端口只在容器网络内开放。

连接 AstrBot 等框架时，把 OneBot HTTP/WS 地址与第二枚令牌填到对应适配器。若框架也运行在 Docker 容器内，需要让它能访问宿主机的 `13000` 端口，或在控制台网络页配置反向 WebSocket 到该框架可访问的地址。

仅重启：`docker compose -f deploy/linux/compose.yaml restart`。停止：`docker compose -f deploy/linux/compose.yaml down`。这两条命令均保留 QQ 和控制台的数据卷；不要用 `down --volumes`。升级前备份数据卷，再拉取代码、重建镜像并启动。当前内测范围是扫码、状态、私聊/群聊文字与图片、OneBot 收发；群列表与高级动作不作为这一版的验收条件。
