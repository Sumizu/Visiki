# 连接Visiki

仅在缺少工具、切换安装位置或需要直接 HTTP 时读取。

## 已有 MCP 客户端

发现工具原名 `visiki_status`、`visiki_catalog`、`visiki_get_project` 等；服务器别名和工具前缀由客户端决定。调用 `visiki_status` 确认 `editorReady:true`。

skill 不安装软件或自动注册 MCP。用户已解压软件但尚未连接时，在已获授权的本地环境中：

1. 使用实际解压目录内的 `启动Visiki.cmd` 打开软件；没有安装路径信息时先查可用上下文，仍找不到再询问用户。
2. 运行该目录的 `生成MCP配置.cmd`，读取生成的 `MCP配置.json`。
3. 将其中的 `command`、`args`、`env` 按所用客户端格式配置为本地 stdio MCP 服务。生成器只写包内配置，不会替用户修改客户端设置。不要假设安装在 G 盘，也不要复制示例中的盘符。
4. 保留 `ELECTRON_RUN_AS_NODE=1`。配置使用包内 `runtime/electron/electron.exe` 和 `app/mcp/server.cjs`，无需另装 Node、npm 或 FFmpeg。

移动软件目录后需重新生成配置并更新客户端。不要双击 `启动MCP.cmd` 来打开编辑器；它是供 stdio 客户端调用的入口。不要因连不上就重装依赖、改系统 PATH、关闭沙箱或改为公网监听。

18 个工具按用途分组：

| 用途 | 工具 |
| --- | --- |
| 状态和目录 | `visiki_status`、`visiki_catalog`、`visiki_get_project` |
| 工程、编辑和历史 | `visiki_open_project`、`visiki_save_project`、`visiki_edit`、`visiki_apply_template`、`visiki_undo`、`visiki_redo` |
| 素材和歌词 | `visiki_import_media`、`visiki_search_lyrics`、`visiki_get_lyrics` |
| 检查 | `visiki_preview`、`visiki_seek` |
| 导出 | `visiki_export_start`、`visiki_export_status`、`visiki_export_cancel`、`visiki_download_export` |

工具参数以当前暴露的 schema 为准。MCP JSON 文本结果可能位于 `content[].text`；预览返回真正的 `image` 内容及文本元数据，不能把图片内容当作 JSON 工程。

## 只有本地 HTTP 工具时

HTTP 与 MCP 使用同一个编辑器。若当前 agent 只能使用 HTTP，可直接调用公开控制 API；不必伪造浏览器内部注册/轮询/结果回传接口。

从实际数据目录读取 `agent-endpoint.json`，通常为 `<软件目录>/app/.demo-data/agent-endpoint.json`，开发目录则是 `<项目>/demo/.demo-data/agent-endpoint.json`。自定义数据目录以实际位置为准。文件内容为 `{url,token,pid,version:1}`；重启后重新读取，不固定端口。不把令牌写进提示词、公开日志、成片或可分发工程。

所有控制请求添加 `Authorization: Bearer <token>`，只访问该文件给出的本机回环 HTTP 地址，不跟随跨站重定向。

| 请求 | 结果 |
| --- | --- |
| `GET /api/agent/status` | 直接返回连接状态 |
| `GET /api/agent/project` | `{id,result:{project,revision,time,playing,canUndo,canRedo}}` |
| `POST /api/agent/commands` | 请求 `{type,args?,expectedRevision?}`；返回 `{id,result}` |

MCP 工具和命令的对应关系：

| MCP | HTTP 命令 type / args |
| --- | --- |
| `visiki_catalog` | `catalog` / 无 |
| `visiki_edit` | `edit` / `{operations:[...]}` |
| `visiki_apply_template` | `apply_template` / `{id,keepCustomLayers?}` |
| 打开工程 | `replace_project` / `{project}`，先本地读取 JSON |
| `visiki_seek` | `seek` / `{time,playing?}` |
| `visiki_preview` | `preview` / `{time?,width?,height?}`，PNG Base64 位于 result.data |
| `visiki_export_start` | `start_export` / `{width?,height?,fps?,start?,end?}` |
| 查询/取消导出 | `get_export` / `cancel_export`，args 为 `{jobId}` |
| 撤销/重做 | `undo` / `redo`，无 args |

HTTP 素材上传为 `POST /api/import/audio|image|video|font`，multipart 字段名 `file`。拿到返回素材后再执行 `edit` 的 `attach_asset`。这与已经封装附加步骤的 `visiki_import_media` 不同。HTTP 搜索歌词为 `GET /api/lyrics/search?q=...&provider=netease`，获取歌词为 `GET /api/lyrics/song/:id?provider=netease`。

完成后按 `get_export` 给出的本机相对 `downloadUrl` 下载，只接受 `/api/export/<id>/download` 路由。控制任务 ID 与编码 ID 不一定相同，不自己拼下载 URL。HTTP 不替你保存工程文件或视频到指定路径，需由本地文件工具完成并处理覆盖约束。

401 检查令牌和发现文件；409 重新读取版本或检查编辑器连接；503 检查应用就绪、拖动状态和队列；504 先核实是否已执行。普通控制命令超时约 30 秒，MCP 普通等待 35 秒，导入和下载允许更长等待；不要通过无限增大超时掩盖失去连接。
