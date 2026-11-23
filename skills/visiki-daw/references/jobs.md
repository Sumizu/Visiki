# 任务、试听和导出

## 后台任务

`visiki_daw_job_start` 按 `kind` 接受下列字段，每种任务只传其列出的字段及可选 `expectedRevision`。返回 `jobId` 后用 `visiki_daw_job_status({jobId})` 查询，直到 `state` 为 `complete`、`error` 或 `cancelled`。用 `job_cancel({jobId})` 停止任务。最多四个任务同时运行，最多保留 64 条记录。任务基于启动时的工程快照，工程变化后分析结果须重新运行才能应用或用于计划试听。

| kind | 允许字段与条件 |
| --- | --- |
| `render` | `includeTail` 可选布尔值，默认包含尾音。 |
| `rhythm` | `assetId`、`clipId` 二选一，`start`、`duration` 可选，分析源时间范围为 6–90 秒且不能超出素材或片段源范围。 |
| `auto_mix` | 可选 `options`，字段见下文。 |
| `match_eq` | 必填 `target`、`effectId`、`reference:{kind:"clip"或"asset",id}`，可选 `sourceTarget`。目标效果必须是 `eq`。 |
| `learn_noise` | 必填 `target`、`effectId`、`start`、`duration`。目标必须是已启用频谱模式的 `denoise`，时间线内选 0.5–3 秒纯底噪，片段效果还须在片段范围内。 |
| `compare` | 必填 `effectId`、`position`。效果须已启用、有 B 状态且不是电平表。 |

`auto_mix` 的 `options` 可选 `roles:{lead,backing,harmony?}`、`harmony:"support"|"duet"|"mixed"`、`direction:"blended"|"natural"|"forward"`、`genre:"none"|"pop"|"rock"|"acoustic"`、`space:"unchanged"|"room"|"plate"`、`spaceAmount` 0–100、`handoffs` 最多 64 个 `{start,end}`，每段至少 0.02 秒且在工程内、`delivery:{mode:"preserve"|"peak"|"custom",ceilingDb:-12至0,targetLufs:-36至-8}`、`excludedChangeIds` 最多 128 项。主唱和伴奏必须解析为两条不同的有效轨道。显式传入 `roles` 时，省略 `roles.harmony` 或将其设为 `null`、空字符串，均可只混主唱和伴奏。完全省略 `roles` 时会按轨道名尝试匹配。

应用已完成的分析使用 `visiki_daw_job_apply`，每种任务只传对应字段：`auto_mix` 可选 `mode:"balance"|"full"` 和最多 128 个有效 `changeIds`，默认 full 和全部可选项。`match_eq` 可选 `strength` 0–100，默认 60。`rhythm` 可选 `bpm` 20–300 和 `applyMeter`，默认不应用拍号。`learn_noise` 只需 `jobId`。`render`、`compare` 不可应用。应用时使用最新 `expectedRevision`，分析版本已变化则重新分析。

## 听取和交付

`visiki_daw_preview({start,end})` 渲染工程中的 0.02–20 秒，返回 WAV 音频内容和 `lufs`、`truePeak` 元数据。可提供绝对 `.wav` `path` 保存，默认不覆盖。大于 16 MiB 的内联音频需指定路径。要试听自动混音计划，传已完成的 `jobId` 与 `variant:"original"|"balance"|"full"`，可用 `changeIds` 选择计划中的变更。未指定 variant 时默认 original。与参考对照时使用 `reference:{kind:"clip"|"asset",id}`，单独试听参考的干声，`start/end` 从参考开头计算，不能同时传 `jobId`、`variant` 或 `changeIds`。选择同一音乐段和相近监听响度作比较。定向匹配均衡使用上面的 `match_eq` 任务，参考试听本身不会执行匹配。

工程试听默认遵循独奏与效果的监听选项。想检查导出的声音时传 `preview:false`。对同一区间做等响度对比，可先读取两个或多个版本的 `lufs`，取有效值中最低的作为基准，再以 `monitorTrimDb` 衰减其余版本。该字段接受 −60 到 0 dB，只作用于本次试听。响度未测得时换有代表性的片段。

导出使用 `job_start({kind:"render",includeTail:true})`，等 `complete` 后检查 `result` 的 `duration`、`sampleRate`、`channels`、`loudness.integrated`、`loudness.truePeak`、`clippedSamples`、`tailSeconds`，测量值可能为空。按用户所需尾音决定 `includeTail`，结尾有混响时试听实际尾部。用 `visiki_daw_download_wav({jobId,path})` 将完成任务写到存在的目录，或以 `renderId` 代替 `jobId`，两者只能传一个。路径须是本地绝对 `.wav` 路径，默认不覆盖。导出为立体声 24 位 PCM WAV，确认文件已写入并试听。若需要把同一导出送到视频编辑器，用完成结果中的 `result.id` 调用 `visiki_daw_send_to_editor({renderId})`，该操作会导入音频并切换到剪辑工作区。

发送混音会把当前剪辑工程的主音轨替换为这份 WAV，可在剪辑工作区撤销。按用户要求保存或发送。

超时或断线时先检查 `job_status`、当前工程与实际文件，避免重复启动或重复导入。停止等待工具响应后，已启动的后台任务仍需通过 `visiki_daw_job_cancel` 取消。重新打开应用后任务记录可能消失，重新读取状态。
