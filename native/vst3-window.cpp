#include "vst3-window.h"
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include <atomic>
#include <stdexcept>
#include <string>

namespace visiki::vst3 {
using namespace Steinberg;
namespace {
constexpr wchar_t kClass[] = L"VisikiVst3EditorWindow";
std::wstring titleToWide(const std::string& title) {
    if (title.empty()) return L"VST3 Editor";
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, title.data(), static_cast<int>(title.size()), nullptr, 0);
    if (!n) throw std::runtime_error("VST3 editor title is not valid UTF-8");
    std::wstring result(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, title.data(), static_cast<int>(title.size()), result.data(), n);
    return result;
}
UINT dpiFor(HWND hwnd) {
    using Fn = UINT (WINAPI*)(HWND);
    static auto fn = reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
    return fn ? fn(hwnd) : 96;
}
bool adjust(RECT& rect, DWORD style, DWORD ex, UINT dpi) {
    using Fn = BOOL (WINAPI*)(LPRECT, DWORD, BOOL, DWORD, UINT);
    static auto fn = reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "AdjustWindowRectExForDpi"));
    return fn ? fn(&rect, style, FALSE, ex, dpi) != FALSE : AdjustWindowRectEx(&rect, style, FALSE, ex) != FALSE;
}
}
struct EditorWindow::Impl {
    struct Frame final : IPlugFrame {
        explicit Frame(Impl* p) : owner(p) {}
        tresult PLUGIN_API queryInterface(const TUID iid, void** out) override {
            if (!out) return kInvalidArgument;
            *out = nullptr;
            if (FUnknownPrivate::iidEqual(iid, FUnknown::iid) || FUnknownPrivate::iidEqual(iid, IPlugFrame::iid)) {
                *out = static_cast<IPlugFrame*>(this); addRef(); return kResultOk;
            }
            return kNoInterface;
        }
        uint32 PLUGIN_API addRef() override { return ++refs; }
        uint32 PLUGIN_API release() override { auto n = --refs; if (!n) delete this; return n; }
        tresult PLUGIN_API resizeView(IPlugView* v, ViewRect* r) override {
            if (!owner || !r || v != owner->view || GetCurrentThreadId() != owner->thread) return kInvalidArgument;
            return owner->resize(*r);
        }
        std::atomic<uint32> refs{1};
        Impl* owner;
    };
    IPlugView* view = nullptr;
    Frame* frame = nullptr;
    HWND hwnd = nullptr;
    DWORD thread = GetCurrentThreadId();
    DWORD style = WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
    DWORD ex = WS_EX_APPWINDOW;
    bool attached = false, frameSet = false, resizing = false;

