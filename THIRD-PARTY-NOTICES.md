# 第三方来源与许可声明

DuskFox 的代码独立编写，没有复制下列项目的源码。这里列出实现路线上参考过的项目，以及它们的许可情况。

## NapCat

- 项目：NapCat（QQ 客户端的 OneBot 实现）
- 上游：https://github.com/NapNeko/NapCatQQ
- 许可：Limited Redistribution License for NapCat，Copyright (c) 2024 Mlikiowa
- 说明：上游仓库当前没有随代码提供 LICENSE 文件，许可条款以发布方声明为准。DuskFox 的仓库与镜像不包含 NapCat 的任何源文件。

参考点有两处，属于实现形态上的借鉴，不是代码拷贝：

1. 密码登录的调用方式。`runtime/bridge/kernel/login.cjs` 里 `loginService.passwordLogin({...})` 的参数表和错误码分支，
   与 NapCat `packages/napcat-framework/napcat.ts` 的调用形态一致。这张字段表是腾讯 wrapper.node 的私有接口签名，
   调用方没有别的写法可选，属于功能必要表达。
2. wrapper.node 的导出代理。`runtime/bridge/entry.cjs` 里 `process.dlopen` 补丁中的 Proxy，
   与 NapCat `packages/napcat-framework/napcat.cjs` 的 `nativeProxy` 解决的是同一个约束：
   Proxy 对原生只读、不可配置属性的不变量限制。DuskFox 这边写得更简单，命名和注释都是自己写的。

除这两处以外，DuskFox 与 NapCat 没有文件级重合，也没有连续的段落重合。

## 运行时依赖

| 依赖 | 许可 |
| --- | --- |
| @sinclair/typebox | MIT |
| json5 | MIT |
| nodemailer | MIT-0 |
| ws | MIT |

## QQ 客户端

DuskFox 不分发腾讯 QQ 客户端。Docker 镜像在构建时从腾讯官方地址下载固定版本的客户端，
使用和分发请遵守腾讯的软件许可与用户协议。
