Meme雷达开源版 Windows x64 便携版

不需要安装Node.js，也不需要输入PowerShell命令。

使用方法：
1. 右键压缩包，选择“全部解压”。
2. 进入解压后的文件夹。
3. 双击 MemeRadar-OpenSource.exe。
4. 浏览器打开后，展开“设置与运行记录 → AVE API”。
5. 在 https://cloud.ave.ai/login 获取 AVE API Key，填回雷达后点击“保存 / 测试”。

如果显示“无法连接 AVE”：
1. 确认浏览器可以打开 AVE。
2. 开启Windows的系统代理或VPN；如果软件有“设为系统代理”，请打开。
3. 完全关闭Meme雷达黑色窗口，再双击MemeRadar-OpenSource.exe重新启动。
新版会自动读取Windows系统代理，浏览器能访问但雷达仍超时时，请截图黑色窗口。

如果Windows显示“已保护你的电脑”，点击“更多信息”后选择“仍要运行”。
运行期间请保留黑色窗口。关闭黑色窗口或按Ctrl+C会停止本地雷达。
本工具只监听127.0.0.1，不提供钱包、链上交易签名或交易功能。
AVE API Key 仅保存在本机状态目录，不会显示在网页或日志中。
