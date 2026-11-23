#pragma once
// Included from dsp.h after Processor and the DSP helpers have been defined.
namespace dsp_detail {
namespace denoise_detail {
constexpr int size = 2048, hop = 512, bins = size / 2 + 1, bands = 128;
using Complex = std::complex<double>;

// A fixed-size FFT plan has no allocation or locks on the audio thread.
struct Transform {
    std::array<int, size> reverse{};
    std::array<Complex, size / 2> roots{};
    std::array<double, size> window{};
    Transform() {
        for (int i = 1; i < size; ++i) reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) * (size / 2));
        for (int i = 0; i < size / 2; ++i) roots[i] = std::polar(1.0, -2 * pi * i / size);
        // Periodic sqrt-Hann: four overlapping window products sum to two.
        for (int i = 0; i < size; ++i) window[i] = std::sqrt(.5 - .5 * std::cos(2 * pi * i / size));
    }
    void fft(std::array<Complex, size>& data, bool inverse = false) const {
        if (inverse) for (auto& v : data) v = std::conj(v);
        for (int i = 0; i < size; ++i) if (i < reverse[i]) std::swap(data[i], data[reverse[i]]);
        for (int length = 2; length <= size; length <<= 1) {
            const int half = length / 2, stride = size / length;
            for (int base = 0; base < size; base += length) for (int j = 0; j < half; ++j) {
                const Complex u = data[base + j], v = data[base + j + half] * roots[j * stride];
                data[base + j] = u + v; data[base + j + half] = u - v;
            }
        }
        if (inverse) for (auto& v : data) v = std::conj(v) / double(size);
    }
};
inline double profileHz(int i) { return i == 0 ? 0 : 23.4375 * std::pow(24000.0 / 23.4375, (i - 1.0) / 126.0); }
inline double profileIndex(double hz) {
    if (hz <= 23.4375) return clamp(hz / 23.4375, 0, 1);
    return clamp(1 + 126 * std::log(hz / 23.4375) / std::log(24000.0 / 23.4375), 1, 127);
}
inline double powerAt(const std::array<double, bins>& power, double bin) {
    bin = clamp(bin, 0, bins - 1); const int i = static_cast<int>(bin), j = std::min(i + 1, bins - 1);
    return power[i] + (power[j] - power[i]) * (bin - i);
}
} // namespace denoise_detail

// Profile v1: 128 power levels in dB: index 0 is DC; 1..127 are logarithmic
// from 23.4375 Hz to 24000 Hz inclusive.
// Power is the stereo mean of |FFT(windowed signal)/2048|^2. Values above
// analysis Nyquist repeat its last available value. Frequencies above 24 kHz
// are left unprocessed; no profile or invalid profiles cause transparent output.
class DenoiseProfileAnalysis {
    denoise_detail::Transform transform_;
    std::array<std::array<double, denoise_detail::size>, 2> input_{};
    std::array<std::array<denoise_detail::Complex, denoise_detail::size>, 2> work_{};
    std::array<std::vector<double>, denoise_detail::bands> values_;
    double rate_, energy_ = 0;
    std::uint64_t samples_ = 0;
    int pos_ = 0, since_ = 0;
    void analyze() {
        using namespace denoise_detail;
        std::array<double, bins> power{};
        for (int ch = 0; ch < 2; ++ch) {
            for (int i = 0; i < size; ++i) work_[ch][i] = input_[ch][(pos_ + i) % size] * transform_.window[i];
            transform_.fft(work_[ch]);
        }
        for (int i = 0; i < bins; ++i) power[i] = (std::norm(work_[0][i]) + std::norm(work_[1][i])) / (2.0 * size * size);
        for (int i = 0; i < bands; ++i) values_[i].push_back(powerAt(power, profileHz(i) * size / rate_));
    }
public:
    explicit DenoiseProfileAnalysis(double rate) : rate_(std::isfinite(rate) && rate > 0 ? rate : 48000) {}
    void push(const float* left, const float* right, int n) {
        if (!left || !right || n <= 0) return;
        for (int i = 0; i < n; ++i) {
            const double l = clean(left[i]), r = clean(right[i]);
            input_[0][pos_] = l; input_[1][pos_] = r; energy_ += (l*l + r*r)*.5;
            if (++pos_ == denoise_detail::size) pos_ = 0;
            ++samples_;
            if (++since_ == denoise_detail::hop) {
                since_ = 0; if (samples_ >= denoise_detail::size) analyze();
            }
        }
    }
    std::vector<double> finish() {
        using namespace denoise_detail;
        if (samples_ < size || values_[0].empty() || energy_ / samples_ < 1e-12) return {};
        std::vector<double> result(bands);
        for (int i = 0; i < bands; ++i) {
            auto& values = values_[i]; const auto middle = values.begin() + values.size()/2;
            std::nth_element(values.begin(), middle, values.end());
            // Median limits contamination from short foreground events. The
            // factor compensates the median bias of stereo noise power.
            result[i] = 10 * std::log10(std::max(1e-18, *middle * 1.19));
        }
        return result;
    }
};

