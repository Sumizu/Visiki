# 从源码构建 Visiki

下列步骤适用于 Windows x64。想直接使用软件，可下载免安装预览版。 [GitHub Releases](https://github.com/Sumizu/Visiki/releases)

## 准备环境

- Node.js 24 和 npm。
- Visual Studio 2022 Build Tools，包含「使用 C++ 的桌面开发」、MSVC x64 编译器和 Windows SDK。
- CMake 3.25 或更新版本。可以使用 Build Tools 随附的 CMake，也可以把 CMake 加入 PATH。
- FFmpeg。把 `ffmpeg.exe` 所在目录加入 PATH，或在启动 Visiki 前设置 `FFMPEG_PATH` 为该文件的完整路径。MP4 导出需要支持 `libx264` 的构建。

## 安装、构建和启动

```powershell
git clone https://github.com/Sumizu/Visiki.git
cd Visiki
npm ci --legacy-peer-deps
npm run build
npm run desktop
```

第一次构建会编译 Windows 原生音频宿主，请等待完成。若只改了界面或本机服务，也可以运行 `npm run dev` 进入开发模式。

本地工程数据和导入素材默认保存在 `.demo-data`，在源码目录内。保存的工程引用这些素材。想用 MCP 或 Skill 时，请先启动应用，再按 [Agent 接入](agent-api.md) 和 [DAW MCP](daw-mcp.md) 配置。

## 验证改动

```powershell
npm run build
npm test
npm run test:native
```

先构建再运行测试，音频集成测试会用到已编译的原生宿主和 FFmpeg。部分 VST3 集成用例还需要安装对应的测试插件，设置方式见 [VST3 文档](daw-vst3.md)。
