# 常用编辑与制作配方

这里是工具参数示例，不是可以原样执行的脚本。把 `BACKGROUND_ID`、`LYRICS_ID`、`IMAGE_ID`、`VIDEO_ID` 换为本次工程或导入结果中的真实 ID；`expectedRevision` 使用最新返回值。需要未知参数时查 `visiki_catalog.operationFields`、`layers[].defaults` 和 `effects[].controls`，不要猜键名。

## 从素材制作一个新布局

1. 导入主音乐 `visiki_import_media({path:绝对路径,type:"audio"})`，再导入封面/背景 `{type:"image",role:"cover"}`、视频或字体。音频会影响时长，宜先导入。
2. `update_project` 设置需要的画布、帧率、曲名和歌手。直接设置宽高不会缩放旧布局；打算套模板时先设画布。
3. 歌词可用在线搜索/获取，或 `set_lyrics` 写本地已读取的 LRC/SRT / cues。不要为用户未指定的歌曲猜一个候选并替换配乐。
4. 先按 [design.md](design.md) 查看图片、确定主体与留白，再选择模板起点或手动排版。套用后按素材调整组件取舍、位置比例、配色和字幕层级，再读取新的图层 ID。每个组件仍可继续编辑。

当前模板 ID（运行时优先查目录）：

| 序号 | id | 主要构图 |
| --- | --- | --- |
| 01 | `vinyl-room` | 前景卡片、唱片及播放器 |
| 02 | `paper-poem` | 纯色留白、居中单句大字，无封面卡片 |
| 03 | `neon-night` | 全屏背景、底部单句字幕，无封面卡片 |
| 04 | `sunset-film` | 胶片全屏背景、侧边滚动歌词，无封面卡片 |
| 05 | `mist-forest` | 光束薄雾、居中双语歌词，无封面卡片 |
| 06 | `pulse-radio` | 小封面、居中歌词和心电曲线 |

03/04 可能继承旧工程已选中的视频背景。用户要求使用新图片时，套用后明确修改背景来源，不以素材库中存在图片为已设置成功的证据。

`visiki_apply_template` 的参数例如 `{"id":"sunset-film","keepCustomLayers":false,"expectedRevision":最近版本}`。仅当用户要求替换旧自定义文字/视频时才选 false；true 也不会保留其他原画面图层。

## 背景与图片

背景默认锁定。下面三项可放在同一次 `visiki_edit.operations` 中；若原本未锁定可省略第一项：

```json
[
  { "op": "update_layer", "id": "BACKGROUND_ID", "changes": { "locked": false } },
  {
    "op": "update_layer", "id": "BACKGROUND_ID",
    "changes": { "params": { "backgroundType": "image", "imageId": "IMAGE_ID", "followCover": false, "blur": 0, "brightness": 0.55 } }
  },
  { "op": "update_layer", "id": "BACKGROUND_ID", "changes": { "locked": true } }
]
```

`backgroundType` 也可为 `color` 或 `video`。视频背景设置 `videoId`、`playbackRate`、`reverse`、`videoLoop`；其时间线长度不会随速度改变。背景与卡片可引用不同 `imageId`；独立绑定时明确 `followCover:false`。

新增图片组件使用 `add_layer` 的 `layerType:"image"` 及 `params.imageId`。蒙版 `mask` 可选 `rectangle/rounded/circle/ellipse/diamond/hexagon`；阴影用 `shadow` 与 0–1 的 `shadowOpacity`。填充用 `fit:"cover"`，完整显示用 `"contain"`。

## 歌词与文字

```json
{
  "op": "set_lyrics",
  "originalLrc": "[00:00.00]第一句\n[00:03.00]第二句",
  "translatedLrc": "[00:00.00]First line\n[00:03.00]Second line",
  "offsetMs": 200
}
```

`lyrics:[{time,text,translation?,end?},...]` 与 `originalLrc` 二选一。`set_lyrics` 替换整个歌词数组；不会更改字体、曲名或歌手。省略 `offsetMs` 保留旧偏移，省略 `source` 清除旧来源。`visiki_get_lyrics({id,apply:true})` 会直接应用歌词，但不会自动更换音乐或曲目信息。

播放中与非当前状态参数独立。原文的 `fontId` 与译文的 `translationFontId` 也独立，字体 ID 应来自当前目录或导入结果。

```json
{
  "op": "update_layer", "id": "LYRICS_ID",
  "changes": {
    "width": 1100,
    "params": {
      "mode": "scroll", "lines": 3,
      "fontSize": 64, "inactiveFontSize": 42,
      "translationSize": 34, "inactiveTranslationSize": 28,
      "color": "#ffffff", "inactiveColor": "#aab0bb",
      "translationColor": "#e0e4eb", "inactiveTranslationColor": "#89909b",
      "activeOpacity": 1, "inactiveOpacity": 0.4,
      "lineGap": 22, "translationGap": 8,
      "glowEnabled": true, "glowColor": "#c3e8ff", "glowIntensity": 0.2, "glowRadius": 8
    }
  }
}
```

