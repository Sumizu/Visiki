#pragma once
// Included by dsp.h after the delay and filter primitives.
namespace dsp_detail {
class Modulation final : public Processor {
    double rate_, phase_ = 0, syncStep_ = 0;
    int mode_, stages_, waveform_ = 0;
    bool sync_;
    double barBeats_;
    std::array<Ring, 2> delay_;
    std::array<std::array<double, 8>, 2> allpass_{};
    std::array<double, 2> previous_{};
    Slew speed_, depth_, mix_, phaseOffset_, feedback_, center_, time_, excursion_;

    double wave(double phase) const {
        const double value = std::sin(2 * pi * phase);
        if (waveform_ == 1) return 1 - 4 * std::abs(std::remainder(phase - .25, 1.));
        if (waveform_ == 2) return std::tanh(3 * value) / .9950547536867305;
        return value;
    }

public:
    Modulation(const EffectSpec& spec, double rate, double bpm, double barBeats)
        : rate_(rate), mode_(static_cast<int>(param(spec, "mode", 0, 0, 4))),
          stages_(4 + 2 * static_cast<int>(param(spec, "stages", 1, 0, 2))),
          sync_(param(spec, "sync", 0, 0, 1) > .5), barBeats_(barBeats) {
        if (mode_ == 0 || mode_ == 1 || mode_ == 4)
            for (auto& line : delay_) line.prepare(static_cast<std::size_t>(rate * .05) + 8);
        configure(spec, bpm, true);
    }

    void configure(const EffectSpec& spec, double bpm, bool immediate = false) {
        constexpr std::array<double, 15> beats{{.125,1.0/6,.1875,.25,1.0/3,.375,.5,2.0/3,.75,1,4.0/3,1.5,2,3,4}};
        const auto note = static_cast<std::size_t>(param(spec, "note", 9, 0, 15));
        const double hz = param(spec, "rateHz", .35, .05, 10);
        syncStep_ = bpm / (60 * (note == beats.size() ? 2 * barBeats_ : beats[note]) * rate_);
        waveform_ = static_cast<int>(param(spec, "waveform", 0, 0, 2));
        const double base = mode_ == 1 ? param(spec, "flangeMs", 3, .5, 8) : param(spec, "delayMs", 16, 8, 30);
        setSlew(speed_, hz / rate_, rate_, 20, immediate);
        setSlew(depth_, param(spec, "depth", 45, 0, 100) / 100, rate_, 20, immediate);
        setSlew(mix_, param(spec, "mix", 35, 0, 100) / 100, rate_, 15, immediate);
        setSlew(phaseOffset_, param(spec, "phaseDegrees", 90, 0, 180) / 360, rate_, 25, immediate);
        setSlew(feedback_, param(spec, "feedback", 20, -80, 80) / 100, rate_, 15, immediate);
        setSlew(center_, param(spec, "centerHz", 950, 150, 2500), rate_, 20, immediate);
        setSlew(time_, base * rate_ * .001, rate_, 25, immediate);
        setSlew(excursion_, param(spec, "vibratoMs", 2, 0, 5) * rate_ * .001, rate_, 25, immediate);
    }

    void setTimelineSample(std::int64_t sample) override {
        if (sync_) {
            phase_ = static_cast<double>(sample) * syncStep_;
            phase_ -= std::floor(phase_);
        }
    }

    void process(float* left, float* right, int count) override {
        for (int i = 0; i < count; ++i) {
            const double input[] = {left[i], right[i]};
            const double depth = depth_.next(), mix = mix_.next(), offset = phaseOffset_.next();
            const double speed = sync_ ? syncStep_ : speed_.next();
            const double feedback = feedback_.next(), center = center_.next(), time = time_.next();
            const double excursion = std::min(excursion_.next(), .10 / (2 * pi * speed));
            double output[2];
            for (int ch = 0; ch < 2; ++ch) {
                const double position = phase_ + ch * offset;
                const double lfo = mode_ == 3 ? wave(position) : std::sin(2 * pi * position);
                double wet = input[ch];
                if (mode_ == 3) {
                    wet *= 1 - depth * (.5 - .5 * lfo);
                } else if (mode_ == 2) {
                    const double hz = clamp(center * std::exp2(depth * lfo * 1.6), 30, rate_ * .42);
                    const double tan = std::tan(pi * hz / rate_);
                    const double coefficient = (tan - 1) / (tan + 1);
                    wet += std::clamp(previous_[ch] * feedback, -2., 2.);
                    for (int stage = 0; stage < stages_; ++stage) {
                        auto& state = allpass_[ch][stage];
                        const double filtered = coefficient * wet + state;
                        state = undenormal(wet - coefficient * filtered);
                        wet = filtered;
                    }
                    previous_[ch] = wet;
                } else {
                    const double applyDelay = mode_ == 4 ? 1 + excursion_.current + excursion * depth * lfo
                        : time * (1 + depth * lfo * (mode_ == 1 ? .82 : .28));
                    if (mode_ == 1) {
                        wet = delay_[ch].read(applyDelay);
                        delay_[ch].push(input[ch] + std::clamp(wet * feedback, -2., 2.));
                    } else {
                        delay_[ch].push(input[ch]);
                        wet = delay_[ch].read(applyDelay + 1);
                    }
                }
                output[ch] = input[ch] + mix * (wet - input[ch]);
            }
            left[i] = static_cast<float>(output[0]);
            right[i] = static_cast<float>(output[1]);
            phase_ += speed;
            phase_ -= std::floor(phase_);
        }
    }

    void reset() override {
        phase_ = 0;
        previous_ = {};
        allpass_ = {};
        for (auto& line : delay_) line.reset();
        for (auto* value : {&speed_, &depth_, &mix_, &phaseOffset_, &feedback_, &center_, &time_, &excursion_}) value->reset();
    }

    std::int64_t tail() const override {
        if (mix_.target == 0 || mode_ == 3) return 0;
        if (mode_ == 0) return static_cast<std::int64_t>(std::ceil(time_.target * 1.28));
        if (mode_ == 4) return static_cast<std::int64_t>(std::ceil(1 + 2 * excursion_.target));
        if (mode_ == 1) {
            const double feedback=std::abs(feedback_.target);
            const double repeats=feedback>0?1+std::ceil(std::log(.001)/std::log(feedback)):1;
            return static_cast<std::int64_t>(std::ceil(std::max(1.,time_.target*1.82)*repeats));
        }
        return static_cast<std::int64_t>(rate_ * .4);
    }

    void inheritState(const Processor& source) override {
        const auto& old = static_cast<const Modulation&>(source);
        if (mode_ != old.mode_ || stages_ != old.stages_ || sync_ != old.sync_) return;
        phase_ = old.phase_;
        delay_ = old.delay_;
        allpass_ = old.allpass_;
        previous_ = old.previous_;
    }
};
} // namespace dsp_detail
