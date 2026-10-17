# Node Switcher · 本地分流工具

开发启动：`nvm use && npm ci && npm start`（Node.js 版本见 `.nvmrc`）。没有 nvm 时可运行 `bash scripts/setup.sh`，将 nvm、Node.js 和依赖全部安装到项目内，再运行 `bash scripts/launch.sh`。

输入网站、选择本机节点或策略组，直接写入分流配置并立即生效。配置处理、备份和恢复均在用户电脑上完成，无需工具账号或云端服务。

A local desktop routing editor for Mihomo and Clash Verge Rev. Map domains to existing proxy nodes or groups, apply immediately, and undo with verified local backups.

> **v0.1.0-alpha.1：开发预览版。** 首轮验证环境为 macOS Apple Silicon、Clash Verge Rev 2.4.7 / Mihomo 1.19.21。Windows / Linux 的桌面集成、其他客户端版本及开发者签名分发仍待验证，不承诺通用兼容。

## 已实现

- 自动发现标准目录下的 Clash Verge Rev；支持手动选择数据目录或独立 Mihomo 运行配置。
- 通过本机 TCP、Unix socket 或 Windows 命名管道控制接口读取节点与策略组。
- 添加网站，选择“仅此域名”或“此域名及子域名”，指定已有节点、策略组或直连。
- 应用前规范化域名、检查重复与出口存在性，使用用户已有的 Mihomo 内核校验配置。
- 预览后直接备份、写入、重载，并从内核回读已加载的规则；未确认成功时不会显示生效。
- 编辑或删除本工具管理的规则；保留其他规则与原有扩展脚本。
- 撤销应用、检测外部修改、恢复中断操作；重复应用不重复追加规则。

## 使用方式

1. 保持代理客户端运行，并使用**规则模式**，打开 Node Switcher。
2. 确认识别到的是需要管理的客户端和订阅；无法识别时进入“连接设置”手动选择。
3. 输入网站并选择出口，点击“添加”。
4. 点击“检查并预览”，确认规则与目标配置，再点击“应用并生效”。

需要撤销时，打开“恢复记录”。若配置已有后续修改，自动恢复会停止，避免覆盖这些修改。

应用不会主动断开已有连接；已有连接可能继续使用原出口，新连接使用新规则。工具核验的是内核加载的规则，不保证某个第三方网站可以访问或账号能够使用。

## 适配方式

| 客户端 | 持久保存位置 | 立即生效方式 |
| --- | --- | --- |
| Clash Verge Rev | 当前订阅已有的专属扩展脚本，末尾追加受管理的片段 | 更新运行配置并通过本地 API 重载 |
| 独立 Mihomo | 用户选择的实际运行 YAML，附带 `x-node-switcher` 元数据 | 通过配置中声明的本地 API 重载 |

Clash Verge Rev 的原扩展脚本保持原文；受管理片段在其 `main` 返回后前置网站规则。订阅重新生成配置时会再次执行该片段。若当前订阅没有标准同步 `main` 扩展脚本，工具会停止直接应用，不擅自改写订阅注册信息。

独立 Mihomo 适配用于自己管理运行文件的用户。其他 GUI 客户端可能重新生成运行文件，需要专属适配；不要将其生成文件当作独立配置长期管理。

## 限制

- 网站可能依赖登录、API、图片等多个域名，需分别添加；当前不支持 URL 路径分流、IP 规则或站点域名自动补全。
- 首版不判断节点名对应的真实地理位置；“日本”“美国”等以用户已有名称和选择为准。
- 目标节点或策略组被订阅删除、改名后，需要重新选择。工具空闲时会定期检查已保存规则的加载状态，不会悄悄改走其他出口。
- 名称包含逗号、换行或控制字符的出口暂不支持。网站规则最多 500 条。
- 操作系统权限、客户端版本或其他配置程序可能阻止写入或重载。遇到冲突会停止；备份中含原配置，请勿公开分享。
- macOS 开发包采用 ad-hoc 签名，尚未经过 Apple Developer ID 签名或公证。面向公众的正式安装分发仍在后续计划中。

## 本地开发

已有 nvm 的环境：

```sh
nvm install
nvm use
which node
npm ci
npm start
```

完全放在项目内的环境（macOS / Linux）：

```sh
bash scripts/setup.sh
bash scripts/launch.sh
```

`setup.sh` 不修改 shell 配置，不安装全局业务依赖。手动进入该项目环境：

```sh
export NVM_DIR="$PWD/.tools/nvm"
source "$NVM_DIR/nvm.sh"
nvm use
which node
npm ci
```

Windows 开发请使用现有版本管理器选择 `.nvmrc` 所列的精确 Node.js 版本，再执行 `npm ci && npm start`。Windows / Linux 首次使用通常还需在连接设置中选择本机 Mihomo 可执行程序。

### 隔离演示

```sh
npm run demo
```

演示版只连接合成客户端接口，写入隔离测试目录，不发现或修改真实客户端。它适合体验添加、预览、应用和恢复流程，界面顶部会持续显示演示标记。

### 验证

```sh
npm run check
npm test
npm run test:ui
npm run test:core
npm audit
```

- `npm test`：使用临时 YAML、合成节点及本地 API，覆盖规则、持久化、认证、冲突、并发、回滚与中断恢复。
- `npm run test:ui`：Electron 自检，仅使用合成配置，截图写入忽略提交的 `.artifacts/ui/`。
- `npm run test:core`：使用已有 Mihomo 可执行程序，运行关闭 TUN 的独立实例和两个回环测试出口，验证实际代理链。不会使用真实节点或访问外部网站。默认寻找 macOS Clash Verge 内核，其他位置通过 `MIHOMO_BIN` 指定。
- `node scripts/check-local-client.mjs --preview`：显式检查本机真实客户端的连接和候选配置。不重载内核、不改写现有配置；校验时会临时创建候选文件并在结束后删除。

### 打包

```sh
npm run pack
# macOS ZIP 与 SHA-256 校验文件
npm run dist:mac
```

产物位于 `release/`，只包含桌面运行代码、UI 与生产依赖，不打包个人配置、测试数据或开发环境。打包脚本按当前系统和 CPU 架构生成产物。

## 数据与恢复

工具设置和备份位于系统用户数据目录下的 Node Switcher 文件夹，可从“恢复记录 → 打开备份目录”定位。密钥由主进程从客户端配置读取，不进入渲染界面，也不另存进工具设置。

应用前会保存原文件、内容校验值和事务记录。失败或中断时，只有文件仍是本次写入版本或原始版本才允许自动恢复。POSIX 系统下备份目录使用 `0700`，文件使用 `0600`；Windows 依赖用户数据目录的访问控制。

详细机制见 [架构与适配说明](docs/ARCHITECTURE.md)。需求和后续计划见 [路线图](docs/ROADMAP.md) 与 [Issues](https://github.com/foogooooooo/node-switcher/issues)。

## 贡献与许可证

欢迎提交脱敏使用场景和兼容反馈，见 [贡献指南](CONTRIBUTING.md)。不要在 Issue、截图或 commit 中提交真实订阅地址、节点凭据或完整客户端配置。

[MIT License](LICENSE)。本项目不提供节点或订阅，与 Clash / Mihomo 项目无隶属关系。
