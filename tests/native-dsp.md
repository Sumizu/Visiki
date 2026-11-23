# Native DSP fixture

Run from the project root with Visual Studio C++ Build Tools installed:

```powershell
powershell -ExecutionPolicy Bypass -File native/test-dsp.ps1
```

The C++17 fixture compiles the exact `native/dsp.h` used by the native preview
and offline renderer. It exercises audio behavior rather than matching source
strings. The executable returns nonzero on the first failed assertion and emits
one JSON result on success.

Coverage includes transparent empty and meter chains; EQ centre gain and
48 dB/oct rejection; compressor gain reduction and parallel dry mix; gate
closure/reopening; frequency-selective de-essing; impulse delay timing, BPM
synchronization and ping-pong feedback; FDN reverb tail decay; all three
waveshapers; oversampling latency alignment and reduction of measured harmonic
aliasing; stereo fold-down and polarity; limiter ceilings at 0/50/100% link;
RMS, correlation, left/right/anti-phase FFT analysis; per-effect readings;
bit-identical audio at block sizes 1 and 733; retained delay/reverb history on
parameter updates; meter-only resets that immediately clear all analyzer
readings while retaining bit-identical delay/reverb tails; and finite output
when an input contains NaN/infinity.
A scoped allocation counter also asserts that processing and reset allocate
zero memory. Configuration and graph replacement deliberately occur outside
that scope, on the host's producer/control thread. The current fixture contains
65 behavioral assertions. Reapplying an unchanged chain is also checked for
zero allocations, and changing another processor preserves untouched spatial
effect histories.

This is deterministic synthetic-signal coverage, not a claim of a listening
test, a standards certification, perceptual equivalence to another plug-in,
or a full professional audio conformance suite.

## Host contract

`visiki::EffectChain` accepts planar stereo float buffers. Call `prepare(rate,
maxBlock)` once, `setEffects(effects,bpm)` at a serialized block boundary, and
`process(left,right,frames)` for either preview or export. `process` handles
buffers larger than the configured maximum by chunking internally. The host
owns seek resets, graph transitions, track routing, gain automation, PDC and
safe snapshots across threads. None of these methods is concurrently reentrant.

`setEffects` retains histories for matching effect `id` and `type`; EQ/filter
coefficients and audio gains approach new targets, delay times glide, and FDN
size, feedback, predelay, damping, early-reflection mix and width are smoothed.
Changing limiter lookahead or saturation oversampling rebuilds their delay
structures; the host must apply a short graph fade when changing such structural
parameters or adding/removing/bypassing effects. `reset()` clears histories and
sets smoothing to the current parameter targets, allowing deterministic seeks.
`resetMeasurements()` resets only analyzer histories and published per-effect
readings. It preserves filter, dynamics, delay and reverb state and allocates
no memory, so resetting a meter does not interrupt audible tails.

`latencySamples()` sums actual limiter lookahead and oversampler delay. The
2x/4x saturator uses two windowed-sinc FIRs and has 16 samples of latency, with a
32-sample FIR tail. Other algorithms have no added dry-path latency. The delay
and reverb return a finite tail estimate through `tailSamples()`; the feedback
delay estimate follows repeats to approximately -60 dB, so high feedback and
slow tempo can legitimately request a very long tail. A host may impose an
explicit resource limit, which should be disclosed as an export policy.

`measurement()` returns the final chain's held sample peaks, 400 ms RMS and
correlation, crest factor, estimated K-weighted energy and a 128-band spectrum.
Spectrum bands are logarithmic from 20 Hz to Nyquist and contain **linear
amplitude**, so display code uses `20*log10(max(1e-6,value))` for dBFS.
`effectMeasurement()` reads the last explicit analyzer in the chain.
`effectMeasurements()` provides per-effect input/output block peak/RMS and GR.
`meterMeasurements()` returns each explicit analyzer's `id` and actual insertion
point measurement; `effectMeterMeasurement(id,result)` reads one without
allocation. `setMeterCallback(callback,user)` passes that node's untouched
stereo buffers, id and frame count synchronously to the host. The host can
feed a preconfigured libebur128 state for each analyzer from this hook, so a
track or pre-effect analyzer never incorrectly displays the master output's
loudness. Callback lifetime and synchronization are the host's responsibility.
The meter's `targetLufs` and `view` settings are display metadata; they never
normalize or otherwise alter the audio.

The native meter's K-weighted energy is deliberately **not labeled LUFS**.
The host uses its separate libebur128 state for LUFS, LRA and true-peak metering.
The limiter's contract is **sample peak** only: its preallocated monotonic
maximum window and lookahead constrain each channel's samples to the ceiling,
even with partially linked stereo. It does not claim true-peak limiting.

The eight-band EQ is a causal IIR processor. High/low cuts at 24/36/48 dB/oct
use cascaded Butterworth sections; 12 dB/oct uses the requested Q. Solo Bell
or Shelf bands audition a band-pass centred on their frequency. The reverb is
one normalized eight-line Hadamard FDN with input diffusion and early taps;
Room/Hall presets adjust this network and do not select separate algorithms.
Saturation modes are cubic soft clipping, Tanh and hard clipping. Oversampling
reduces aliasing and intentionally changes frequency response near Nyquist;
it is not advertised as alias-free.

The DSP implementation is original, uses only the C++ standard library and
does not embed third-party effect code. The host's vendored libebur128 retains
its own notices and license separately.
