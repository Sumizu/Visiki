#pragma once
// Included by dsp.h after Processor and the common DSP helpers are defined.
namespace dsp_detail {
class Convolution final : public Processor {
    using Complex = std::complex<float>;
    struct Kernel {
        int block = 128, fftSize, bins, partitions, samples;
        std::vector<int> reversed;
        std::vector<Complex> roots;
        std::array<std::vector<Complex>, 2> spectra;

        void fft(Complex* data, bool inverse) const {
            for (int i = 0; i < fftSize; ++i) {
                if (i < reversed[i]) std::swap(data[i], data[reversed[i]]);
                if (inverse) data[i] = std::conj(data[i]);
            }
            for (int length = 2; length <= fftSize; length <<= 1) {
                const int stride = fftSize / length, half = length / 2;
                for (int base = 0; base < fftSize; base += length) {
                    for (int j = 0; j < half; ++j) {
                        const auto u = data[base + j], v = data[base + j + half] * roots[j * stride];
                        data[base + j] = u + v;
                        data[base + j + half] = u - v;
                    }
                }
            }
            // The inverse caller only uses the real component.
            if (inverse) for (int i = 0; i < fftSize; ++i) data[i] /= static_cast<float>(fftSize);
        }

        Kernel(double rate, int space) {
            while (block < rate * 512 / 48000) block <<= 1;
            fftSize = block * 2;
            bins = block + 1;
            const double lengths[] = {.45, 1.0, 1.45, 2.1};
            samples = std::max(1, static_cast<int>(std::ceil(lengths[space] * rate)));
            partitions = (samples + block - 1) / block;
            reversed.resize(fftSize);
            for (int i = 1; i < fftSize; ++i) reversed[i] = (reversed[i >> 1] >> 1) | ((i & 1) * block);
            roots.resize(block);
            for (int k = 0; k < block; ++k) {
                const double angle = -2 * pi * k / fftSize;
                roots[k] = {static_cast<float>(std::cos(angle)), static_cast<float>(std::sin(angle))};
            }
            const double reflectionMs[][4] = {{4,9,17,25}, {12,23,37,59}, {3,7,11,19}, {19,39,61,84}};
            const double brightness[] = {4200, 5900, 10500, 7200};
            const double diffusionMs[] = {12, 35, 6, 54};
            std::vector<Complex> work(fftSize);
            for (int ch = 0; ch < 2; ++ch) {
                std::vector<float> impulse(samples);
                std::uint32_t rng = 0x9e3779b9u ^ (static_cast<std::uint32_t>(space) * 0x85ebca6bu)
                    ^ (static_cast<std::uint32_t>(ch) * 0xc2b2ae35u);
                double smooth = 0;
                const double decay = std::exp(-2 * pi * brightness[space] / rate);
                for (int i = 0; i < samples; ++i) {
                    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
                    const double noise = static_cast<double>(rng) / 2147483648.0 - 1;
                    smooth = decay * smooth + (1 - decay) * noise;
                    const double t = static_cast<double>(i) / samples;
                    const double rise = std::min(1.0, (i + 1) / (rate * diffusionMs[space] * .001));
                    impulse[i] = static_cast<float>(smooth * rise * std::exp(-5.5 * t) * (1 - t) / std::sqrt(rate * .01));
                }
                for (int tap = 0; tap < 4; ++tap) {
                    const double milliseconds = reflectionMs[space][tap] * (ch == 0 ? 1 : (tap % 2 ? .86 : 1.17));
                    const int index = static_cast<int>(std::round(milliseconds * .001 * rate));
                    if (index < samples) impulse[index] += static_cast<float>((tap % 2 ? -.12 : .17) / (1 + .35 * tap));
                }
                double energy = 0;
                for (float sample : impulse) energy += sample * sample;
                const float gain = static_cast<float>(.7 / std::sqrt(std::max(energy, 1e-30)));
                spectra[ch].resize(static_cast<std::size_t>(partitions) * bins);
                for (int p = 0; p < partitions; ++p) {
                    std::fill(work.begin(), work.end(), Complex{});
                    const int begin = p * block, count = std::min(block, samples - begin);
                    for (int i = 0; i < count; ++i) work[i] = {impulse[begin + i] * gain, 0};
                    fft(work.data(), false);
                    std::copy_n(work.data(), bins, spectra[ch].data() + static_cast<std::size_t>(p) * bins);
                }
            }
        }
    };

