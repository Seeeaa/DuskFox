# DuskFox

QQ 到 OneBot v11 的连接器，附带 Web 控制台。`v1.0.0` 供 Linux Docker 内测。

仓库可以运行模拟账号，用来查看界面和联调 OneBot。Linux Docker 安装会从 QQ 官方地址下载固定版本客户端，在独立容器中启动原生桥接，供专用测试账号扫码接入。

安装和本地演示：[docs/install.md](docs/install.md)。

Linux Docker 真实 QQ 内测：[deploy/linux/README.md](deploy/linux/README.md)。安装时从 QQ 官方 CDN 下载客户端，仓库不包含 QQ 安装包；首次全新构建尚未在独立机器完成验收。内测请使用专用账号。

此项目按 [LICENSE](LICENSE) 使用。
