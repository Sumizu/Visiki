# VST3 音频效果试用

在 DAW 打开**效果库 → VST3**，点击「扫描 VST3」。从「效果目标」选轨道或主输出，再点插件的「添加」。点击效果链里的插件名称会打开厂商提供的 Windows 窗口，暂停时也可调节。插件没有可用的 Windows 窗口时，Visiki 显示通用参数面板，可调节插件定义的 0–1 归一化值。

原生窗口中的参数会实时作用于音频，完成一次调整后写入工程并记入撤销历史。保存会话和导出 WAV 前会同步窗口中的参数。关闭窗口可随时从同一效果槽再打开。

Agent 可用同一套 DAW MCP 搜索、挂载和调整兼容插件。参数按工程实例 ID 和插件参数 ID 定位，支持归一化数值及插件提供的单位和选项转换。详见 [DAW MCP 的 VST3 用法](daw-mcp.md#vst3-插件)。

## 扫描与工程

- 支持 Windows x64、主输入与主输出均为立体声的 Float32 音频效果。单声道素材仍可通过现有立体声混音链处理。
- 依次扫描用户的 `%LOCALAPPDATA%\Programs\Common\VST3`、系统的 `%CommonProgramFiles%\VST3` 和应用目录下的 `VST3`。通过厂商安装程序安装插件后，可再次扫描。
- 每个模块在独立进程中探测，结果缓存在本机。未变更的模块可复用扫描结果。「重新扫描全部」可重新尝试失败或超时的插件。「扫描问题」显示该模块的诊断。
- 工程保存插件 Class ID 和归一化参数。加载工程或导出时用登记的 Class ID 查找实际模块文件。插件失联时，效果槽和设置仍在工程里，重新扫描可恢复插件。需要跳过时可显式旁路。

## 处理范围

轨道效果和主输出在实时试听、片段试听导出和完整 WAV 渲染中使用同一套 SDK 处理节点。每个插槽有独立实例，导出从会话快照新建实例。首版支持插件启动时报告的延迟及尾音，尾音受 DAW 的 30 秒上限约束。

工程保存插件公开的参数。插件内部私有数据、片段插槽、外部侧链和运行时动态延迟或总线重配属后续接入范围。播放中增删、排序或旁路 VST3 可能有短暂停顿。

## 开发与测试

`native/build.ps1` 使用 MSVC 和 CMake 构建原有 `VisikiAudioHost.exe`。扫描模式在单独进程运行同一个可执行文件。Steinberg SDK 固定在 `v3.8.1_build_84`，授权和提交记录见 [原生依赖声明](../native/vendor/THIRD_PARTY_NOTICES.md)。

可在隔离数据目录中用环境变量 `VISIKI_VST3_SCAN_ROOTS` 指定测试扫描路径，Windows 上以分号分隔。运行原生服务测试时将 `VISIKI_VST3_TEST_AGAIN` 指向自行构建的官方 `again-sample-accurate.vst3`，即可验证轨道和主输出实例分别改变实际 WAV 采样。该插件来自 [Steinberg SDK 示例](https://github.com/steinbergmedia/vst3_public_sdk/tree/586dc5e6c8012c3e4b01c79389375cbe96bdb1da/samples/vst/again_sampleaccurate)。
