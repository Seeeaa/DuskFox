# 在 Windows 上用 Docker Desktop 跑 DuskFox

写给在 Windows 本机上试跑的人：用 Docker Desktop 起两个容器，一个是官方 QQ 客户端，一个是控制台。

大体上是这样的（如果有小问题可以先问问 ai？我 win 环境还没试过，但是看 Docker Desktop 是这样搞的）。

## 需求

- Windows 10 21H2 或 Windows 11，x86_64
- WSL2 和 Docker Desktop（WSL2 backend）
- 给 Docker 至少 6 GiB 内存，磁盘留 10 GiB
- 一个专用测试 QQ 号

两个容器：QQ 限 1250 MiB，控制台限 320 MiB。QQ 是带图形界面的客户端，实际占用比限额小一些，够用就行。

## 1. 装 Docker Desktop

装完在设置里确认 Use the WSL 2 based engine 是打开的。命令行用 `docker compose`（v2），老版的 `docker-compose` 不要用。

内存不够时，在 `C:\Users\<用户名>\.wslconfig` 里调：

```ini
[wsl2]
memory=8GB
processors=4
```

改完执行 `wsl --shutdown`，再重新启动 Docker Desktop。

## 2. 拉代码

```powershell
git clone https://github.com/Seeeaa/DuskFox.git
cd DuskFox
```

## 3. 构建镜像

```powershell
docker compose -f deploy/linux/compose.yaml build
```

第一次构建做三件事：拉 Node 基础镜像、apt 装图形库、从腾讯官方地址下载 QQ 的 `.deb`。最后一步要能连外网，国内网络经常很慢。

下载不动的话，按 `deploy/linux/Dockerfile.qq` 里那个地址自己下一份，命名成 `deploy/linux/QQ.deb` 放进仓库，再执行上面的构建命令。Dockerfile 会优先用它，SHA-256 照样校验。这个文件已经在 .gitignore 里，不会被提交。

需要走代理的话，在 Docker Desktop 的 Settings → Resources → Proxies 里配，构建阶段才会生效。

## 4. 启动

```powershell
docker compose -f deploy/linux/compose.yaml up -d
docker compose -f deploy/linux/compose.yaml ps
```

等 `qq` 变成 healthy，一般一到两分钟。它的 start_period 是 90 秒，前面显示 starting 是正常的。

## 5. 取令牌

控制台：

```powershell
docker compose -f deploy/linux/compose.yaml exec -T fox node -p "JSON.parse(require('fs').readFileSync('/state/config/webui.json','utf8')).token"
```

OneBot：

```powershell
docker compose -f deploy/linux/compose.yaml exec -T fox node -p "require('fs').readFileSync('/state/config/onebot.token','utf8')"
```

两枚令牌都在 Docker 卷里，别往仓库或聊天里存。

## 6. 打开控制台

浏览器访问 http://127.0.0.1:16084/ ，粘第一枚令牌。

进账号页，点手动取码，用手机 QQ 扫码。登录成功后账号页会显示在线。QQ 的登录窗口由容器内的 Xvfb 渲染，通过 `login-view` 卷交给控制台显示，Windows 这边不用装 VNC 客户端。

## 7. 接 OneBot 客户端

地址填 `http://127.0.0.1:13000`，令牌用第二枚；正反向 WebSocket 的地址格式在控制台网络页能看到。

AstrBot 这类框架如果也跑在 Docker 里，容器之间不能直接用 `127.0.0.1`，要换成宿主机的局域网 IP，或者把框架放进同一个 compose 网络。

## 8. 日常操作

```powershell
# 看日志
docker compose -f deploy/linux/compose.yaml logs -f fox

# 重启，不动数据
docker compose -f deploy/linux/compose.yaml restart

# 停止，保留数据卷
docker compose -f deploy/linux/compose.yaml down
```

升级：`git pull` 之后重新 `build` 再 `up -d`。只改了控制台，可以只重建 fox 服务；桥接运行时也改了，就必须重建 qq 服务，重建后要重新扫码。

**别用 `down --volumes`**：那会连数据卷一起删，登录状态和配置都没了，得重新扫码。

## 9. 常见问题

**端口被占用。** 16084 或 13000 被别的程序占了，就在仓库根目录建一个 `.env`：

```
DUSKFOX_WEBUI_PORT=26084
DUSKFOX_ONEBOT_PORT=23000
```

**构建卡在下载 QQ。** 见第 3 节，放 `QQ.deb` 或者配代理。

**容器起来了但控制台打不开。** 先看 `docker compose -f deploy/linux/compose.yaml ps` 里 fox 是不是 healthy，再看 `logs fox`。第一次启动要生成配置，慢几秒正常。

**扫码后一直显示离线。** 先等一会儿，QQ 客户端会重启一次才连上消息服务。超过一分钟还是离线，看容器日志，多半是 QQ 版本更新导致桥接失效。

**磁盘占用越来越大。** Docker Desktop 的虚拟磁盘只增不减。清的时候用 `docker system prune`，注意别顺手把还在用的数据卷清掉。

## 10. 和 Linux 部署的差异

- Linux 文档里的 SSH 隧道用不上，本机直接访问 127.0.0.1 就行。
- 数据在 Docker 的虚拟磁盘里，备份得用 `docker run --rm -v` 打包，不能直接复制文件夹。
- 容器内时区是 UTC，日志时间比北京时间少 8 小时。
