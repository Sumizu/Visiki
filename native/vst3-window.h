#pragma once
#include <memory>
#include <string>
namespace Steinberg { class IPlugView; }
namespace visiki::vst3 {
// Create, show, pump, and destroy on the same thread.
class EditorWindow {
public:
    EditorWindow(Steinberg::IPlugView* view, const std::string& utf8Title);
    ~EditorWindow();
    EditorWindow(const EditorWindow&) = delete;
    EditorWindow& operator=(const EditorWindow&) = delete;
    void show();
    bool isOpen() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
void pumpEditorWindows();
}
