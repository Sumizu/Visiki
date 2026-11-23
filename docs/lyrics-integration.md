# 内置歌词获取工作流

Demo 在本地 Node 服务中实现「链接 / ID 解析，或歌名 / 歌手关键词搜索 → 候选选择 → 单曲详情 → 原文、译文、罗马音 LRC → 编辑器」流程。用户无需运行另一个程序或手动导出歌词文件。

## 研究来源与实现边界

研究日期：2026-10-31。检出的上游 `master` 提交：`26d8a73471ea88ab6d4c97406853391b2fadad19`。

- [163MusicLyrics 项目](https://github.com/jitwxs/163MusicLyrics)：[Apache-2.0 许可](https://github.com/jitwxs/163MusicLyrics/blob/26d8a73471ea88ab6d4c97406853391b2fadad19/LICENSE)，原作者版权说明为 Copyright 2017 jitwxs@foxmail.com。
- [GlobalUtils.cs](https://github.com/jitwxs/163MusicLyrics/blob/26d8a73471ea88ab6d4c97406853391b2fadad19/cross-platform/MusicLyricApp/Core/Utils/GlobalUtils.cs)：ID、来源与分享链接识别。
- [SearchService.cs](https://github.com/jitwxs/163MusicLyrics/blob/26d8a73471ea88ab6d4c97406853391b2fadad19/cross-platform/MusicLyricApp/Core/Service/SearchService.cs)：搜索候选与歌曲详情、歌词读取的组织流程。
- [NetEaseMusicNativeApi.cs](https://github.com/jitwxs/163MusicLyrics/blob/26d8a73471ea88ab6d4c97406853391b2fadad19/cross-platform/MusicLyricApp/Core/Service/Music/NetEaseMusicNativeApi.cs)：搜索请求、详情请求、歌词请求。
- [NetEaseMusicApi.cs](https://github.com/jitwxs/163MusicLyrics/blob/26d8a73471ea88ab6d4c97406853391b2fadad19/cross-platform/MusicLyricApp/Core/Service/Music/NetEaseMusicApi.cs)：分别读取 `lrc.lyric`、`tlyric.lyric` 和 `romalrc.lyric`。

本模块独立编写为 TypeScript，实现其用户工作流与响应字段转换。没有拷贝上游 C# 源码、WEAPI 加密常量、程序集或可执行文件；因此不是在 Electron 内嵌上游整个桌面程序。上游目前使用加密 WEAPI 请求；实际联机核验发现网易云自有域名的公开 GET 端点可直接返回这些字段，Demo 因而使用公开端点，不需要额外加密库。此说明也保留了上游作者、许可与固定提交的出处，便于后续审计。

## 在 Visiki 中使用

- `searchSongs(query, 'netease')` 返回最多 20 个 `{ id, title, artists, album, durationMs, coverUrl, provider }` 候选。
- `fetchSongLyrics(id, 'netease')` 返回歌曲信息，以及 `originalLrc / translatedLrc / romanizedLrc / sourceUrl / noLyrics`。
- 支持数字 ID、桌面 `#/song?id=` 链接、普通单曲链接、手机 `/m/song` 链接、分享菜单整段文字、`163cn.tv` 短链接。短链接最多 4 次跳转，每一步都验证官方域名；不请求任意用户 URL。
- 仅查询单曲文本和元数据，不请求试听或音频下载地址。不使用账号 Cookie，也不处理登录、付费、DRM 或地区限制的绕过。
- 原文、译文、罗马音保留为不同轨道，由编辑器按 LRC 时间戳组合。没有译文时为空字符串，不做虚构翻译。
- 本地服务代请求，避免浏览器跨域。搜索结果缺少封面时 `coverUrl` 为空；歌曲详情可提供封面。封面来源只接收网易云静态图域名。
- 当前 Demo 只启用网易云。类型保留 `qq` 便于后续扩展，但调用会明确返回未接入错误，不显示假数据。

端点：网易云自有域名 `https://music.163.com` 下 `/api/search/get`、`/api/song/detail`、`/api/song/lyric`。这些是实际网页服务使用的端点，不是承诺稳定性的开发者 API；提供商调整、登录要求与网络失败均显示为可重试的错误。HTTP 失败、服务拒绝、超时、响应格式变化不会被混为「无歌词」。真正的空歌词或纯音乐则通过 `noLyrics` 和说明反馈。
