# 工程与编辑

## 素材和时间

`visiki_daw_import_audio` 接收本地绝对 `path`，单文件非空且不超过 512 MiB，上传后附加到会话。`placement` 可为 `new_track`、`existing_track`、`library`，默认有 `trackId` 时为现有轨，否则为新轨。现有轨必须提供 `trackId`。仅入库时不要传 `trackId`、`start` 或 `name`。同时起始的分轨分别置于相同 `start`，已有工程则保留既有时间关系，不按静音段自动移动素材。

如返回 `importedAsset` 和附加失败，先读取工程确认状态，再用 `visiki_daw_attach_asset({assetId:已返回的ID,...})` 完成附加，避免重复上传。`visiki_daw_list_assets` 可查注册素材摘要。处理缺失素材时核对实际音频及来源后重新导入和重绑，勿伪造 ID。

时间单位为秒。片段 `start`、移动、裁剪和分割的 `time` 是工程时间线位置。`sourceIn` 表示音频文件内的源起点。节奏分析的 `start` 是素材源时间，针对片段时必须落在其 `sourceIn` 到 `sourceIn + duration` 的源范围。参考音频试听时间则从该参考素材或所选片段的开头计算。

## 编辑和保存

`visiki_daw_edit` 的 `operations` 是 1–256 项数组，扁平字段以 catalog 的 `operationFields` 和 `requiredFields` 为准。一个批次原子提交，形成一个撤销步骤，任一操作失败不提交。用返回的 `revision` 作 `expectedRevision`，冲突时重新读取并合并用户当前改动。超时先查工程确认是否已执行。批次中可用 `$0.trackId`、`$1.clipId`、`$2.effectId` 引用先前操作结果，片段效果目标可写 `clip:$1.clipId`。

例如在已注册素材上建轨、建片段：

```json
{"operations":[{"op":"add_track","name":"人声"},{"op":"add_clip","trackId":"$0.trackId","assetId":"实际素材ID","start":0}],"expectedRevision":12}
```

效果目标是 `master`、实际 trackId 或 `clip:<实际clipId>`。`add_effect` 返回 `effectId`，后续 `update_effect` 指定目标与该 ID，参数字段、范围和预设先查询 `visiki_daw_catalog({effectType:"实际类型"})`。例如按 catalog 选定类型后，`{"op":"add_effect","target":"实际轨道ID","type":"eq"}` 添加均衡器。用已有实例调整时保留其他处理，勿重复添加同用途效果。`visiki_daw_effect_presets` 可管理用户预设，`list` 可按 `effectType` 过滤，`apply` 需要 `target`、`effectId`、`presetId`。

`copy_effect` 插入单个副本，`copy_effect_chain` 整条替换目标链。`bypass_effect_chain` 保留参数和顺序，`effect_copy_ab` 把当前试听槽复制到另一槽。`sidechainTrackId` 用于回避效果，传 `null` 可清除触发源。

## VST3 参数编辑

1. 用 `visiki_daw_catalog({vst3:true})` 查询已有扫描结果。缺少目标插件时调用 `visiki_daw_scan_vst3`，轮询目录直到 `scanning` 为 false。用 `query` 搜索并用 `offset`、`limit` 翻页。
2. 用目录的 `classId` 查询插件参数，或用工程的 `effectId` 查询已挂载实例。按参数 ID 和分组辨认同名参数，离散选项用 `includeChoices:true` 查看。
3. 在 `visiki_daw_edit` 中使用 `add_vst3`，目标为轨道 ID 或 `master`。用 `update_effect` 和实例 ID 调节，或在 `add_vst3` 中直接提供同样的 `vst3Params`。每项包含 `paramId`、`format`、`value`。可用插件返回的 `normalized` 数值、`choice` 索引或标签、`text` 显示值，或 `plain` 数值和可选的精确 `unit`。
4. 查看 `vst3Readback` 与新 `revision`。暂停或旁路时可以保存参数，实时读回可能为 `pending`。读回异常时先查工程，再决定是否重试。涉及听感的任务用 `visiki_daw_preview` 试听实际混音。

## 撤销与工程文件

`visiki_daw_undo` 和 `visiki_daw_redo` 与人工操作共享历史，先核实将撤销的工作。`new_session` 和 `open_session` 会替换当前会话，注意用户当前未保存内容。`visiki_daw_save_session` 保存绝对路径 `.visiki-daw.json`，默认不覆盖，文件仅保存素材引用，不嵌入音频。迁移时保留对应 Visiki 素材数据，打开后检查 `missingAssets`，单独的工程 JSON 不保证跨机器可用。
