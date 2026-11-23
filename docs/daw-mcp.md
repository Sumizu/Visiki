# Visiki DAW MCP

同一套 Visiki stdio MCP 提供剪辑工具 `visiki_*` 和 `visiki_daw_*` 音频工具。重新连接 MCP 可刷新工具列表。新的客户端可添加 [配置示例](../mcp/example-config.json)。用于指导 Agent 的 [Visiki DAW Skill](../skills/visiki-daw/SKILL.md) 可随完整 `skills/visiki-daw` 目录分发。

`visiki_daw_status` 的 `editorReady` 表示应用页面已连接。调用 `visiki_daw_activate` 可从欢迎页进入 DAW，并等会话恢复后取得快照。第一次使用剪辑工具前仍需进入剪辑工作区。

## 工具

表内工具均以 `visiki_daw_` 开头。参数的必填项、类型和范围可通过 MCP 的 `tools/list` 查看。

| 工具 | 对应操作 |
| --- | --- |
| `status`、`activate`、`catalog`、`get_session` | 连接、激活、查询功能与工程快照。指定 `effectType` 可读取某个内置效果的全部参数和预设。 |
| `scan_vst3` | 后台扫描本机 VST3。通过 `catalog({vst3:true})` 查看进度和结果。 |
| `new_session`、`open_session`、`save_session` | 新建、打开和保存本地 `.visiki-daw.json`。 |
| `list_assets`、`import_audio`、`attach_asset` | 查询本地音频、导入及复用素材。可新建轨道、插入指定轨道或仅加入当前会话的素材库。 |
| `edit`、`undo`、`redo` | 批量编辑音轨、片段、主输出、速度拍号和三类效果链。 |
| `transport`、`view`、`meters` | 播放和定位、试听音量、选区、标尺、吸附、自动返回、缩放及面板、读取和重置电平。 |
| `effect_presets`、`monitor_effect` | 管理个人预设和收藏、应用内置预设、开启等响度 A/B 与去噪移除声监听。 |
| `job_start`、`job_status`、`job_cancel`、`job_apply` | WAV 混音、节奏分析、自动混音、匹配 EQ、底噪学习和 A/B 响度测量。分析结果可单独应用。 |
| `preview`、`download_wav`、`send_to_editor` | WAV 片段试听、保存完整混音、将已导出的原始 WAV 设为当前剪辑主音轨。 |

轨道和效果插入位索引从 0 开始。效果目标是 `master`、轨道 ID 或 `clip:<clipId>`。轨道、片段、素材和效果各用其返回的标识。调用 `edit` 时，可在同一批引用前一项的输出，如 `$0.trackId` 和 `clip:$1.clipId`。

例如给一个已加入当前会话的音频创建轨道并添加 EQ。将 `assetId` 和 `expectedRevision` 替换为当前实际值。

```json
{
  "expectedRevision": 8,
  "operations": [
    {"op": "add_track", "name": "主唱"},
    {"op": "add_clip", "trackId": "$0.trackId", "assetId": "实际素材 ID", "start": 0},
    {"op": "add_effect", "target": "$0.trackId", "type": "eq", "presetId": "vocal-cleanup"}
  ]
}
```

一次成功的工程编辑批次对应一次撤销。提供上次快照的 `expectedRevision` 可以拒绝过期编辑。已有工程变化时，先读取并合并更新。若上传完成但附加失败，使用返回的 `importedAsset.id` 重试附加。会话文件保存素材引用，迁移工程时应保留 Visiki 的 DAW 素材库。

## VST3 插件

调用 `visiki_daw_scan_vst3` 启动扫描。轮询 `visiki_daw_catalog({vst3:true})`，等 `scanning` 为 false 后读取兼容插件。默认复用已扫描的模块，`force:true` 可重新检查。目录可用 `query` 搜索，用 `offset`、`limit` 分页。

在目录中传 `classId` 查询插件的默认参数，传 `effectId` 查询工程中的具体实例。每项带参数 ID、名称、归一化值和插件提供的显示值等信息。`includeChoices:true` 可列出最多 256 档的离散选项。效果链有多个同款插件时，用不同的 `effectId` 分别调整。

用 `visiki_daw_edit` 的 `add_vst3` 和 `update_effect` 操作插件。以下示例中的类 ID、轨道 ID 和参数 ID 应取自实际目录。

```json
{
  "operations": [
    {"op": "add_vst3", "classId": "实际 classId", "target": "实际轨道 ID"},
    {"op": "update_effect", "target": "实际轨道 ID", "effectId": "$0.effectId",
      "vst3Params": [{"paramId": 100, "format": "text", "value": "-3 dB"}]}
  ]
}
```

`vst3Params` 的 `format` 可用 `normalized`（0–1）、`plain`（插件的数值坐标，可选精确单位）、`text`（由插件解析的显示文字）或 `choice`（档位索引或唯一标签）。也可用 `params` 传入以参数 ID 为键的 0–1 数值映射。插件可写参数和实际换算以 SDK 查询结果为准。

包含参数更新的响应会返回 `vst3Readback`。 `ok` 表示读回值与工程一致并已进入音频处理，`pending` 常见于暂停、旁路或音频块尚未处理时。读回失败时工程批次可能已提交，先用 `get_session` 核对再重试。插件范围与原生窗口用法见 [VST3 试用](daw-vst3.md)。

## 分析、试听与交付

`job_start` 返回 `jobId`，查询到 `complete` 后读取 `result`。失败时返回 `error` 状态和 `message`。工程变化后须重新分析才可应用旧建议。自动混音需要不同的主唱轨和伴奏轨，和声轨可选。所选轨道须含有音频且未静音。应用时将原有轨道和主输出效果设为旁路，保留全部实例和片段效果。具体任务参数和工作流程见 [任务与试听](../skills/visiki-daw/references/jobs.md)。

`preview` 可渲染同一时段的原工程、仅推子平衡和完整自动混音方案，或试听参考音频的源范围。默认返回 WAV 音频块；不支持播放该音频块的客户端可指定本地 `.wav` 路径。需要匹配响度时，可用返回的 `lufs` 计算衰减，再用 `monitorTrimDb` 生成仅供试听的等响度片段。

导出使用 `job_start({kind:"render"})`。完成结果提供立体声 24-bit PCM WAV、综合响度、真峰值、超限采样数和尾音时长。下载用 `jobId` 或完成结果中的 `result.id` 作为 `renderId`。将该 `renderId` 发送到剪辑后，可在剪辑工作区撤销导入。下载、保存与试听文件写入默认保护同名文件。

## 本机 API

控制请求继续使用同一个发现文件和 Bearer 令牌。DAW 使用 `GET /api/agent/daw/status` 和 `POST /api/agent/daw/commands`，命令请求形如 `{type,args,expectedRevision}`。编辑和历史由打开的 DAW 处理。分析、渲染、素材读取复用本机 `/api/daw`。剪辑接口保持原路径。常规控制命令最长等待 30 秒，长任务通过任务 ID 管理。DAW 控制 JSON 请求和响应上限为 32 MiB，预览和 WAV 下载以流传输。详见 [Visiki MCP 通用配置](agent-api.md)。
