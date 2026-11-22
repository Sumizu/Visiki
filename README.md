# Visiki

Visiki 是一款 Windows 音乐视频编辑器，也可以用来做多轨混音。导入歌曲和画面，排好歌词，再加上唱片、频谱或光影，就能导出自己的音乐视频。

## 能做什么

- **音乐视频剪辑**　把图片、视频、文字和特效放到时间线上。可以套用画面模板，也可以自己调整每个组件的位置和样式。
- **同步歌词**　导入歌词文件，或按歌名、链接搜索网易云歌词。支持滚动歌词、双语排版和独立的字体样式。
- **音轨编辑与混音**　剪切、调整和混合多条音轨，使用内置效果或兼容的 VST3 插件。只有主唱和伴奏也能自动混音，有和声时可以再选一轨。
- **导出与联动**　剪辑可导出 MP4，混音可导出 WAV，也可以直接送到剪辑工作区。支持本地 MCP，包内附有剪辑和混音两套 Skill。

## 开始使用

从 [Windows x64 预览版](https://github.com/Sumizu/Visiki/releases/tag/v0.1.0-preview.15) 下载 `Visiki-0.1.0-preview.15-win-x64.zip`。完整解压后，双击 `启动Visiki.cmd`，从欢迎页进入剪辑或 DAW。网易云歌词搜索需要联网。

如果要用 MCP，先打开 Visiki，再运行 `生成MCP配置.cmd`，按包内的《MCP接入说明》添加到你的客户端。

## 技术

桌面应用使用 Electron 和 React。视频由 FFmpeg 导出，音频效果由 C++ 音频引擎处理。

## 致谢

感谢 [163MusicLyrics](https://github.com/jitwxs/163MusicLyrics)、[LRC Scroller](https://github.com/qpbl173/lrc-scroller) 和 [Vizzy](https://vizzy.io/creations) 提供歌词与音乐可视化的参考，也感谢 [FFmpeg](https://ffmpeg.org/)、[Electron](https://www.electronjs.org/) 和 [miniaudio](https://miniaud.io/) 等开源项目。