class DenoiseStage final : public Processor {
    using Complex = denoise_detail::Complex;
    static constexpr int N = denoise_detail::size, H = denoise_detail::hop, B = denoise_detail::bins;
    static constexpr int outputCapacity = 2 * N;
    denoise_detail::Transform transform_;
    std::array<std::array<double, N>, 2> input_{};
    std::array<std::array<double, outputCapacity>, 2> output_{};
    std::array<std::array<Complex, N>, 2> work_{};
    std::array<double, B> noise_{}, mask_{}, smoothed_{}, temporal_{}, power_{};
    std::array<double, denoise_detail::bands> profileCache_{};
    // Power history is fixed-size so processing remains allocation-free. At
    // common sample rates it spans at least 50 ms (up to 384 kHz).
    static constexpr int historyFrames = 64;
    using History = std::array<std::array<double, B>, historyFrames>;
    std::unique_ptr<History> history_;
    std::array<double, B> latePower_{};
    struct Notch { double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0; };
    struct NotchState { double z1 = 0, z2 = 0; };
    std::array<Notch, 8> notches_{};
    std::array<std::array<NotchState, 8>, 2> notchState_{};
    const int mode_;
    int historyPos_ = 0, delayFrames_ = 1, notchCount_ = 3;
    double humFrequency_ = 50, humQ_ = 24;
    double reverbDb_ = 8, reverbDecayMs_ = 550, reverbProtect_ = .65;
    bool cachedProfile_ = false;
    double rate_, reductionDb_ = 8, sensitivity_ = .5, transient_ = .6, low_ = 20, high_ = 24000;
    double reductionMeter_ = 0, previousEnergy_ = 0;
    int pos_ = 0, outPos_ = 0, hop_ = 0, smoothing_ = 1;
    bool validProfile_ = false;
    Slew humStrength_;
    void frame() {
        using namespace denoise_detail;
        for (int ch = 0; ch < 2; ++ch) {
            for (int i = 0; i < N; ++i) work_[ch][i] = input_[ch][(pos_ + i) % N] * transform_.window[i];
            transform_.fft(work_[ch]);
        }
        double energy = 0;
        for (int i = 0; i < B; ++i) {
            power_[i] = (std::norm(work_[0][i]) + std::norm(work_[1][i])) / (2.0*N*N);
            energy += power_[i];
        }
        const double change = previousEnergy_ > 1e-18 ? energy / previousEnergy_ : 1;
        const double protect = transient_ * clamp((change - 1.5) / 5.0, 0, 1);
        previousEnergy_ = previousEnergy_ == 0 ? energy : .8 * previousEnergy_ + .2 * energy;
        if (mode_ == 2) {
            // Delayed spectral power estimates the late reverberant field;
            // exponential decay carries energy through gaps between frames.
            // Stereo-linked gains retain the spatial image. This follows the
            // delayed power-spectrum approach of Lebart et al. (2001).
            const double decay = std::exp(-1000.0 * H / (rate_ * reverbDecayMs_));
            const double delayDecay = std::pow(decay, delayFrames_);
            const int delayed = (historyPos_ + historyFrames - delayFrames_) % historyFrames;
            const double protectOnset = reverbProtect_ * clamp((change - 1.15) / 3.0, 0, 1);
            for (int i = 0; i < B; ++i) {
                latePower_[i] = std::max(latePower_[i] * decay,
                    .35 * (*history_)[delayed][i] * delayDecay);
                (*history_)[historyPos_][i] = power_[i];
                // Soft Wiener-like attenuation rather than an on/off gate.
                // The steady-state floor preserves sustained notes and vowels.
                const double relativePower = latePower_[i] / std::max(1e-24, power_[i]);
                const double lateFraction = clamp((relativePower - .30) / .70, 0, 1);
                mask_[i] = lateFraction * (1 - protectOnset);
            }
            historyPos_ = (historyPos_ + 1) % historyFrames;
        } else {
            const double threshold = std::pow(2.0, (sensitivity_ - .5) * 3.0) * 1.75;
            for (int i = 0; i < B; ++i) {
                const double hz = i * rate_ / N;
                const double probability = validProfile_ && hz >= low_ && hz <= high_ && hz <= 24000
                    ? clamp(threshold * noise_[i] / std::max(1e-24, power_[i]), 0, 1) : 0;
                mask_[i] = probability * (1 - protect);
            }
        }
        const int passes = smoothing_ + 1;
        for (int pass = 0; pass < passes; ++pass) {
            smoothed_[0] = .75*mask_[0] + .25*mask_[1];
            for (int i = 1; i < B-1; ++i) smoothed_[i] = .25*mask_[i-1] + .5*mask_[i] + .25*mask_[i+1];
            smoothed_[B-1] = .75*mask_[B-1] + .25*mask_[B-2];
            mask_ = smoothed_;
        }
        double weighted = 0, total = 0;
        const double alpha = smoothing_ == 0 ? .35 : smoothing_ == 1 ? .6 : .8;
        for (int i = 0; i < B; ++i) {
            const double hz = i * rate_ / N;
            if (mode_ == 0 && (!validProfile_ || hz < low_ || hz > high_ || hz > 24000)) mask_[i] = 0;
            temporal_[i] = mask_[i] + alpha * (temporal_[i] - mask_[i]);
            const double gain = dbGain(-(mode_ == 2 ? reverbDb_ : reductionDb_) * temporal_[i]);
            weighted += power_[i] * gain * gain; total += power_[i];
            for (int ch = 0; ch < 2; ++ch) {
                work_[ch][i] *= gain;
                if (i > 0 && i < N/2) work_[ch][N-i] *= gain;
            }
        }
        reductionMeter_ = total > 1e-20 ? std::max(0.0, 10*std::log10(total / std::max(1e-24, weighted))) : 0;
        for (int ch = 0; ch < 2; ++ch) {
            transform_.fft(work_[ch], true);
            // Frame ended at the preceding sample. Synthesis starts at the
            // next output sample, exactly N samples after its input start.
            for (int i = 0; i < N; ++i) output_[ch][(outPos_ + 1 + i) % outputCapacity] += work_[ch][i].real() * transform_.window[i] * .5;
        }
    }
public:
    DenoiseStage(const EffectSpec& spec, double rate, int mode) : mode_(mode), rate_(rate) { humStrength_.init(1, rate_); configure(spec); reset(); }
    void configure(const EffectSpec& spec) {
        if (mode_ == 2 && !history_) history_ = std::make_unique<History>();
        humFrequency_ = static_cast<int>(param(spec, "humFrequency", 0, 0, 1)) == 1 ? 60 : 50;
        notchCount_ = static_cast<int>(param(spec, "humHarmonics", 3, 1, 8));
        humStrength_.target = param(spec, "humStrength", 100, 0, 100) * .01;
        humQ_ = param(spec, "humQ", 24, 12, 36);
        reverbDb_ = param(spec, "reverbReductionDb", 8, 0, 18);
        reverbDecayMs_ = param(spec, "reverbDecayMs", 550, 120, 1500);
        reverbProtect_ = param(spec, "reverbProtect", 65, 0, 100) * .01;
        delayFrames_ = std::max(1, std::min(historyFrames - 1, static_cast<int>(std::round(.05 * rate_ / H))));
        for (int j = 0; j < 8; ++j) {
            const double hz = humFrequency_ * (j + 1);
            if (j >= notchCount_ || hz >= rate_ * .5) { notches_[j] = {}; continue; }
            const double omega = 2 * pi * hz / rate_, c = std::cos(omega);
            const double alpha = std::sin(omega) / (2 * humQ_), a0 = 1 + alpha;
            notches_[j] = {1/a0, -2*c/a0, 1/a0, -2*c/a0, (1-alpha)/a0};
        }
        reductionDb_ = param(spec, "reductionDb", 8, 0, 24);
        sensitivity_ = param(spec, "sensitivity", 50, 0, 100) * .01;
        transient_ = param(spec, "transient", 60, 0, 100) * .01;
        smoothing_ = mode_ == 2 ? 1 : static_cast<int>(param(spec, "smoothing", 1, 0, 2));
        low_ = param(spec, "lowHz", 20, 20, 20000); high_ = param(spec, "highHz", 24000, 20, 24000);
        validProfile_ = spec.noiseProfile.size() == denoise_detail::bands;
        if (validProfile_) for (double v : spec.noiseProfile) if (!std::isfinite(v) || v < -180 || v > 40) { validProfile_ = false; break; }
        bool profileChanged = validProfile_ != cachedProfile_;
        if (validProfile_ && !profileChanged) for (int i = 0; i < denoise_detail::bands; ++i)
            if (profileCache_[i] != spec.noiseProfile[i]) { profileChanged = true; break; }
        if (profileChanged && validProfile_) for (int i = 0; i < denoise_detail::bands; ++i) profileCache_[i] = spec.noiseProfile[i];
        cachedProfile_ = validProfile_;
        if (profileChanged) for (int i = 0; i < B; ++i) {
            const double index = denoise_detail::profileIndex(i * rate_ / N);
            const int a = static_cast<int>(index), b = std::min(a+1, denoise_detail::bands-1);
            noise_[i] = validProfile_ ? std::pow(10.0, (spec.noiseProfile[a] + (spec.noiseProfile[b]-spec.noiseProfile[a])*(index-a)) / 10.0) : 0;
        }
    }
    void process(float* left, float* right, int n) override {
        if (mode_ == 1) {
            double removedEnergy = 0, inputEnergy = 0;
            for (int i = 0; i < n; ++i) {
                const double in[2] = {clean(left[i]), clean(right[i])};
                const double strength = humStrength_.next();
                double result[2];
                for (int ch = 0; ch < 2; ++ch) {
                    double filtered = in[ch];
                    for (int j = 0; j < notchCount_; ++j) {
                        const auto& c = notches_[j]; auto& st = notchState_[ch][j];
                        const double y = c.b0 * filtered + st.z1;
                        st.z1 = undenormal(c.b1 * filtered - c.a1 * y + st.z2);
                        st.z2 = undenormal(c.b2 * filtered - c.a2 * y);
                        filtered = y;
                    }
                    const double wet = in[ch] + (filtered - in[ch]) * strength;
                    result[ch] = wet;
                    inputEnergy += in[ch] * in[ch]; removedEnergy += wet * wet;
                }
                left[i] = static_cast<float>(result[0]); right[i] = static_cast<float>(result[1]);
            }
            reductionMeter_ = inputEnergy > 1e-20 ? std::max(0.0, 10 * std::log10(inputEnergy / std::max(1e-24, removedEnergy))) : 0;
            return;
        }
        for (int i = 0; i < n; ++i) {
            const double in[2] = {clean(left[i]), clean(right[i])}; double dry[2], wet[2];
            for (int ch = 0; ch < 2; ++ch) { dry[ch] = input_[ch][pos_]; input_[ch][pos_] = in[ch]; wet[ch] = output_[ch][outPos_]; output_[ch][outPos_] = 0; }
            if (++pos_ == N) pos_ = 0;
            if (++hop_ == H) { hop_ = 0; if(validProfile_ || mode_ == 2)frame(); }
            if (mode_ == 0 && !validProfile_) { wet[0]=dry[0];wet[1]=dry[1]; }
            left[i] = static_cast<float>(wet[0]); right[i] = static_cast<float>(wet[1]);
            if (++outPos_ == outputCapacity) outPos_ = 0;
        }
    }
    void reset() override {
        input_ = {}; output_ = {}; mask_ = {}; smoothed_ = {}; temporal_ = {}; power_ = {};
        if(history_)for(auto& frame:*history_)frame.fill(0);
        latePower_ = {}; notchState_ = {}; historyPos_ = 0;
        pos_ = outPos_ = hop_ = 0; reductionMeter_ = previousEnergy_ = 0; humStrength_.reset();
    }
    int latency() const override { return mode_ == 1 ? 0 : N; }
    std::int64_t tail() const override {
        if (mode_ == 1) return humStrength_.target > 0 ? static_cast<std::int64_t>(std::ceil(7 * humQ_ * rate_ / (pi * humFrequency_))) : 0;
        if (mode_ == 2) return reverbDb_ > 0 ? N : 0;
        return validProfile_ && reductionDb_ > 0 ? N : 0;
    }
    double reduction() const override { return (mode_ != 0 || validProfile_) ? reductionMeter_ : 0; }
    void inheritState(const Processor& source) override {
        const auto& old = static_cast<const DenoiseStage&>(source);
        if (mode_ != old.mode_) return;
        input_ = old.input_; output_ = old.output_; mask_ = old.mask_; smoothed_ = old.smoothed_; temporal_ = old.temporal_;
        pos_ = old.pos_; outPos_ = old.outPos_; hop_ = old.hop_;
        if (history_) *history_ = *old.history_;
        latePower_ = old.latePower_; historyPos_ = old.historyPos_;
        notchState_ = old.notchState_;
        previousEnergy_ = old.previousEnergy_; reductionMeter_ = old.reductionMeter_; inheritSlew(humStrength_, old.humStrength_);
    }
};

