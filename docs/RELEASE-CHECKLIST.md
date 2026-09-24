# 对外发布检查清单

## 必须由项目所有者决定

- [x] 项目名称：Meme雷达开源版；作者：DeFi狙击手（X：@bi_9527zx）；
- [x] 选择 AGPL-3.0-only 并加入 `LICENSE`；
- [x] 使用 GitHub 私密漏洞报告入口；
- [ ] 核查 AVE、GoPlus、DexScreener 等上游服务的使用及商业条款；
- [x] 明确开源版与专业版承诺，不宣传保证盈利。

## 技术验收

- [x] 开源版与当前自用目录分离；
- [x] 发布副本不包含 API Key、运行状态和日志；
- [x] 应用只调用只读数据接口，不接入钱包交易、签名、swap 或下单；依赖包自身的其他能力不代表应用开放这些能力；
- [x] 提供 macOS 与 Windows 启动入口；
- [x] 已完成 macOS 安装和启动测试；
- [ ] v0.1.9 Windows 真机安装、语音播放及真实 API 连接需另行验收；历史版本的测试不计为本版真机测试；
- [x] 完成直接及传递依赖许可证复核；
- [x] 运行 `npm test`；
- [ ] 升级发布时先生成与 `package.json` 三段版本完全一致的 `MemeRadar-OpenSource-Windows-x64-<version>.zip`、`MemeRadar-OpenSource-macOS-<version>.zip` 和 `SHA256SUMS-<version>.txt`；
- [ ] 对最终待上传目录运行 `npm run release:audit -- --artifacts <发布资产目录>`；不允许用未打包的源码检查代替该步骤；
- [ ] 确认两个 ZIP 都包含且精确匹配当前发布源：`src/updater.mjs`、`scripts/update-worker.mjs`、`public/update-ui.mjs`；审计脚本会同时阻断错误根目录、平台启动文件缺失、版本漂移、资产名不符和 SHA-256 不一致；
- [x] 使用已公开的独立开源仓库；
- [x] 项目所有者已授权同步更新及 Windows、macOS 双版本发布。
