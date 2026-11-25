# 随看 · 视频浏览服务

独立的视频观看网页，使用 `../library-server` 的作品、作者和媒体接口。抖音风格的移动端满屏布局，上下滑动切换视频；电脑端使用滚轮或方向键，空格暂停/播放。

已部署：**https://douyin.home.zqzyz.com**。沿用 homelab 的 HTTPS 和访问范围。

## 本机启动

需要 Node.js 22+，无需安装 npm 依赖。先启动资料库，再启动此服务：

```sh
# 终端一：启动资料库（已有服务时不重复启动）
cd /Users/zq/code/douyin-downloader/library-server
PORT=3001 npm start

# 终端二：启动观看服务
cd /Users/zq/code/douyin-downloader/video-web
npm start
```

打开 http://127.0.0.1:3002。默认监听 `0.0.0.0`，同一局域网的手机可使用启动输出中的局域网地址。环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3002` | 视频服务端口 |
| `HOST` | `0.0.0.0` | 手动启动的监听地址 |
| `LIBRARY_URL` | `http://127.0.0.1:3001` | 现有资料库服务地址，仅支持 HTTP(S) origin |
| `IDLE_MS` | `0` | 空闲退出时间，0 表示手动运行时不退出 |

已安装的域名服务通过 launchd 占用 `127.0.0.1:3002`，手动预览请改用 `PORT=3003 npm start`。

## 使用

- 「推荐」从随机一页开始浏览，「最新」按资料库默认发布时间顺序浏览；到末尾自动加载下一组。
- 单击画面暂停/继续，双击收藏；底栏控制声音。首次静音自动播放时显示「点击开启声音」，并记住手动选择，切换视频和刷新后沿用。若浏览器阻止有声自动播放，会临时静音并再次显示开启提示，不覆盖已保存的声音偏好。
- 拖动底部进度条跳转；点击作者头像/昵称查看该作者的视频，顶部搜索可以搜索视频和作者。
- 收藏保存在当前浏览器中，可从底栏「收藏」进入。不更改资料库，也不会伪造点赞、评论等平台数据。
- 分享链接携带作品 ID。对方需要能够访问同一个 homelab 域名。
- 视频循环播放，上下滑动切换；后台页面暂停播放，回到前台恢复。仅当前和相邻视频挂载媒体源，长时间浏览限制卡片数量。
- 触摸拖动跟手，松手后用 160 毫秒动画归位；鼠标滚轮、触控板和方向键也使用相同速度，一次滑动手势只切一条，避免惯性连跳。启用系统「减少动态效果」时直接切换。
- 手机浏览器菜单可「添加到主屏幕」；独立窗口使用满屏布局，地址栏显隐时按动态视口和安全区域适配。普通 Safari 标签页的系统地址栏仍由浏览器控制。

## 域名部署与按需启停

```sh
cd /Users/zq/code/douyin-downloader
python3 video-web/deployment/install.py
```

安装器编译 `deployment/launchd-socket.c`，注册 `~/Library/LaunchAgents/com.zq.douyin-video.plist`，把 `deployment/douyin.caddy` 安装到 `~/homelab/configs/web/routes/`，然后调用 homelab 的 `reload-caddy` 校验并平滑重载。

launchd 保留监听 socket，访问域名时才启动 Node 进程。视频服务没有活动响应且 **20 分钟**没有访问后正常退出，下次请求再次唤醒。正在传输的媒体不会被空闲逻辑中断；可见页面每 30 秒发送一次保活，后台或关闭页面后停止保活。这里只管理观看服务，已有 `library-server:3001` 保持原来的运行方式。资料库需可访问，否则页面会显示重试提示。

检查状态和日志：

```sh
launchctl print gui/$(id -u)/com.zq.douyin-video
tail -n 30 video-web/deployment/launchd.log
tail -n 30 video-web/deployment/launchd-error.log
```

`deployment/acceptance.json` 记录使用临时 15 秒空闲配置完成的 HTTPS、Range、退出和再次唤醒验收。正式配置恢复为 1200000 毫秒。

## 验证

```sh
cd video-web
npm test
npm run check
```

测试覆盖：只读接口白名单、媒体 Range/HEAD 透传、资料库离线、空闲退出、页面保活、传输期间不退出、分页和收藏容错。服务只转发作品/作者读取和媒体请求，不开放下载更新、配置修改或删除接口。

实际浏览器验收（需要可选的 Playwright 和本机 Chrome；使用临时独立资料目录）：

```sh
cd /Users/zq/code/douyin-downloader
.venv/bin/python video-web/tests/browser_check.py
```

脚本访问已部署域名，检查 390×844 手机视口、视频实际播放、触摸上滑、暂停、收藏、声音、进度、搜索、作者浏览和电脑方向键切换。截图只写入 `/private/tmp/douyin-video-mobile.png` 与 `/private/tmp/douyin-video-desktop.png`，不把媒体内容提交到仓库；可用 `VIDEO_TEST_URL` 指定其他地址。