    static std::shared_ptr<const Kernel> getKernel(double rate, int space) {
        // Preparing graphs owns this cache. Processing never accesses it.
        using Key = std::pair<double, int>;
        using Entry = std::pair<Key, std::shared_ptr<const Kernel>>;
        static std::mutex mutex;
        static std::vector<Entry> cache;
        const Key key{rate, space};
        {
            std::lock_guard<std::mutex> lock(mutex);
            for (const auto& entry : cache) if (entry.first == key) return entry.second;
        }
        auto kernel = std::make_shared<const Kernel>(rate, space);
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto& entry : cache) if (entry.first == key) return entry.second;
        if (cache.size() == 8) cache.erase(cache.begin());
        cache.emplace_back(key, kernel);
        return kernel;
    }
    static int spaceFor(const EffectSpec& spec) { return static_cast<int>(param(spec, "space", 0, 0, 3)); }

    std::shared_ptr<const Kernel> kernel_;
    int space_, position_ = 0, historyPos_ = 0;
    double rate_;
    Slew mix_, output_, preDelay_;
    std::array<Biquad, 2> low_, high_;
    std::array<Ring, 2> pre_, dry_;
    std::array<std::vector<float>, 2> input_, ready_, overlap_;
    std::array<std::vector<Complex>, 2> history_;
    std::array<std::vector<std::uint8_t>, 2> activeHistory_;
    std::array<bool, 2> inputActive_{};
    std::vector<Complex> work_;

    void runBlock() {
        const int block = kernel_->block, bins = kernel_->bins, parts = kernel_->partitions;
        for (int ch = 0; ch < 2; ++ch) {
            auto* history = history_[ch].data();
            auto& active = activeHistory_[ch];
            active[historyPos_] = inputActive_[ch];
            if (inputActive_[ch]) {
                for (int i = 0; i < block; ++i) work_[i] = {input_[ch][i], 0};
                std::fill(work_.begin() + block, work_.end(), Complex{});
                kernel_->fft(work_.data(), false);
                std::copy_n(work_.data(), bins, history + static_cast<std::size_t>(historyPos_) * bins);
                inputActive_[ch] = false;
            }
            std::fill_n(work_.data(), bins, Complex{});
            bool hasSignal = false;
            int h = historyPos_;
            for (int p = 0; p < parts; ++p) {
                if (active[h]) {
                    const auto* signal = history + static_cast<std::size_t>(h) * bins;
                    const auto* ir = kernel_->spectra[ch].data() + static_cast<std::size_t>(p) * bins;
                    for (int k = 0; k < bins; ++k) work_[k] += signal[k] * ir[k];
                    hasSignal = true;
                }
                if (--h < 0) h = parts - 1;
            }
            if (hasSignal) {
                // Recover the conjugate half for the inverse transform of a real signal.
                for (int k = 1; k < block; ++k) work_[kernel_->fftSize - k] = std::conj(work_[k]);
                kernel_->fft(work_.data(), true);
            } else {
                std::fill(work_.begin(), work_.end(), Complex{});
            }
            for (int i = 0; i < block; ++i) {
                ready_[ch][i] = work_[i].real() + overlap_[ch][i];
                overlap_[ch][i] = work_[i + block].real();
            }
        }
        historyPos_ = (historyPos_ + 1) % parts;
    }

