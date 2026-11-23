#pragma once

#include "dsp.h"
#include "vendor/json/json.hpp"
#include <functional>
#include <map>
#include <memory>
#include <string>

namespace visiki::vst3 {
// Call scanning in a disposable process: loading third-party modules is unsafe.
nlohmann::json scanModule(const std::string& utf8Path);
nlohmann::json inspectParameters(const nlohmann::json& job);
nlohmann::json parameterValues(dsp_detail::Processor& processor, const nlohmann::json& ids);
std::unique_ptr<dsp_detail::Processor> createProcessor(
    const std::string& utf8Path, const std::string& classId,
    const std::map<std::string, double>& params, double sampleRate,
    int maxBlock, bool offline, double bpm, double barBeats);
void configureProcessor(dsp_detail::Processor& processor,
    const std::map<std::string, double>& params, double bpm, double barBeats,
    std::uint64_t editsSeen);

using EditorCommit = std::function<std::uint64_t(const std::map<std::string, double>&)>;
// The real-time graph's control thread owns the controller and the editor.
bool openEditor(dsp_detail::Processor& processor, EditorCommit commit);
bool serviceEditor(dsp_detail::Processor& processor, bool flush = false);
void closeEditor(dsp_detail::Processor& processor);
}
