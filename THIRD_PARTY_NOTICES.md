# 第三方说明

本项目的运行依赖和开发依赖以 `package-lock.json` 中的版本为准。安装后可在相应依赖包中查阅原始 LICENSE/NOTICE。字体和原生依赖的许可随仓库保留。

| 内容 | 来源 / 许可 |
| --- | --- |
| React / React DOM | https://github.com/facebook/react · MIT |
| Lucide React 图标 | https://github.com/lucide-icons/lucide · ISC，部分 Feather 衍生内容另附 MIT |
| Express | https://github.com/expressjs/express · MIT |
| Multer | https://github.com/expressjs/multer · MIT |
| Electron | https://github.com/electron/electron · MIT；其 Chromium、Node 等内容另有第三方许可 |
| miniaudio 0.11.23 | https://github.com/mackron/miniaudio/tree/0.11.23 · Public Domain / MIT No Attribution 二选一；完整许可在 native/vendor/miniaudio/LICENSE |
| nlohmann/json 3.12.0 | https://github.com/nlohmann/json/tree/v3.12.0 · MIT；完整许可在 native/vendor/json/LICENSE.MIT |
| libebur128 v1.2.6 | https://github.com/jiixyj/libebur128/tree/v1.2.6 · MIT；完整许可在 native/vendor/libebur128/COPYING |
| Steinberg VST3 SDK 3.8.1 | https://github.com/steinbergmedia/vst3sdk · MIT；根目录及各组件许可在 native/vendor/vst3sdk |
| libebur128 附带的 BSD queue 宏 | 上述固定源码中的 ebur128/queue/sys/queue.h · BSD-3-Clause；该头文件保留完整版权和分发声明 |
| Vite | https://github.com/vitejs/vite · MIT |
| TypeScript | https://github.com/microsoft/TypeScript · Apache-2.0 |
| esbuild / tsx / concurrently | 各自 npm 包原始 LICENSE，版本由锁文件固定 |
| 歌词工作流研究 | https://github.com/jitwxs/163MusicLyrics · Apache-2.0；Visiki 的实现独立编写，固定提交与研究入口见 docs/lyrics-integration.md |
| Noto Sans SC | https://github.com/google/fonts/tree/main/ofl/notosanssc · SIL OFL 1.1；原始字体、版权与许可全文在 public/fonts/NotoSansSC-OFL.txt |
| Noto Serif SC | https://github.com/google/fonts/tree/main/ofl/notoserifsc · SIL OFL 1.1；原始字体、版权与许可全文在 public/fonts/NotoSerifSC-OFL.txt |
| 霞鹜文楷 / LXGW WenKai | https://github.com/lxgw/LxgwWenKai · SIL OFL 1.1；原始字体、版权与许可全文在 public/fonts/LXGWWenKai-Regular-OFL.txt |
| 站酷小薇体 / ZCOOL XiaoWei | https://github.com/google/fonts/tree/main/ofl/zcoolxiaowei · SIL OFL 1.1；许可全文在 public/fonts/ZCOOLXiaoWei-Regular-OFL.txt |
| 站酷快乐体 / ZCOOL KuaiLe | https://github.com/google/fonts/tree/main/ofl/zcoolkuaile · SIL OFL 1.1；许可全文在 public/fonts/ZCOOLKuaiLe-Regular-OFL.txt |
| 马善政楷书 / Ma Shan Zheng | https://github.com/google/fonts/tree/main/ofl/mashanzheng · SIL OFL 1.1；许可全文在 public/fonts/MaShanZheng-Regular-OFL.txt |
| 龙藏行书 / Long Cang | https://github.com/google/fonts/tree/main/ofl/longcang · SIL OFL 1.1；许可全文在 public/fonts/LongCang-Regular-OFL.txt |
| Noto Sans JP | https://github.com/google/fonts/tree/main/ofl/notosansjp · SIL OFL 1.1；版权与许可全文在 public/fonts/NotoSansJP-OFL.txt |
| Noto Serif JP | https://github.com/google/fonts/tree/main/ofl/notoserifjp · SIL OFL 1.1；版权与许可全文在 public/fonts/NotoSerifJP-OFL.txt |
| Zen Maru Gothic | https://github.com/google/fonts/tree/main/ofl/zenmarugothic · SIL OFL 1.1；版权与许可全文在 public/fonts/ZenMaruGothic-Regular-OFL.txt |
| Klee One | https://github.com/google/fonts/tree/main/ofl/kleeone · SIL OFL 1.1；版权与许可全文在 public/fonts/KleeOne-Regular-OFL.txt |
| Yusei Magic | https://github.com/google/fonts/tree/main/ofl/yuseimagic · SIL OFL 1.1；版权与许可全文在 public/fonts/YuseiMagic-Regular-OFL.txt |

音频演示为本项目用数学表达式生成；歌词为自写占位；默认封面、盘片和音频特效为本项目程序化绘制。默认示例使用项目自制的素材。

DAW 内置效果的 DSP 由 Visiki 实现。miniaudio 用于音频设备，nlohmann/json 用于控制消息，libebur128 用于响度与真峰值计量，Steinberg VST3 SDK 用于加载用户安装的兼容 VST3 效果。详见 [原生依赖声明](native/vendor/THIRD_PARTY_NOTICES.md)。

从源码运行时，Visiki 会调用 PATH 或 FFMPEG_PATH 指向的 FFmpeg 独立程序。便携版提供其所用 FFmpeg 的许可和对应源码，见 [预览发布页](https://github.com/Sumizu/Visiki/releases/tag/v0.1.0-preview.15)。用户导入的素材和在线取得的内容仍适用各自来源的权利。

内置字体直接使用官方完整字体文件，保留原内部字体名称；未改字形、未转换格式、未裁减字符。固定来源提交、版本与 SHA256 见 public/fonts/sources.json。字体可用于商业视频字幕；随软件分发时保留各字体版权声明及许可全文。用户自行导入字体的使用范围按该字体原许可执行。