几何和字号应按当前画布选择。长行会按组件宽度自动缩小；字号看似没变时检查宽度和文本长度，避免只继续增大字号。`mode` 可选 `single`（原文单句）、`bilingual`（原译文单句）、`scroll`（多行滚动）。描边与阴影分别使用 `active*` / `inactive*` 参数，先查看当前层参数和目录。

歌词平面转向用 `planeYaw`（−75…75 度）及 `planePerspective`（0…300），不是斜体；关闭转面设 yaw=0。字号粗细用相应 `activeFontWeight` / `inactiveFontWeight` 及译文字重，斜体用相应 `*Italic`。普通文字是 `text` 图层的 `params.text/fontSize/fontWeight/italic`；曲名和歌手是工程 `title/artist`，由 `title` 图层显示。发光是这些文字图层的 `glow*` 参数，不是 `add_effect` 类型。

## 视频与时间线

假设素材至少有 8 秒，新增在工程第 12 秒出现的半速倒放片段：

```json
{
  "op": "add_layer", "layerType": "video",
  "changes": { "start": 12, "x": 960, "y": 540, "width": 1920, "height": 1080 },
  "params": { "videoId": "VIDEO_ID", "sourceIn": 2, "sourceOut": 8, "playbackRate": 0.5, "reverse": true, "fit": "stretch" }
}
```

这里的源区间长度 6 秒，半速后组件长 12 秒，终点自动计算为工程第 24 秒；没有必要同时指定 `end`。若显式指定，必须满足 `(end-start)=(sourceOut-sourceIn)/playbackRate`。

- 用 `split_video{id,at}` 切片，`at` 为工程时间，左右各留至少一帧；左段保留 ID，右段新建 ID。
- 用 `video_rate{id,rate}` 设置 0.1–8 倍速度，保留源区间并重算终点。背景视频不使用这个操作，直接改背景参数。
- 用 `move_layer{id,start}` 平移任意未锁定组件，保持长度，按工程帧吸附；必要时延长工程。
- 非等比变形使用视频 `fit:"stretch"` 并独立设置组件宽高。
- 视频素材的原声不进入混音；当前只有一条主配乐。

`move_layer` 不平移歌词的歌曲时间。歌词同步应调 `lyricsOffsetMs`，正数延后。缩短 `duration` 可能删掉区间外组件、裁剪交叠视频；延长工程不会自动把所有旧组件延长到末尾。

## 效果与音频包络

`add_effect` 追加效果并生成 ID。如果同用途效果已存在，应从工程读取完整效果栈，修改目标项后整体回传，保留其他效果；不要靠反复追加来更新。每层最多 8 项，参数和值域查目录。

没有主音轨 fade 时，可追加：

```json
{ "op": "add_effect", "targetId": "audio", "type": "fade", "params": { "fadeIn": 0.3, "fadeOut": 0.4, "curve": 0 } }
```

已有 fade 时，修改其参数后用 `update_project.changes.audioEffects` 回传完整数组。画面层的完整效果栈通过 `update_layer.changes.effects` 回传。多项 fade 会叠乘。音频包络按绝对歌曲时间 0 到 `min(音乐时长,工程时长)` 计算；仅截取前一秒并不意味着把歌曲淡出提前到一秒。

画面 fade 可设 `style`：0 透明度、1 上移、2 下移、3 左移、4 右移、5 缩放；`timing`：0 组件出入场、1 每句歌词。音频不使用 style/timing；逐句过渡不作用于多行滚动歌词。

`audio-reactive` 作用于画面图层，其 `band`：0 全频、1 低频、2 中频、3 高频、4 自定义 `lowHz/highHz`。例如给图片层加轻微呼吸：

```json
{ "op": "add_effect", "targetId": "IMAGE_LAYER_ID", "type": "audio-reactive", "strength": 1, "params": { "band": 1, "sensitivity": 1.5, "threshold": 0.08, "attack": 0.06, "release": 0.3, "scale": 0.05, "brightness": 0.08, "opacity": 0 } }
```

其他画面效果类型为 `color/film/rgb-split/glitch/crt`。它们的参数为数值，具有开关含义的字段也应按目录使用 0/1，不能随意改成布尔值。

## 预览与导出

`visiki_preview({time:0.5,width:1280,height:720})` 返回实际 PNG。根据用户选择的横竖比调整尺寸；超出约 4 MiB Base64 时降低预览尺寸，不改成片设置。

一次短片导出调用：

```json
{ "width": 1280, "height": 720, "fps": 24, "start": 0, "end": 1 }
```

这是 `visiki_export_start` 参数，不是 `visiki_edit` 操作。保存返回的 `jobId`，用 `visiki_export_status` 等待返回的 `state:"complete"`，再 `visiki_download_export({jobId,path:输出绝对路径})`。工程保存用 `visiki_save_project({path:工程绝对路径})`。输出父目录必须存在，默认不覆盖；仅在用户授权替换对应文件时使用 `overwrite:true`。任务完成才下载，不自行拼接下载 URL。