// Each optional switch falls back independently to the legacy exclusive mode.
struct DenoiseModes {
    bool spectral, hum, dereverb;
    bool operator==(const DenoiseModes& other) const {
        return spectral == other.spectral && hum == other.hum && dereverb == other.dereverb;
    }
};
inline DenoiseModes denoiseModes(const EffectSpec& spec) {
    const int mode = static_cast<int>(param(spec, "repairMode", 0, 0, 2));
    return {param(spec, "spectralEnabled", mode == 0 ? 1 : 0, 0, 1) > .5,
            param(spec, "humEnabled", mode == 1 ? 1 : 0, 0, 1) > .5,
            param(spec, "dereverbEnabled", mode == 2 ? 1 : 0, 0, 1) > .5};
}

// Mix and residual audition apply once to the entire series, using a dry
// signal delayed by the sum of the active stages' latencies.
class Denoise final : public Processor {
    static constexpr int maxDelay = 2 * denoise_detail::size;
    static constexpr int blockSize = 512;
    DenoiseModes modes_;
    std::array<std::unique_ptr<DenoiseStage>, 3> stages_;
    std::array<std::array<float, maxDelay>, 2> dry_{};
    int delay_ = 0, dryPos_ = 0;
    Slew mix_, listen_;
public:
    Denoise(const EffectSpec& spec, double rate) : modes_(denoiseModes(spec)) {
        mix_.init(1, rate); listen_.init(0, rate, 20);
        const bool active[] = {modes_.spectral, modes_.hum, modes_.dereverb};
        for (int i = 0; i < 3; ++i) if (active[i]) {
            stages_[i] = std::make_unique<DenoiseStage>(spec, rate, i);
            delay_ += stages_[i]->latency();
        }
        mix_.target = param(spec, "mix", 100, 0, 100) * .01;
        reset();
    }
    void configure(const EffectSpec& spec) {
        mix_.target = param(spec, "mix", 100, 0, 100) * .01;
        for (auto& stage : stages_) if (stage) stage->configure(spec);
    }
    void process(float* left, float* right, int n) override {
        std::array<float, blockSize> dryL{}, dryR{};
        for (int offset = 0; offset < n; offset += blockSize) {
            const int count = std::min(blockSize, n - offset);
            for (int i = 0; i < count; ++i) {
                const float l = static_cast<float>(clean(left[offset+i]));
                const float r = static_cast<float>(clean(right[offset+i]));
                if (delay_) {
                    dryL[i] = dry_[0][dryPos_]; dryR[i] = dry_[1][dryPos_];
                    dry_[0][dryPos_] = l; dry_[1][dryPos_] = r;
                    if (++dryPos_ == delay_) dryPos_ = 0;
                } else { dryL[i] = l; dryR[i] = r; }
            }
            for (auto& stage : stages_) if (stage) stage->process(left + offset, right + offset, count);
            for (int i = 0; i < count; ++i) {
                const double mix = mix_.next(), listen = listen_.next();
                const double wetL = clean(left[offset+i]), wetR = clean(right[offset+i]);
                const double normalL = dryL[i] + (wetL - dryL[i]) * mix;
                const double normalR = dryR[i] + (wetR - dryR[i]) * mix;
                left[offset+i] = static_cast<float>(normalL + listen * ((dryL[i] - wetL) * mix - normalL));
                right[offset+i] = static_cast<float>(normalR + listen * ((dryR[i] - wetR) * mix - normalR));
            }
        }
    }
    void reset() override {
        dry_ = {}; dryPos_ = 0; mix_.reset(); listen_.reset();
        for (auto& stage : stages_) if (stage) stage->reset();
    }
    void setListenRemoved(bool enabled) override { listen_.target = enabled ? 1 : 0; }
    int latency() const override { return delay_; }
    std::int64_t tail() const override {
        if (mix_.target <= 0) return 0;
        std::int64_t result = 0; for (const auto& stage : stages_) if (stage) result += stage->tail();
        return result;
    }
    double reduction() const override {
        double result = 0; for (const auto& stage : stages_) if (stage) result += stage->reduction();
        return result * mix_.current;
    }
    void inheritState(const Processor& source) override {
        const auto& old = static_cast<const Denoise&>(source);
        if (!(modes_ == old.modes_)) return;
        dry_ = old.dry_; dryPos_ = old.dryPos_;
        inheritSlew(mix_, old.mix_); inheritSlew(listen_, old.listen_);
        for (int i = 0; i < 3; ++i) if (stages_[i]) stages_[i]->inheritState(*old.stages_[i]);
    }
};
} // namespace dsp_detail
