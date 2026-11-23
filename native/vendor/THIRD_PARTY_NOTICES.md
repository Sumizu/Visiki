# Native audio dependencies

`native/dsp.h` contains Visiki's original C++17 built-in effects. The dependencies
supply audio I/O, serialization, metering and a host for user-installed VST3 effects.

| Dependency | Pinned source | License and retained notice |
| --- | --- | --- |
| miniaudio | 0.11.23 | Public domain (Unlicense) or MIT No Attribution, at the recipient's choice; full alternatives in `miniaudio/LICENSE` |
| nlohmann/json | 3.12.0 | MIT; copyright Niels Lohmann; `json/LICENSE.MIT` |
| libebur128 | v1.2.6 | MIT; copyright Jan Kokemüller; `libebur128/COPYING` |
| Steinberg VST3 SDK | v3.8.1_build_84 | MIT; copyright Steinberg Media Technologies GmbH. See `vst3sdk/LICENSE.txt` and the retained component notices. |
| BSD queue macros included with libebur128 | file distributed in libebur128 v1.2.6 | BSD-3-Clause; copyright 1991, 1993 The Regents of the University of California; full notice at the top of `libebur128/ebur128/queue/sys/queue.h` |

`sources.json` records exact download URLs and SHA256 hashes. The libebur128
archive checksum identifies the original pinned archive. The VST3 entry records
the SDK and submodule commits. The source build record hashes every retained
file. The portable copy helper includes the license notices and retained native
sources. Third-party VST3 plug-ins are installed by their users under their own licenses.

`VisikiAudioHost.exe` is compiled for Windows x64 with the static Microsoft C/C++
runtime (`/MT`). Building the host requires MSVC, the Windows SDK and CMake 3.25
or newer. The portable application uses the compiled host.