    Impl(IPlugView* input, const std::string& title) {
        if (!input) throw std::runtime_error("VST3 editor view is null");
        view = input; view->addRef();
        try {
            if (view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue)
                throw std::runtime_error("VST3 editor does not support native HWND views");
            auto caption = titleToWide(title);
            ViewRect size;
            if (view->getSize(&size) != kResultTrue || size.getWidth() <= 0 || size.getHeight() <= 0)
                throw std::runtime_error("VST3 editor returned an invalid initial size");
            if (view->canResize() == kResultTrue) style |= WS_THICKFRAME | WS_MAXIMIZEBOX;
            WNDCLASSEXW wc{}; wc.cbSize = sizeof(wc); wc.lpfnWndProc = proc;
            wc.hInstance = GetModuleHandleW(nullptr); wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512)); wc.lpszClassName = kClass;
            if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
                throw std::runtime_error("Could not register VST3 editor window class");
            RECT r{0, 0, size.getWidth(), size.getHeight()};
            if (!adjust(r, style, ex, 96)) throw std::runtime_error("Could not calculate VST3 editor window size");
            hwnd = CreateWindowExW(ex, kClass, caption.c_str(), style, CW_USEDEFAULT, CW_USEDEFAULT,
                r.right-r.left, r.bottom-r.top, nullptr, nullptr, wc.hInstance, this);
            if (!hwnd) throw std::runtime_error("Could not create VST3 editor window");
            frame = new Frame(this); frameSet = true;
            view->setFrame(frame);
            setScale(dpiFor(hwnd));
            if (view->getSize(&size) == kResultTrue && size.getWidth() > 0 && size.getHeight() > 0)
                setClientSize(size.getWidth(), size.getHeight());
            if (view->attached(hwnd, kPlatformTypeHWND) != kResultTrue)
                throw std::runtime_error("Could not attach VST3 editor to its native window");
            attached = true;
        } catch (...) { close(); throw; }
    }
    ~Impl() { close(); }
    void setScale(UINT dpi) {
        if (!view) return;
        IPlugViewContentScaleSupport* scale = nullptr;
        if (view->queryInterface(IPlugViewContentScaleSupport::iid, reinterpret_cast<void**>(&scale)) == kResultTrue && scale) {
            scale->setContentScaleFactor(static_cast<float>(dpi ? dpi : 96) / 96.f); scale->release();
        }
    }
    bool setClientSize(int width, int height) {
        if (!hwnd || width <= 0 || height <= 0) return false;
        RECT r{0, 0, width, height};
        return adjust(r, style, ex, dpiFor(hwnd)) && SetWindowPos(hwnd, nullptr, 0, 0, r.right-r.left, r.bottom-r.top,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE) != FALSE;
    }
    tresult resize(ViewRect r) {
        if (!hwnd || resizing || r.getWidth() <= 0 || r.getHeight() <= 0) return kResultFalse;
        ViewRect old;
        if (view->getSize(&old) != kResultTrue) return kResultFalse;
        if (old.getWidth() == r.getWidth() && old.getHeight() == r.getHeight()) return kResultTrue;
        resizing = true;
        tresult result = setClientSize(r.getWidth(), r.getHeight()) ? view->onSize(&r) : kResultFalse;
        resizing = false; return result;
    }
    void notifySize() {
        if (!attached || !view || resizing || !hwnd || IsIconic(hwnd)) return;
        RECT client{}; ViewRect old;
        if (!GetClientRect(hwnd, &client) || client.right <= 0 || client.bottom <= 0 || view->getSize(&old) != kResultTrue) return;
        if (old.getWidth() == client.right && old.getHeight() == client.bottom) return;
        ViewRect r(0, 0, client.right, client.bottom); resizing = true; view->onSize(&r); resizing = false;
    }
    void close() {
        if (frame) frame->owner = nullptr;
        if (view && attached) { attached = false; view->removed(); }
        if (view && frameSet) { frameSet = false; view->setFrame(nullptr); }
        if (hwnd) { HWND old = hwnd; hwnd = nullptr; DestroyWindow(old); }
        if (view) { view->release(); view = nullptr; }
        if (frame) { frame->release(); frame = nullptr; }
    }
    static LRESULT CALLBACK proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
        auto* self = reinterpret_cast<Impl*>(GetWindowLongPtrW(h, GWLP_USERDATA));
        if (msg == WM_NCCREATE) {
            self = static_cast<Impl*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
            SetWindowLongPtrW(h, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self)); self->hwnd = h;
        }
        if (!self) return DefWindowProcW(h, msg, wp, lp);
        switch (msg) {
        case WM_CLOSE: self->close(); return 0;
        case WM_NCDESTROY:
            SetWindowLongPtrW(h, GWLP_USERDATA, 0); if (self->hwnd == h) self->hwnd = nullptr; break;
        case WM_SIZE: self->notifySize(); break;
        case WM_SIZING: {
            if (!self->view || !self->attached || self->resizing) break;
            auto* r = reinterpret_cast<RECT*>(lp); RECT outer{}, client{};
            if (!GetWindowRect(h, &outer) || !GetClientRect(h, &client)) break;
            LONG ew = outer.right-outer.left-client.right, eh = outer.bottom-outer.top-client.bottom;
            ViewRect v(0, 0, r->right-r->left-ew, r->bottom-r->top-eh);
            self->view->checkSizeConstraint(&v);
            if (v.getWidth() <= 0 || v.getHeight() <= 0) break;
            LONG w = v.getWidth()+ew, ht = v.getHeight()+eh;
            if (wp == WMSZ_LEFT || wp == WMSZ_TOPLEFT || wp == WMSZ_BOTTOMLEFT) r->left = r->right-w;
            else r->right = r->left+w;
            if (wp == WMSZ_TOP || wp == WMSZ_TOPLEFT || wp == WMSZ_TOPRIGHT) r->top = r->bottom-ht;
            else r->bottom = r->top+ht;
            return TRUE;
        }
        case WM_SETFOCUS: if (self->view && self->attached) self->view->onFocus(true); break;
        case WM_KILLFOCUS: if (self->view && self->attached) self->view->onFocus(false); break;
        case WM_DPICHANGED: {
            auto* suggested = reinterpret_cast<RECT*>(lp); self->setScale(HIWORD(wp));
            if (!self->hwnd) return 0;
            RECT client{}; GetClientRect(h, &client); RECT outer{0, 0, client.right, client.bottom};
            if (adjust(outer, self->style, self->ex, HIWORD(wp))) {
                self->resizing = true;
                SetWindowPos(h, nullptr, suggested->left, suggested->top, outer.right-outer.left, outer.bottom-outer.top,
                    SWP_NOZORDER | SWP_NOACTIVATE);
                self->resizing = false;
            }
            return 0;
        }
        }
        return DefWindowProcW(h, msg, wp, lp);
    }
};
EditorWindow::EditorWindow(IPlugView* view, const std::string& title) : impl_(std::make_unique<Impl>(view, title)) {}
EditorWindow::~EditorWindow() = default;
void EditorWindow::show() {
    if (!impl_ || !impl_->hwnd) return;
    auto hwnd = impl_->hwnd;
    ShowWindow(hwnd, IsIconic(hwnd) ? SW_RESTORE : SW_SHOW);
    // The hidden audio process may override its first ShowWindow with SW_HIDE.
    if (!IsWindowVisible(hwnd)) SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_SHOWWINDOW | SWP_NOMOVE | SWP_NOSIZE);
    SetForegroundWindow(hwnd);
}
bool EditorWindow::isOpen() const { return impl_ && impl_->hwnd; }
void pumpEditorWindows() {
    MSG msg{};
    for (int n = 0; n < 100 && PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE); ++n) {
        if (msg.message == WM_QUIT) { PostQuitMessage(static_cast<int>(msg.wParam)); break; }
        TranslateMessage(&msg); DispatchMessageW(&msg);
    }
}
}

