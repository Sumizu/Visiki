# 字体与字幕样式

内置十二款字体：原有七款中文字体，加上五款支持日语的字体。字体文件由本机服务提供，选择后无需联网或安装系统字体。歌词原文与译文可分别选择字体，文本框和曲目信息图层也各自独立；字号、颜色继续分别设置。

| 显示名称 | 类型 | 官方来源 | 许可 |
| --- | --- | --- | --- |
| 思源黑体 · Noto Sans SC | 无衬线 / 黑体，可变字重 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/notosanssc) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/notosanssc/OFL.txt) |
| 思源宋体 · Noto Serif SC | 衬线 / 宋体，可变字重 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/notoserifsc) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/notoserifsc/OFL.txt) |
| 霞鹜文楷 | 手写楷体 / Regular | [LXGW 官方项目](https://github.com/lxgw/LxgwWenKai) | [SIL OFL 1.1](https://github.com/lxgw/LxgwWenKai/blob/main/OFL.txt) |
| 站酷小薇体 | 宋体 / 文艺风格 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/zcoolxiaowei) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/zcoolxiaowei/OFL.txt) |
| 站酷快乐体 | 活泼手写 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/zcoolkuaile) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/zcoolkuaile/OFL.txt) |
| 马善政楷书 | 毛笔楷书 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/mashanzheng) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/mashanzheng/OFL.txt) |
| 龙藏行书 | 行书 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/longcang) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/longcang/OFL.txt) |
| Noto Sans JP · 日语黑体 | 日语无衬线，可变字重 100–900 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/notosansjp) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/notosansjp/OFL.txt) |
| Noto Serif JP · 日语明朝 | 日语明朝体，可变字重 200–900 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/notoserifjp) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/notoserifjp/OFL.txt) |
| Zen Maru Gothic · 日语圆体 | 圆润黑体 / Regular | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/zenmarugothic) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/zenmarugothic/OFL.txt) |
| Klee One · 日语手写 | 日语手写 / Regular | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/kleeone) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/kleeone/OFL.txt) |
| Yusei Magic · 日语手写 | 日语手写 / Regular | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/yuseimagic) | [SIL OFL 1.1](https://github.com/google/fonts/blob/main/ofl/yuseimagic/OFL.txt) |

SIL 官方 FAQ 明确允许将 OFL 字体用于视频字幕等设计工作，也允许随软件附带分发；发行字体时需要保留版权和许可。见 [官方使用说明](https://openfontlicense.org/ofl-faq/)。本项目保留下载原文件及完整许可，`public/fonts/sources.json` 记录固定提交、字体版本、文件字节数和 SHA256，构建复制到 `dist/fonts`。

日语字幕可以先试 Noto Sans JP 或 Noto Serif JP；圆润、手写风格可选择另外三款。五款均使用 Google Fonts 固定提交 `6c1dbe27dcf7d817d4b62cec033ba77fa8e2a5ec` 中的完整 TTF 原文件，核对官方 Git blob 与 SHA256，没有使用按句子裁剪的网络字体。验证包括解码全部字体表、84 个基本平假名（含浊音、半浊音、小假名和“ゔ”）、86 个基本片假名、日语标点及常用汉字歌词样本。各字体的全部 cmap 字符数、逐项验证范围与额外假名覆盖记录在 `sources.json`，实际字体的字符范围各不相同。

选中歌词图层，在右侧“原文字体”“译文字体”分别选择内置字体，或点击对应的“导入原文字体”“导入译文字体”；导入不会改变另一种文字的字体。文本框和曲目信息使用“文字字体”及“导入字体”。支持 TTF、OTF、WOFF、WOFF2。导入文件保存在 `.demo-data/fonts`，注册信息保存在 `.demo-data/fonts.json`；字体成功解码后才加入工程并应用。工程 JSON 中记录字体 ID，重新打开时自动加载。移动工程时需要一并保留该 Demo 的 `.demo-data`。自行导入字体的使用范围按原许可执行。

旧工程只有共同字体时，打开后将原先字体分别写入原文和译文设置，保留当时外观；首次修改其中一个不会改变另一个。单行模式不显示译文，也不要求加载未显示的译文字体。导出会等待实际显示的原文、译文、文本框和曲目信息字体就绪。

## 字重与斜体

歌词在“播放中歌词”“非当前歌词”样式页内，分别提供原文字重、译文字重、原文斜体和译文斜体。文本框提供字重和斜体；曲目信息提供主标题与副标题各自的字重、斜体。修改一项不会替换字体或改变另一组文字的设置。

字重范围 100–900，400 通常为常规，700 通常为粗体；滑块按 100 调整，也可用数值输入。Noto Sans SC／JP、Noto Serif SC／JP 等内置可变字体能显示细分粗细；导入完整 TTF／OTF 可变字体时也会读取实际字重轴，具体范围以字体支持的字重为准。只有单一字重或未识别出字重轴的字体可能只显示常规与合成粗体两档，需要纤细效果时可选择上述可变字体。没有独立斜体字形的字体使用合成倾斜；无需另外安装字体。

原有工程未调整时保留已有粗细和正体外观。新设置可撤销、保存及重新打开，预览和导出使用同一字体合成策略。合成策略参考 [CSS Fonts 字体合成说明](https://www.w3.org/TR/css-fonts-4/#propdef-font-synthesis)。

多行滚动可编辑“播放中歌词”和“非当前歌词”两套样式；非当前包含已播放与待播放。字号、颜色分别用于原文与译文，不透明度、描边和阴影用于整个歌词块；阴影还可调颜色、透明度、模糊、水平/垂直偏移。整体行距为相邻歌词块之间的净间隔，原译文间距为同一句的原文与译文之间的间隔。多行原文或多行译文按实际字号和行数参与排版。

两套样式独立保存。打开缺少非当前字号、颜色的旧工程时，按打开时的既有效果补齐初值；随后调整播放中歌词不会再带动非当前歌词变化。原文和译文也分别保持各自字号。

“双语两行”和“单行切换”有无动效、普通淡入淡出、上移、下移、缩放可选；时长范围 0.05–2 秒，同时用于淡入和淡出。短句会将每段时长收缩到句长一半，过渡不会跨过歌词结束时间或下一句起点。歌词偏移会同时作用于文字和动效。所有效果按绝对歌曲时间计算，暂停定位和逐帧导出调用同一个渲染器；导出会等待实际使用字体成功加载。