    void configureValues(const EffectSpec& spec, bool immediate) {
        setSlew(preDelay_, param(spec, "preDelayMs", 0, 0, 180) * .001 * rate_, rate_, 20, immediate);
        setSlew(mix_, param(spec, "mix", 25, 0, 100) * .01, rate_, 15, immediate);
        setSlew(output_, dbGain(param(spec, "outputDb", 0, -24, 12)), rate_, 15, immediate);
        for (int ch = 0; ch < 2; ++ch) {
            low_[ch].design(3, param(spec, "lowCutHz", 100, 20, 2000), .70710678, 0, rate_, immediate);
            high_[ch].design(4, param(spec, "highCutHz", 14000, 1000, 20000), .70710678, 0, rate_, immediate);
        }
    }
public:
    Convolution(const EffectSpec& spec, double rate)
        : kernel_(getKernel(rate, spaceFor(spec))), space_(spaceFor(spec)), rate_(rate), work_(kernel_->fftSize) {
        configureValues(spec, true);
        const int block = kernel_->block;
        for (int ch = 0; ch < 2; ++ch) {
            pre_[ch].prepare(static_cast<std::size_t>(std::ceil(rate * .18)) + 4);
            dry_[ch].prepare(block + 4);
            input_[ch].resize(block);
            ready_[ch].resize(block);
            overlap_[ch].resize(block);
            history_[ch].resize(static_cast<std::size_t>(kernel_->partitions) * kernel_->bins);
            activeHistory_[ch].resize(kernel_->partitions);
        }
    }

    bool configure(const EffectSpec& spec, double rate) {
        if (space_ != spaceFor(spec) || rate_ != rate) return false;
        configureValues(spec, false);
        return true;
    }

    void process(float* left, float* right, int frames) override {
        for (int i = 0; i < frames; ++i) {
            const double wet = mix_.next(), output = output_.next(), delay = preDelay_.next();
            const float in[] = {left[i], right[i]};
            float result[2];
            for (int ch = 0; ch < 2; ++ch) {
                // Each reverberant channel also hears a quieter reflection from the opposite side.
                pre_[ch].push(.80 * in[ch] + .20 * in[1 - ch]);
                dry_[ch].push(in[ch]);
                const float input = static_cast<float>(pre_[ch].read(delay + 1));
                input_[ch][position_] = input;
                inputActive_[ch] |= input != 0;
                const double dry = dry_[ch].read(kernel_->block + 1);
                const double filtered = high_[ch].tick(low_[ch].tick(ready_[ch][position_]));
                result[ch] = static_cast<float>((dry * (1 - wet) + filtered * wet) * output);
            }
            left[i] = result[0];
            right[i] = result[1];
            if (++position_ == kernel_->block) {
                position_ = 0;
                runBlock();
            }
        }
    }

    void reset() override {
        position_ = historyPos_ = 0;
        inputActive_.fill(false);
        for (int ch = 0; ch < 2; ++ch) {
            pre_[ch].reset();
            dry_[ch].reset();
            low_[ch].reset();
            high_[ch].reset();
            std::fill(ready_[ch].begin(), ready_[ch].end(), 0.0f);
            std::fill(overlap_[ch].begin(), overlap_[ch].end(), 0.0f);
            std::fill(activeHistory_[ch].begin(), activeHistory_[ch].end(), std::uint8_t{});
        }
        mix_.reset();
        output_.reset();
        preDelay_.reset();
    }

    int latency() const override { return kernel_->block; }
    std::int64_t tail() const override {
        return mix_.target > 0 ? kernel_->samples + static_cast<std::int64_t>(std::ceil(preDelay_.target)) : 0;
    }

    void inheritState(const Processor& source) override {
        const auto& old = static_cast<const Convolution&>(source);
        if (space_ != old.space_ || rate_ != old.rate_) return;
        position_ = old.position_;
        historyPos_ = old.historyPos_;
        pre_ = old.pre_;
        dry_ = old.dry_;
        input_ = old.input_;
        ready_ = old.ready_;
        overlap_ = old.overlap_;
        history_ = old.history_;
        activeHistory_ = old.activeHistory_;
        inputActive_ = old.inputActive_;
        inheritFilters(low_, old.low_);
        inheritFilters(high_, old.high_);
        inheritSlew(mix_, old.mix_);
        inheritSlew(output_, old.output_);
        inheritSlew(preDelay_, old.preDelay_);
    }
};
} // namespace dsp_detail
