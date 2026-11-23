#pragma once
// Visiki native DSP. Original C++17 implementation; no external DSP dependencies.
// Configuration, allocation and graph replacement belong on the control thread.
// Built-in process() and reset() allocate no memory and take no locks.
// The graph uses planar stereo float for offline and live audio.
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace visiki {
struct EffectSpec {
    std::string id;
    std::string type;
    bool enabled = true;
    std::map<std::string, double> params;
    std::vector<double> noiseProfile;
    std::string sidechainTrackId;
    std::string vst3ClassId;
    std::string vst3ModulePath;
    std::uint64_t vst3EditsSeen = 0;
};

// K-weighted energy is an estimate, deliberately NOT named LUFS. The host's
// libebur128 meter supplies standards-validated loudness and true-peak readings.
struct DspMeasurement {
    double peakLeft = 0, peakRight = 0;
    double rmsLeft = 0, rmsRight = 0;
    double crestDb = 0, correlation = 0, kWeightedDb = -120;
    double gainReductionDb = 0;
    std::array<float, 128> spectrum{}; // log-spaced 20 Hz .. Nyquist, linear amplitude
    std::uint64_t samples = 0;
};
struct EffectMeasurement {
    std::string id;
    double inputPeak = 0, outputPeak = 0, inputRms = 0, outputRms = 0, gainReductionDb = 0;
    std::array<double,8> bandReductionDb{};
    std::array<double,3> multibandReductionDb{};
    double transientGainDb = 0, sidechainInputDb = -120, duckerKeyDb = -120, duckerProgramDb = -120;
    bool hasBandReduction = false, hasTransientGain = false, hasMultibandReduction = false, hasSidechain = false, hasDuckerBalance = false;
};
struct EffectMeterMeasurement {std::string id;DspMeasurement measurement;};

namespace dsp_detail {
constexpr double pi = 3.1415926535897932384626433832795;
inline double clamp(double v, double lo, double hi) { return std::max(lo, std::min(hi, v)); }
inline double dbGain(double db) { return std::pow(10.0, clamp(db, -180, 60) / 20.0); }
inline double gainDb(double v) { return 20.0 * std::log10(std::max(1e-12, std::abs(v))); }
inline double param(const EffectSpec& s, const std::string& key, double fallback,
                    double lo = -1e12, double hi = 1e12) {
    const auto it = s.params.find(key);
    return it == s.params.end() || !std::isfinite(it->second) ? fallback : clamp(it->second, lo, hi);
}
inline double coeffMs(double ms, double rate) { return std::exp(-1.0 / (std::max(.01, ms) * .001 * rate)); }
inline float clean(float x) { return std::isfinite(x) ? x : 0.f; }
inline double undenormal(double x) { return std::abs(x) < 1e-25 ? 0.0 : x; }

struct Slew {
    double current = 1, target = 1, coefficient = 0;
    void init(double value, double rate, double milliseconds = 15) {
        current = target = value; coefficient = coeffMs(milliseconds, rate);
    }
    double next() { current = target + coefficient * (current - target); return current; }
    void reset(){current=target;}
};
inline void inheritSlew(Slew& to,const Slew& from){to.current=from.current;}
inline void setSlew(Slew& slew,double value,double rate,double milliseconds,bool immediate){
    if(immediate)slew.init(value,rate,milliseconds);else slew.target=value;
}

// RBJ-form transposed direct-form II; coefficient targets can be smoothly moved.
struct Biquad {
    std::array<double, 5> c{{1, 0, 0, 0, 0}}, target{{1, 0, 0, 0, 0}};
    double z1 = 0, z2 = 0, slew = 0;
    void reset() { z1 = z2 = 0; c = target; }
    void design(int type, double hz, double q, double gain, double rate, bool immediate = true) {
        hz = clamp(hz, 5, rate * .475); q = clamp(q, .1, 18);
        const double w = 2 * pi * hz / rate, cs = std::cos(w), sn = std::sin(w);
        const double alpha = sn / (2 * q), a = std::pow(10.0, gain / 40.0);
        double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
        switch (type) {
        case 0: b0=1+alpha*a; b1=-2*cs; b2=1-alpha*a; a0=1+alpha/a; a1=-2*cs; a2=1-alpha/a; break;
        case 1: {
            const double t = 2 * std::sqrt(a) * alpha;
            b0=a*((a+1)-(a-1)*cs+t); b1=2*a*((a-1)-(a+1)*cs); b2=a*((a+1)-(a-1)*cs-t);
            a0=(a+1)+(a-1)*cs+t; a1=-2*((a-1)+(a+1)*cs); a2=(a+1)+(a-1)*cs-t; break;
        }
        case 2: {
            const double t = 2 * std::sqrt(a) * alpha;
            b0=a*((a+1)+(a-1)*cs+t); b1=-2*a*((a-1)+(a+1)*cs); b2=a*((a+1)+(a-1)*cs-t);
            a0=(a+1)-(a-1)*cs+t; a1=2*((a-1)-(a+1)*cs); a2=(a+1)-(a-1)*cs-t; break;
        }
        case 3: b0=(1+cs)/2; b1=-(1+cs); b2=(1+cs)/2; a0=1+alpha; a1=-2*cs; a2=1-alpha; break;
        case 4: b0=(1-cs)/2; b1=1-cs; b2=(1-cs)/2; a0=1+alpha; a1=-2*cs; a2=1-alpha; break;
        case 5: b0=1; b1=-2*cs; b2=1; a0=1+alpha; a1=-2*cs; a2=1-alpha; break;
        case 6: b0=alpha; b1=0; b2=-alpha; a0=1+alpha; a1=-2*cs; a2=1-alpha; break;
        }
        target = {{b0/a0, b1/a0, b2/a0, a1/a0, a2/a0}};
        if (immediate) c = target;
        slew = coeffMs(20, rate);
    }
    double tick(double x) {
        for (int i=0; i<5; ++i) c[i] = target[i] + slew*(c[i]-target[i]);
        const double y=c[0]*x+z1;
        z1=undenormal(c[1]*x-c[3]*y+z2); z2=undenormal(c[2]*x-c[4]*y);
        return y;
    }
};
inline void inheritFilter(Biquad& to,const Biquad& from){to.c=from.c;to.z1=from.z1;to.z2=from.z2;}
template<std::size_t N> inline void inheritFilters(std::array<Biquad,N>& to,const std::array<Biquad,N>& from){for(std::size_t i=0;i<N;++i)inheritFilter(to[i],from[i]);}

template<class Sample> struct SampleRing {
    std::vector<Sample> data;
    std::size_t cursor = 0;
    void prepare(std::size_t capacity) { data.assign(std::max<std::size_t>(4, capacity), Sample{}); cursor = 0; }
    void reset() { std::fill(data.begin(), data.end(), Sample{}); cursor=0; }
    void push(double v) { data[cursor] = static_cast<Sample>(undenormal(v)); if (++cursor == data.size()) cursor=0; }
    // Delay is measured relative to the next write: read(1) returns the last push.
    double read(double delay) const {
        delay=clamp(delay,1,static_cast<double>(data.size()-2));
        double pos=static_cast<double>(cursor)-delay;
        if (pos<0) pos+=static_cast<double>(data.size());
        const auto i=static_cast<std::size_t>(pos); const auto j=(i+1)%data.size();
        return data[i]+(data[j]-data[i])*(pos-static_cast<double>(i));
    }
};
using Ring = SampleRing<double>;

class Processor {
public:
    virtual ~Processor() = default;
    virtual void process(float* left, float* right, int frames) = 0;
    virtual void reset() = 0;
    virtual int latency() const { return 0; }
    virtual std::int64_t tail() const { return 0; }
    virtual void setTimelineSample(std::int64_t) {}
    virtual void setListenRemoved(bool) {}
    virtual double reduction() const { return 0; }
    virtual void measureGain(EffectMeasurement& measure) const { measure.gainReductionDb=reduction(); }
    virtual void inheritState(const Processor&) = 0;
};

class Equalizer final : public Processor {
    struct Band {
        bool enabled=false, dynamic=false;
        int sections=1, type=0, untilUpdate=0, hold=0, holdSamples=0;
        double hz=0, q=0, staticGain=0, threshold=-30, range=0, attack=0, release=0;
        double peak=0, attenuation=0, applied=0, aimed=0;
        std::array<std::array<Biquad,4>,2> filters;
        std::array<Biquad,2> detector;
    };
    std::array<Band,8> bands_;
    std::array<std::array<Biquad,6>,2> matchFilters_;
    bool matchRunning_=false, soloing_=false;
    Slew input_, output_;
    double rate_, detectorDecay_, filterSlew_;
    int controlPeriod_;
    bool hasDynamics_=false;
    void detect(Band& band,const double (&signal)[2]) {
        const double level=std::max(std::abs(band.detector[0].tick(signal[0])),std::abs(band.detector[1].tick(signal[1])));
        if(level>=band.peak){band.peak=level;band.hold=band.holdSamples;}
        else if(band.hold>0)--band.hold;
        else band.peak=undenormal(band.peak*detectorDecay_);
        if(--band.untilUpdate<=0){
            band.untilUpdate=controlPeriod_;
            const double desired=clamp((gainDb(band.peak)-band.threshold)*.5,0,band.range);
            const double coeff=desired>band.attenuation?band.attack:band.release;
            band.attenuation=desired+coeff*(band.attenuation-desired);
            if(desired==0&&band.attenuation<.005)band.attenuation=0;
        }
        tune(band,band.attenuation);
    }
    void tune(Band& band,double attenuation) {
        if(std::abs(attenuation-band.aimed)>.005||(attenuation==0&&band.aimed!=0)){
            auto& left=band.filters[0][0];auto& right=band.filters[1][0];
            left.design(band.type,band.hz,band.q,band.staticGain-attenuation,rate_,false);
            right.target=left.target;left.slew=right.slew=filterSlew_;
            band.aimed=attenuation;
        }
        band.applied=band.aimed+band.filters[0][0].slew*(band.applied-band.aimed);
    }
public:
    Equalizer(const EffectSpec& s, double rate):rate_(rate),detectorDecay_(coeffMs(12,rate)),filterSlew_(coeffMs(.5,rate)),controlPeriod_(std::max(1,static_cast<int>(rate*.00025))) {
        input_.init(dbGain(param(s,"inputDb",0,-24,24)),rate);
        output_.init(dbGain(param(s,"outputDb",0,-24,24)),rate);
        const int solo=static_cast<int>(param(s,"soloBand",0,0,8));
        soloing_=solo!=0;
        const double matchStrength=param(s,"matchStrength",0,0,100)*.01;
        const std::array<double,6> matchFrequencies{{125,250,500,1000,2500,6300}};
        for(std::size_t i=0;i<matchFrequencies.size();++i){
            const double hz=matchFrequencies[i];
            const double gain=hz>=rate*.475?0:matchStrength*param(s,"matchGain"+std::to_string(i+1),0,-6,6);
            matchRunning_=matchRunning_||gain!=0;
            for(auto& channel:matchFilters_)channel[i].design(0,hz,.8,gain,rate);
        }
        const std::array<double,8> frequencies{{40,100,250,750,2000,5000,10000,16000}};
        for(int i=0;i<8;++i) {
            const std::string prefix="band"+std::to_string(i+1);
            auto& band=bands_[i];
            const int type=static_cast<int>(param(s,prefix+"Type",0,0,5));
            band.enabled=param(s,prefix+"Enabled",i==2?1:0,0,1)>.5 && (!solo || solo==i+1);
            band.sections=type==3||type==4?1+static_cast<int>(param(s,prefix+"Slope",0,0,3)):1;
            const double hz=param(s,prefix+"Freq",frequencies[i],20,20000);
            const double gain=param(s,prefix+"Gain",0,-24,24);
            const double q=param(s,prefix+"Q",.707,.1,18);
            band.type=type;band.hz=hz;band.q=q;band.staticGain=gain;
            band.dynamic=band.enabled&&!solo&&type<3&&param(s,prefix+"Dyn",0,0,1)>.5;
            if(band.dynamic){
                hasDynamics_=true;
                band.range=param(s,prefix+"Range",6,0,18);
                band.threshold=param(s,prefix+"Threshold",-30,-72,0);
                band.attack=std::pow(coeffMs(param(s,prefix+"Attack",12,.1,200),rate),controlPeriod_);
                band.release=std::pow(coeffMs(param(s,prefix+"Release",120,5,1500),rate),controlPeriod_);
                band.holdSamples=static_cast<int>(rate*clamp(.5/hz,.005,.025));
                for(auto& filter:band.detector) filter.design(type==0?6:type==1?4:3,hz,type==0?q:.707,0,rate);
            }
            for(int ch=0;ch<2;++ch) for(int j=0;j<band.sections;++j) {
                // Higher-order cuts use Butterworth pole Qs, keeping their
                // combined corner at -3 dB; 12 dB/oct retains the requested Q.
                const double cutQ=band.sections==1?q:1/(2*std::cos(pi*(2*j+1)/(4*band.sections)));
                band.filters[ch][j].design(solo && type<3?6:type,hz,type>=3&&type<=4?cutQ:q,gain,rate);
            }
        }
    }
    void process(float* l,float* r,int n) override {
        for(int i=0;i<n;++i) {
            // Detect from the signal before EQ so a band's own cut cannot change its threshold drive.
            const double ing=input_.next(), signal[2]={l[i]*ing,r[i]*ing};double x[2]={signal[0],signal[1]};
            for(auto& b:bands_) if(b.enabled) {
                if(b.dynamic) detect(b,signal);
                for(int ch=0;ch<2;++ch)for(int j=0;j<b.sections;++j)x[ch]=b.filters[ch][j].tick(x[ch]);
            }
            if(matchRunning_&&!soloing_)for(int ch=0;ch<2;++ch)for(auto& filter:matchFilters_[ch])x[ch]=filter.tick(x[ch]);
            const double out=output_.next(); l[i]=static_cast<float>(x[0]*out); r[i]=static_cast<float>(x[1]*out);
        }
    }
    void reset() override {
        for(auto& b:bands_){
            if(b.dynamic)tune(b,0);
            for(auto& ch:b.filters)for(auto& f:ch)f.reset();
            for(auto& f:b.detector)f.reset();
            b.applied=b.aimed=b.attenuation=b.peak=0;b.untilUpdate=b.hold=0;
        }
        input_.reset();output_.reset();
        for(auto& channel:matchFilters_)for(auto& filter:channel)filter.reset();
    }
    void measureGain(EffectMeasurement& measure) const override {
        measure.hasBandReduction=hasDynamics_;
        if(hasDynamics_)for(std::size_t i=0;i<bands_.size();++i)measure.bandReductionDb[i]=bands_[i].dynamic?bands_[i].applied:0;
    }
    void inheritState(const Processor& source)override{
        const auto& old=static_cast<const Equalizer&>(source);inheritSlew(input_,old.input_);inheritSlew(output_,old.output_);
        if((matchRunning_||old.matchRunning_)&&!old.soloing_&&!soloing_){
            matchRunning_=true;
            for(int ch=0;ch<2;++ch)inheritFilters(matchFilters_[ch],old.matchFilters_[ch]);
        }
        for(int b=0;b<8;++b){
            auto& into=bands_[b];const auto& from=old.bands_[b];
            for(int ch=0;ch<2;++ch)inheritFilters(into.filters[ch],from.filters[ch]);
            if(into.dynamic&&from.dynamic&&into.type==from.type){
                inheritFilters(into.detector,from.detector);into.peak=from.peak;into.hold=from.hold;into.untilUpdate=from.untilUpdate;
                into.attenuation=std::min(into.range,from.attenuation);into.applied=from.applied;tune(into,into.attenuation);
            }
        }
    }
};

class Compressor final : public Processor {
    std::array<Biquad,2> hp_;
    double threshold_,ratio_,knee_,attack_,release_,link_,rmsCoeff_,envelope_[2]{},gainDb_[2]{};
    bool rms_,autoRelease_; Slew makeup_,mix_;
public:
    Compressor(const EffectSpec& s,double rate)
      :threshold_(param(s,"thresholdDb",-18,-60,0)),ratio_(param(s,"ratio",3,1,20)),
       knee_(param(s,"kneeDb",6,0,24)),attack_(coeffMs(param(s,"attackMs",15,.1,200),rate)),
       release_(coeffMs(param(s,"releaseMs",150,5,2000),rate)),link_(param(s,"stereoLink",100,0,100)/100),
       rmsCoeff_(coeffMs(10,rate)),rms_(param(s,"detector",0,0,1)>.5),autoRelease_(param(s,"autoRelease",0,0,1)>.5) {
        makeup_.init(dbGain(param(s,"makeupDb",0,-24,24)),rate); mix_.init(param(s,"mix",100,0,100)/100,rate);
        for(auto& f:hp_) f.design(3,param(s,"sidechainHpHz",20,20,1000),.70710678,0,rate);
    }
    void process(float* l,float* r,int n) override {
        for(int i=0;i<n;++i) {
            const double dry[2]={l[i],r[i]}; double level[2];
            for(int ch=0;ch<2;++ch) {
                const double sc=hp_[ch].tick(dry[ch]);
                if(rms_) { envelope_[ch]=rmsCoeff_*envelope_[ch]+(1-rmsCoeff_)*sc*sc; level[ch]=std::sqrt(envelope_[ch]); }
                else level[ch]=std::abs(sc);
            }
            const double linked=std::max(level[0],level[1]); const double wet=mix_.next(),makeup=makeup_.next();
            double y[2];
            for(int ch=0;ch<2;++ch) {
                const double db=gainDb(level[ch]*(1-link_)+linked*link_); const double over=db-threshold_;
                double target=0;
                if(knee_>0 && std::abs(over)<knee_/2) target=(1/ratio_-1)*std::pow(over+knee_/2,2)/(2*knee_);
                else if(over>0) target=(1/ratio_-1)*over;
                double c=target<gainDb_[ch]?attack_:release_;
                if(autoRelease_ && target>gainDb_[ch]) c=std::pow(c,1/clamp(1+(-gainDb_[ch])/18,1,3));
                gainDb_[ch]=target+c*(gainDb_[ch]-target);
                y[ch]=dry[ch]*((1-wet)+wet*dbGain(gainDb_[ch])*makeup);
            }
            l[i]=static_cast<float>(y[0]);r[i]=static_cast<float>(y[1]);
        }
    }
    void reset() override { for(auto& f:hp_) f.reset(); envelope_[0]=envelope_[1]=gainDb_[0]=gainDb_[1]=0;makeup_.reset();mix_.reset(); }
    double reduction() const override { return -std::min(gainDb_[0],gainDb_[1]); }
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Compressor&>(source);inheritFilters(hp_,old.hp_);for(int ch=0;ch<2;++ch){envelope_[ch]=old.envelope_[ch];gainDb_[ch]=old.gainDb_[ch];}inheritSlew(makeup_,old.makeup_);inheritSlew(mix_,old.mix_);}
};

// Three LR4 bands sum to a unity-magnitude, minimum-phase crossover response.
// The low band receives the same high-crossover all-pass as the upper bands.
class MultibandCompressor final : public Processor {
    using Pair = std::array<Biquad,2>;
    struct Channel { Pair low, lowHigh, mid, high, alignLow, alignHigh; };
    struct Band {
        Slew threshold, ratio, attack, release, makeup;
        double gain=0;
    };
    std::array<Channel,2> channels_;
    std::array<Band,3> bands_;
    Slew mix_, output_;
    double rate_;
    static double tick(Pair& filters,double x){return filters[1].tick(filters[0].tick(x));}
    void design(Pair& filters,int type,double hz,bool immediate){
        for(auto& f:filters)f.design(type,hz,.7071067811865476,0,rate_,immediate);
    }
public:
    MultibandCompressor(const EffectSpec& spec,double rate):rate_(rate){configure(spec,true);}
    void configure(const EffectSpec& spec,bool immediate=false){
        const double low=param(spec,"crossoverLowHz",160,60,600);
        const double high=param(spec,"crossoverHighHz",3200,900,12000);
        for(auto& ch:channels_){
            design(ch.low,4,low,immediate);design(ch.lowHigh,3,low,immediate);
            design(ch.mid,4,high,immediate);design(ch.high,3,high,immediate);
            design(ch.alignLow,4,high,immediate);design(ch.alignHigh,3,high,immediate);
        }
        for(int i=0;i<3;++i){
            auto& b=bands_[i];const std::string prefix="band"+std::to_string(i+1);
            setSlew(b.threshold,param(spec,prefix+"ThresholdDb",-18,-60,0),rate_,15,immediate);
            setSlew(b.ratio,param(spec,prefix+"Ratio",1,1,20),rate_,15,immediate);
            setSlew(b.attack,coeffMs(param(spec,prefix+"AttackMs",15,.1,200),rate_),rate_,15,immediate);
            setSlew(b.release,coeffMs(param(spec,prefix+"ReleaseMs",150,5,2000),rate_),rate_,15,immediate);
            setSlew(b.makeup,param(spec,prefix+"MakeupDb",0,-18,18),rate_,15,immediate);
        }
        setSlew(mix_,param(spec,"mix",100,0,100)*.01,rate_,15,immediate);
        setSlew(output_,param(spec,"outputDb",0,-24,12),rate_,15,immediate);
    }
    void process(float* left,float* right,int frames)override{
        for(int i=0;i<frames;++i){
            const double in[2]={left[i],right[i]};double split[3][2];
            for(int ch=0;ch<2;++ch){
                auto& f=channels_[ch];const double low=tick(f.low,in[ch]);
                const double upper=tick(f.lowHigh,in[ch]);
                split[0][ch]=tick(f.alignLow,low)+tick(f.alignHigh,low);
                split[1][ch]=tick(f.mid,upper);split[2][ch]=tick(f.high,upper);
            }
            double wet[2]{},dry[2]{};
            for(int b=0;b<3;++b){
                auto& band=bands_[b];const double threshold=band.threshold.next(),ratio=band.ratio.next();
                const double attack=band.attack.next(),release=band.release.next(),makeup=band.makeup.next();
                const double level=std::max(std::abs(split[b][0]),std::abs(split[b][1]));
                const double over=std::max(0.,gainDb(level)-threshold);
                const double target=(1/ratio-1)*over;
                const double coeff=target<band.gain?attack:release;
                band.gain=undenormal(target+coeff*(band.gain-target));
                const double gain=dbGain(band.gain+makeup);
                for(int ch=0;ch<2;++ch){dry[ch]+=split[b][ch];wet[ch]+=split[b][ch]*gain;}
            }
            const double mix=mix_.next(),out=dbGain(output_.next());
            left[i]=static_cast<float>((dry[0]+mix*(wet[0]-dry[0]))*out);
            right[i]=static_cast<float>((dry[1]+mix*(wet[1]-dry[1]))*out);
        }
    }
    void reset()override{
        for(auto& ch:channels_){for(auto* pair:{&ch.low,&ch.lowHigh,&ch.mid,&ch.high,&ch.alignLow,&ch.alignHigh})for(auto& f:*pair)f.reset();}
        for(auto& b:bands_){b.gain=0;b.threshold.reset();b.ratio.reset();b.attack.reset();b.release.reset();b.makeup.reset();}
        mix_.reset();output_.reset();
    }
    double reduction()const override{return std::max({-bands_[0].gain,-bands_[1].gain,-bands_[2].gain});}
    void measureGain(EffectMeasurement& m)const override{
        m.hasMultibandReduction=true;for(int i=0;i<3;++i)m.multibandReductionDb[i]=-bands_[i].gain;
        m.gainReductionDb=reduction();
    }
    void inheritState(const Processor& source)override{
        const auto& old=static_cast<const MultibandCompressor&>(source);
        for(int ch=0;ch<2;++ch){auto& n=channels_[ch];const auto& o=old.channels_[ch];
            inheritFilters(n.low,o.low);inheritFilters(n.lowHigh,o.lowHigh);inheritFilters(n.mid,o.mid);
            inheritFilters(n.high,o.high);inheritFilters(n.alignLow,o.alignLow);inheritFilters(n.alignHigh,o.alignHigh);}
        for(int i=0;i<3;++i){auto& n=bands_[i];const auto& o=old.bands_[i];n.gain=o.gain;
            inheritSlew(n.threshold,o.threshold);inheritSlew(n.ratio,o.ratio);inheritSlew(n.attack,o.attack);
            inheritSlew(n.release,o.release);inheritSlew(n.makeup,o.makeup);}
        inheritSlew(mix_,old.mix_);inheritSlew(output_,old.output_);
    }
};

class TransientShaper final : public Processor {
    Slew attack_,sustain_,mix_,out_;
    double fastAttack_,slowAttack_,fastRelease_,bodyRelease_,tailAttack_,longRelease_,gainSlew_;
    double fast_=0,body_=0,tail_=0,gainDb_=0,appliedGain_=1;
    static double follow(double x,double old,double attack,double release) {
        return undenormal(x+(x>old?attack:release)*(old-x));
    }
public:
    TransientShaper(const EffectSpec& s,double rate):fastAttack_(coeffMs(.25,rate)),slowAttack_(coeffMs(25,rate)),
      fastRelease_(coeffMs(15,rate)),bodyRelease_(coeffMs(8,rate)),tailAttack_(coeffMs(2,rate)),
      longRelease_(coeffMs(160,rate)),gainSlew_(coeffMs(.35,rate)) {
        attack_.init(param(s,"attack",0,-100,100)*.12,rate);
        sustain_.init(param(s,"sustain",0,-100,100)*.12,rate);
        mix_.init(param(s,"mix",100,0,100)*.01,rate);
        out_.init(dbGain(param(s,"outputDb",0,-24,24)),rate);
    }
    void process(float* l,float* r,int n)override{
        for(int i=0;i<n;++i){
            const double peak=std::max(std::abs(l[i]),std::abs(r[i]));
            fast_=follow(peak,fast_,fastAttack_,fastRelease_);
            body_=follow(fast_,body_,slowAttack_,bodyRelease_);
            tail_=follow(fast_,tail_,tailAttack_,longRelease_);
            // Compare envelope shapes, rather than absolute level, so soft hits are still shaped.
            const double onset=clamp(1.35*(fast_-body_)/std::max(1e-5,fast_),0,1);
            const double ending=clamp(1.35*(tail_-fast_)/std::max(1e-5,tail_),0,1)*(1-onset);
            const double target=attack_.next()*onset+sustain_.next()*ending;
            gainDb_=undenormal(target+gainSlew_*(gainDb_-target));
            const double mix=mix_.next();
            appliedGain_=mix>0&&gainDb_!=0?1+mix*(dbGain(gainDb_)-1):1;
            const double gain=appliedGain_*out_.next();
            l[i]=static_cast<float>(l[i]*gain);r[i]=static_cast<float>(r[i]*gain);
        }
    }
    void reset()override{
        fast_=body_=tail_=gainDb_=0;appliedGain_=1;
        attack_.reset();sustain_.reset();mix_.reset();out_.reset();
    }
    void measureGain(EffectMeasurement& measure) const override {
        measure.hasTransientGain=true;measure.transientGainDb=gainDb(appliedGain_);
    }
    void inheritState(const Processor& source)override{
        const auto& old=static_cast<const TransientShaper&>(source);
        fast_=old.fast_;body_=old.body_;tail_=old.tail_;gainDb_=old.gainDb_;appliedGain_=old.appliedGain_;
        inheritSlew(attack_,old.attack_);inheritSlew(sustain_,old.sustain_);inheritSlew(mix_,old.mix_);inheritSlew(out_,old.out_);
    }
};

class Gate final : public Processor {
    std::array<Biquad,2> hp_,lp_;
    double threshold_,range_,ratio_,hysteresis_,attack_,release_,detectorRelease_,envelope_=0,gainDb_=0;
    int hold_,remaining_=0; bool open_=false,listen_;
public:
    Gate(const EffectSpec& s,double rate):threshold_(param(s,"thresholdDb",-45,-96,0)),
      range_(param(s,"rangeDb",60,0,96)),ratio_(param(s,"ratio",8,1,20)),
      hysteresis_(param(s,"hysteresisDb",4,0,24)),attack_(coeffMs(param(s,"attackMs",2,.1,200),rate)),
      release_(coeffMs(param(s,"releaseMs",180,5,3000),rate)),detectorRelease_(coeffMs(8,rate)),hold_(static_cast<int>(param(s,"holdMs",70,0,2000)*rate*.001)),
      listen_(param(s,"listen",0,0,1)>.5) {
        gainDb_=-range_;
        for(auto& f:hp_) f.design(3,param(s,"sidechainHpHz",20,20,2000),.70710678,0,rate);
        for(auto& f:lp_) f.design(4,param(s,"sidechainLpHz",20000,100,20000),.70710678,0,rate);
    }
    void process(float* l,float* r,int n) override {
        for(int i=0;i<n;++i) {
            const double x[2]={l[i],r[i]}; double sc[2];
            for(int ch=0;ch<2;++ch) sc[ch]=lp_[ch].tick(hp_[ch].tick(x[ch]));
            const double peak=std::max(std::abs(sc[0]),std::abs(sc[1]));
            envelope_=peak>envelope_?peak:envelope_*detectorRelease_; const double db=gainDb(envelope_);
            if(db>=threshold_) {open_=true;remaining_=hold_;}
            else if(open_ && db<threshold_-hysteresis_) { if(remaining_>0)--remaining_;else open_=false; }
            const double target=open_?0:std::max(-range_,(db-threshold_)*(ratio_-1));
            const double c=target>gainDb_?attack_:release_; gainDb_=target+c*(gainDb_-target);
            const double g=dbGain(gainDb_); l[i]=static_cast<float>(listen_?sc[0]:x[0]*g);r[i]=static_cast<float>(listen_?sc[1]:x[1]*g);
        }
    }
    void reset() override { for(auto& f:hp_)f.reset();for(auto& f:lp_)f.reset();envelope_=0;gainDb_=-range_;remaining_=0;open_=false; }
    double reduction() const override { return -gainDb_; }
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Gate&>(source);inheritFilters(hp_,old.hp_);inheritFilters(lp_,old.lp_);envelope_=old.envelope_;gainDb_=old.gainDb_;remaining_=old.remaining_;open_=old.open_;}
};

struct SidechainBlockView {
    const float* peak=nullptr;
    const float* power=nullptr;
    double keyGain=1, programGain=1;
    // Optional unmodified stereo source, used by frequency-selective detectors.
    const float* left=nullptr;
    const float* right=nullptr;
};

class Ducker final : public Processor {
    double rate_, detectorRelease_, rmsCoefficient_, envelope_=0, gainDb_=0;
    double keyPower_=0, programPower_=0, requested_=0;
    double activityPower_=0, broadbandPower_=0, activityRise_, activityFall_;
    double attack_=0, release_=0, hysteresis_=1;
    double bandHz_=1800, bandQ_=.8;
    int hold_=0, remaining_=0, untilAnalysis_=0, recentKey_=0, bandUpdate_=0;
    int mode_=0;
    bool open_=false, adaptive_=false, smoothTrigger_=false;
    std::array<Biquad,2> keyBand_,programBand_,cutBand_;
    Slew threshold_, depth_, margin_;
    void clearDetector(){envelope_=keyPower_=requested_=activityPower_=broadbandPower_=0;remaining_=untilAnalysis_=recentKey_=0;open_=false;}
    static double powerDb(double power){return 10*std::log10(std::max(power,1e-12));}
    void designCut(bool immediate){
        for(auto& f:cutBand_){
            f.design(0,bandHz_,bandQ_,gainDb_,rate_,immediate);
            // Follow the already attack/release-smoothed gain without adding a
            // second 20 ms envelope; interpolate between coefficient updates.
            f.slew=coeffMs(1,rate_);
        }
    }
public:
    Ducker(const EffectSpec& spec,double rate)
        :rate_(rate),detectorRelease_(coeffMs(25,rate)),rmsCoefficient_(coeffMs(35,rate)),
         activityRise_(coeffMs(40,rate)),activityFall_(coeffMs(90,rate)){configure(spec,true);}

    void configure(const EffectSpec& spec,bool immediate=false,bool sourceChanged=false){
        const int mode=static_cast<int>(std::round(param(spec,"mode",0,0,2)));
        const bool modeChanged=mode_!=mode;
        const bool smoothTrigger=mode!=0 && param(spec,"smoothTrigger",0,0,1)>.5;
        const bool triggerChanged=smoothTrigger_!=smoothTrigger;
        if(sourceChanged||modeChanged||triggerChanged){
            clearDetector();programPower_=0;
            for(auto& f:keyBand_)f.reset();
            for(auto& f:programBand_)f.reset();
            if(modeChanged)for(auto& f:cutBand_)f.reset();
        }
        mode_=mode;adaptive_=mode_!=0;smoothTrigger_=smoothTrigger;
        bandHz_=param(spec,"bandHz",1800,250,8000);
        bandQ_=param(spec,"bandQ",.8,.35,3);
        for(auto& f:keyBand_)f.design(6,bandHz_,bandQ_,0,rate_,immediate||modeChanged);
        for(auto& f:programBand_)f.design(6,bandHz_,bandQ_,0,rate_,immediate||modeChanged);
        designCut(immediate||modeChanged);
        bandUpdate_=0;
        setSlew(threshold_,dbGain(param(spec,"thresholdDb",-30,-60,0)),rate_,15,immediate);
        setSlew(depth_,param(spec,"depthDb",12,0,36),rate_,15,immediate);
        setSlew(margin_,param(spec,"marginDb",3,0,12),rate_,15,immediate);
        attack_=coeffMs(param(spec,"attackMs",12,1,250),rate_);
        release_=coeffMs(param(spec,"releaseMs",300,10,2500),rate_);
        hysteresis_=dbGain(-param(spec,"hysteresisDb",4,0,12));
        hold_=static_cast<int>(std::round(param(spec,"holdMs",100,0,500)*rate_*.001));
        remaining_=std::min(remaining_,hold_);
    }

    void processKeyed(float* left,float* right,int frames,SidechainBlockView key){
        if(!key.peak)clearDetector();
        const double keyGain=adaptive_?key.keyGain:1;
        const double keyScale=keyGain*keyGain, programScale=key.programGain*key.programGain;
        const int analysisHop=std::max(1,int(rate_*.001));
        const int keyWindow=std::max(1,int(rate_*.012));
        const int smoothKeyWindow=std::max(1,int(rate_*.035));
        for(int i=0;i<frames;++i){
            const double threshold=threshold_.next(),depth=depth_.next();
            double peak=key.peak?std::abs(clean(key.peak[i])):0;
            const double broadbandPeak=peak*keyGain;
            if(adaptive_){
                const double l=clean(left[i]),r=clean(right[i]);
                double inputPower=.5*(l*l+r*r)*programScale;
                double triggerPower=(key.power?std::max(0.f,clean(key.power[i])):peak*peak)*keyScale;
                if(smoothTrigger_){
                    // Activity is broadband even when the gain calculation is band-limited.
                    const double c=triggerPower>activityPower_?activityRise_:activityFall_;
                    activityPower_=undenormal(triggerPower+c*(activityPower_-triggerPower));
                    broadbandPower_=undenormal(triggerPower+rmsCoefficient_*(broadbandPower_-triggerPower));
                }
                if(mode_==2){
                    const double pl=programBand_[0].tick(l),pr=programBand_[1].tick(r);
                    inputPower=.5*(pl*pl+pr*pr)*programScale;
                    if(key.left&&key.right){
                        const double kl=keyBand_[0].tick(clean(key.left[i]));
                        const double kr=keyBand_[1].tick(clean(key.right[i]));
                        peak=std::max(std::abs(kl),std::abs(kr));
                        triggerPower=.5*(kl*kl+kr*kr)*keyScale;
                    }
                }
                programPower_=undenormal(inputPower+rmsCoefficient_*(programPower_-inputPower));
                keyPower_=undenormal(triggerPower+rmsCoefficient_*(keyPower_-triggerPower));
            }
            if(key.peak){
                const bool wasOpen=open_;
                envelope_=smoothTrigger_?std::sqrt(activityPower_):std::max(peak*keyGain,undenormal(envelope_*detectorRelease_));
                const double gate=threshold*(open_?hysteresis_:1);
                const bool freshKey=(smoothTrigger_?broadbandPeak:peak*keyGain)>=gate;
                if(smoothTrigger_){
                    if(freshKey)recentKey_=smoothKeyWindow;
                    else if(recentKey_>0)--recentKey_;
                    // Require recent content as well as sustained energy. Keep the last
                    // reduction through the hold instead of asking for a stronger cut
                    // merely because the vocal RMS falls at the end of a phrase.
                    open_=envelope_>=gate&&recentKey_>0;
                }
                else if(adaptive_){
                    if(freshKey)recentKey_=keyWindow;
                    else if(recentKey_>0)--recentKey_;
                    open_=recentKey_>0;
                }else open_=envelope_>=gate;
                if(open_){
                    remaining_=hold_;
                    if(untilAnalysis_>0)--untilAnalysis_;
                    if(adaptive_&&freshKey&&(!wasOpen||untilAnalysis_<=0)){
                        if(smoothTrigger_&&mode_==2){
                            // Tiny amounts of vocal energy in the band must not cause a
                            // full-depth cut just because the ratio denominator is tiny.
                             const double floorPower=std::max(1e-12,broadbandPower_*.012);
                             const double share=keyPower_/std::max(1e-12,broadbandPower_);
                             const double evidence=clamp((share-.008)/.05,0,1);
                            requested_=evidence*clamp(powerDb(programPower_)-powerDb(std::max(keyPower_,floorPower))+margin_.current,0,depth);
                        }else{
                            const double floorPower=smoothTrigger_?threshold*threshold*hysteresis_*hysteresis_:1e-12;
                            requested_=clamp(powerDb(programPower_)-powerDb(std::max(keyPower_,floorPower))+margin_.current,0,depth);
                        }
                        untilAnalysis_=analysisHop;
                    }
                }
            }
            if(adaptive_)margin_.next();
            const double desired=open_||remaining_>0?-(adaptive_?std::min(requested_,depth):depth):0;
            if(!open_&&remaining_>0)--remaining_;
            gainDb_=desired+(gainDb_<desired?release_:attack_)*(gainDb_-desired);
            if(std::abs(gainDb_)<1e-6)gainDb_=0;
            if(mode_==2){
                if(bandUpdate_<=0){designCut(false);bandUpdate_=analysisHop;}
                --bandUpdate_;
                left[i]=static_cast<float>(cutBand_[0].tick(clean(left[i])));
                right[i]=static_cast<float>(cutBand_[1].tick(clean(right[i])));
            }else if(gainDb_!=0){
                const auto gain=static_cast<float>(dbGain(gainDb_));
                left[i]*=gain;right[i]*=gain;
            }
        }
    }
    void process(float* left,float* right,int frames)override{processKeyed(left,right,frames,{});}
    void reset()override{
        clearDetector();gainDb_=programPower_=0;threshold_.reset();depth_.reset();margin_.reset();
        for(auto& f:keyBand_)f.reset();for(auto& f:programBand_)f.reset();
        designCut(true);for(auto& f:cutBand_)f.reset();bandUpdate_=0;
    }
    double reduction()const override{return -gainDb_;}
    void measureGain(EffectMeasurement& measurement)const override{
        measurement.gainReductionDb=reduction();
        measurement.sidechainInputDb=std::max(-120.,dsp_detail::gainDb(envelope_));
        measurement.hasSidechain=true;
        measurement.hasDuckerBalance=adaptive_;
        if(adaptive_){measurement.duckerKeyDb=powerDb(keyPower_);measurement.duckerProgramDb=powerDb(programPower_);}
    }
    void inheritState(const Processor& source)override{
        const auto& old=static_cast<const Ducker&>(source);
        gainDb_=old.gainDb_;
        if(mode_==old.mode_&&smoothTrigger_==old.smoothTrigger_){
            activityPower_=old.activityPower_;broadbandPower_=old.broadbandPower_;
            envelope_=old.envelope_;remaining_=std::min(old.remaining_,hold_);open_=old.open_;
            keyPower_=old.keyPower_;programPower_=old.programPower_;requested_=old.requested_;untilAnalysis_=old.untilAnalysis_;recentKey_=old.recentKey_;
            if(mode_==2){inheritFilters(keyBand_,old.keyBand_);inheritFilters(programBand_,old.programBand_);inheritFilters(cutBand_,old.cutBand_);}
        }
        inheritSlew(threshold_,old.threshold_);inheritSlew(depth_,old.depth_);inheritSlew(margin_,old.margin_);
    }
};

class Deesser final : public Processor {
    std::array<Biquad,2> detector_,split_;
    double threshold_,range_,attack_,release_,envelope_=0,gainDb_=0;
    bool splitMode_,listen_; Slew mix_;
public:
    Deesser(const EffectSpec& s,double rate):threshold_(param(s,"thresholdDb",-28,-60,0)),range_(param(s,"rangeDb",6,0,18)),
      attack_(coeffMs(param(s,"attackMs",1,.1,50),rate)),release_(coeffMs(param(s,"releaseMs",80,5,500),rate)),
      splitMode_(param(s,"mode",1,0,1)>.5),listen_(param(s,"listen",0,0,1)>.5) {
        const double f=param(s,"freqHz",6500,1500,14000),bw=param(s,"bandwidthOct",1,.25,4);
        const double q=1/(2*std::sinh(std::log(2.0)*bw/2));
        // Subtract the in-phase band-pass component. Subtracting an ordinary
        // high-pass from the unfiltered dry path would boost its 90-degree
        // crossover region instead of reliably de-essing the selected band.
        for(int ch=0;ch<2;++ch) {detector_[ch].design(6,f,q,0,rate);split_[ch].design(6,f,q,0,rate);}
        mix_.init(param(s,"mix",100,0,100)/100,rate);
    }
    void process(float* l,float* r,int n) override {
        for(int i=0;i<n;++i) {
            const double x[2]={l[i],r[i]}; double band[2],high[2];
            for(int ch=0;ch<2;++ch){band[ch]=detector_[ch].tick(x[ch]); high[ch]=split_[ch].tick(x[ch]);}
            const double peak=std::max(std::abs(band[0]),std::abs(band[1]));
            envelope_=peak+(peak>envelope_?attack_:release_)*(envelope_-peak);
            const double target=-std::min(range_,std::max(0.0,gainDb(envelope_)-threshold_)*.75);
            gainDb_=target+(target<gainDb_?attack_:release_)*(gainDb_-target);
            const double reduction=1-dbGain(gainDb_),m=mix_.next(); double y[2];
            for(int ch=0;ch<2;++ch)y[ch]=listen_?band[ch]:x[ch]-m*reduction*(splitMode_?high[ch]:x[ch]);
            l[i]=static_cast<float>(y[0]);r[i]=static_cast<float>(y[1]);
        }
    }
    void reset() override {for(auto& f:detector_)f.reset();for(auto& f:split_)f.reset();envelope_=gainDb_=0;mix_.reset();}
    double reduction() const override {return -gainDb_;}
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Deesser&>(source);inheritFilters(detector_,old.detector_);inheritFilters(split_,old.split_);envelope_=old.envelope_;gainDb_=old.gainDb_;inheritSlew(mix_,old.mix_);}
};

class Delay final : public Processor {
    std::array<SampleRing<float>,2> delay_;
    std::array<Biquad,2> hp_,lp_;
    Slew timeL_,timeR_,feedback_,mix_,width_,output_; bool pingPong_; std::int64_t tail_;
public:
    Delay(const EffectSpec& s,double rate,double bpm) {
        for(auto& line:delay_)line.prepare(static_cast<std::size_t>(rate*12)+4);
        configure(s,rate,bpm,true);
    }
    void configure(const EffectSpec& s,double rate,double bpm,bool immediate=false) {
        pingPong_=param(s,"pingPong",0,0,1)>.5;
        constexpr std::array<double,15> beats{{.125,1.0/6,.1875,.25,1.0/3,.375,.5,2.0/3,.75,1,4.0/3,1.5,2,3,4}};
        const bool sync=param(s,"sync",0,0,1)>.5;
        double left=param(s,"timeMs",375,1,4000)*.001,right=param(s,"timeRightMs",500,1,4000)*.001;
        if(sync){left=beats[static_cast<int>(param(s,"noteL",8,0,14))]*60/bpm;right=beats[static_cast<int>(param(s,"noteR",9,0,14))]*60/bpm;}
        left=clamp(left,1/rate,12);right=clamp(right,1/rate,12);
        for(int ch=0;ch<2;++ch){hp_[ch].design(3,param(s,"lowCutHz",100,20,2000),.70710678,0,rate,immediate);lp_[ch].design(4,param(s,"highCutHz",8000,1000,20000),.70710678,0,rate,immediate);}
        const double fb=param(s,"feedback",30,0,95)/100;
        setSlew(timeL_,left*rate,rate,30,immediate);setSlew(timeR_,right*rate,rate,30,immediate);setSlew(feedback_,fb,rate,15,immediate);
        setSlew(mix_,param(s,"mix",20,0,100)/100,rate,15,immediate);setSlew(width_,param(s,"width",100,0,200)/100,rate,15,immediate);setSlew(output_,dbGain(param(s,"outputDb",0,-24,12)),rate,15,immediate);
        const double repeats=fb>0?std::ceil(std::log(.001)/std::log(fb))+1:1;
        tail_=static_cast<std::int64_t>(std::max(left,right)*repeats*rate);
    }
    void process(float* l,float* r,int n) override {
        for(int i=0;i<n;++i){
            const double dry[2]={l[i],r[i]};double wet[2]={delay_[0].read(timeL_.next()),delay_[1].read(timeR_.next())};
            double filtered[2];for(int ch=0;ch<2;++ch)filtered[ch]=lp_[ch].tick(hp_[ch].tick(wet[ch]));
            const double fb=feedback_.next();
            // Crossfeed is applied to both the input and the feedback so a mono
            // impulse really alternates sides in ping-pong mode.
            if(pingPong_){delay_[0].push((dry[0]+dry[1])*.5+filtered[1]*fb);delay_[1].push(filtered[0]*fb);}
            else {delay_[0].push(dry[0]+filtered[0]*fb);delay_[1].push(dry[1]+filtered[1]*fb);}
            const double mid=(wet[0]+wet[1])*.5,side=(wet[0]-wet[1])*.5*width_.next();wet[0]=mid+side;wet[1]=mid-side;
            const double m=mix_.next(),out=output_.next();l[i]=static_cast<float>((dry[0]*(1-m)+wet[0]*m)*out);r[i]=static_cast<float>((dry[1]*(1-m)+wet[1]*m)*out);
        }
    }
    void reset() override {for(auto& d:delay_)d.reset();for(auto& f:hp_)f.reset();for(auto& f:lp_)f.reset();timeL_.reset();timeR_.reset();feedback_.reset();mix_.reset();width_.reset();output_.reset();}
    std::int64_t tail() const override{return mix_.target>0?tail_:0;}
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Delay&>(source);delay_=old.delay_;inheritFilters(hp_,old.hp_);inheritFilters(lp_,old.lp_);inheritSlew(timeL_,old.timeL_);inheritSlew(timeR_,old.timeR_);inheritSlew(feedback_,old.feedback_);inheritSlew(mix_,old.mix_);inheritSlew(width_,old.width_);inheritSlew(output_,old.output_);}
};

class Reverb final : public Processor {
    std::array<Ring,8> lines_;
    std::array<Ring,2> pre_,extendedPre_;
    std::array<std::array<Ring,2>,2> diffusion_;
    std::array<Biquad,2> hp_,lp_;
    std::array<double,8> lengths_{},feedback_{},dampState_{},bassState_{};
    std::array<Slew,8> lengthSlew_,feedbackSlew_,bassGainSlew_;
    std::array<Slew,4> patternSlew_;
    double preDelay_,damping_,early_,phase_=0,rate_;
    Slew mix_,width_,output_,preSlew_,dampSlew_,earlySlew_,diffusionSlew_,earlySizeSlew_,modStepSlew_,modDepthSlew_,bassCoeffSlew_;
    std::int64_t tail_,earlyTail_;
    double earlyRead(int ch,double delay)const{return delay<=static_cast<double>(pre_[ch].data.size()-2)?pre_[ch].read(delay):extendedPre_[ch].read(delay);}
    static double diffuse(Ring& d,double x,double length,double amount){const double z=d.read(length),y=z-amount*x;d.push(x+amount*y);return y;}
public:
    Reverb(const EffectSpec& s,double rate):rate_(rate){
        for(auto& line:lines_)line.prepare(static_cast<std::size_t>(rate*.15)+8);
        for(int ch=0;ch<2;++ch){pre_[ch].prepare(static_cast<std::size_t>(rate*.45)+8);extendedPre_[ch].prepare(static_cast<std::size_t>(rate*.55)+8);for(auto& diffuser:diffusion_[ch])diffuser.prepare(static_cast<std::size_t>(rate*.03)+8);}
        configure(s,rate,true);
    }
    void configure(const EffectSpec& s,double rate,bool immediate=false){
        const double size=.45+param(s,"size",60,0,100)*.011,decay=param(s,"decaySec",1.8,.1,15);
        constexpr std::array<double,8> times{{.0297,.0371,.0411,.0437,.0531,.0617,.0677,.0793}};
        for(int i=0;i<8;++i){lengths_[i]=std::round(times[i]*size*rate);feedback_[i]=std::pow(.001,lengths_[i]/(rate*decay));setSlew(lengthSlew_[i],lengths_[i],rate,80,immediate);setSlew(feedbackSlew_[i],feedback_[i],rate,40,immediate);}
        preDelay_=param(s,"preDelayMs",20,0,250)*rate*.001;
        for(int ch=0;ch<2;++ch){hp_[ch].design(3,param(s,"lowCutHz",120,20,2000),.70710678,0,rate,immediate);lp_[ch].design(4,param(s,"highCutHz",14000,1000,20000),.70710678,0,rate,immediate);}
        damping_=std::exp(-2*pi*clamp(param(s,"dampingHz",6500,500,20000),100,rate*.45)/rate);
        early_=param(s,"earlyMix",25,0,100)/100;
        setSlew(preSlew_,preDelay_,rate,30,immediate);setSlew(dampSlew_,damping_,rate,30,immediate);setSlew(earlySlew_,early_,rate,30,immediate);
        setSlew(mix_,param(s,"mix",20,0,100)/100,rate,15,immediate);setSlew(width_,param(s,"width",100,0,200)/100,rate,15,immediate);setSlew(output_,dbGain(param(s,"outputDb",0,-24,12)),rate,15,immediate);
        const double diffusion=param(s,"diffusion",60,0,100);
        setSlew(diffusionSlew_,diffusion<=60?diffusion*.01:.6+(diffusion-60)*.00375,rate,30,immediate);
        const double earlySize=param(s,"earlySize",100,25,200)*.01;
        setSlew(earlySizeSlew_,earlySize,rate,40,immediate);
        setSlew(modStepSlew_,2*pi*param(s,"modRateHz",.17,.05,3)/rate,rate,40,immediate);
        setSlew(modDepthSlew_,rate*(param(s,"modDepthMs",.12,0,1.2)*.001),rate,40,immediate);
        const double bassDecay=param(s,"bassDecay",1,.25,1);
        setSlew(bassCoeffSlew_,std::exp(-2*pi*clamp(param(s,"bassCrossHz",250,80,800),20,rate*.45)/rate),rate,40,immediate);
        for(int j=0;j<8;++j)setSlew(bassGainSlew_[j],std::pow(.001,lengths_[j]/(rate*decay)*(1/bassDecay-1)),rate,40,immediate);
        const int pattern=static_cast<int>(param(s,"earlyPattern",0,0,3));
        for(int j=0;j<4;++j)setSlew(patternSlew_[j],j==pattern?1:0,rate,30,immediate);
        // Longest preset tap is .95 times line 7; include pre-delay and filter settling.
        earlyTail_=static_cast<std::int64_t>(std::ceil(preDelay_+.95*lengths_[7]*earlySize+rate*.2+2));
        tail_=std::max(earlyTail_,static_cast<std::int64_t>((decay*1.5+preDelay_/rate+.2)*rate));
    }
    void process(float* l,float* r,int n) override {
        constexpr double invSqrt8=.3535533905932737622;
        for(int i=0;i<n;++i){
            const double dry[2]={l[i],r[i]};double input[2],early[2]={};
            double lengths[8],feedback[8];for(int j=0;j<8;++j){lengths[j]=lengthSlew_[j].next();feedback[j]=feedbackSlew_[j].next();}
            const double pre=preSlew_.next(),damping=dampSlew_.next(),earlyMix=earlySlew_.next();
            const double diffusion=diffusionSlew_.next(),earlySize=earlySizeSlew_.next();
            const double phaseStep=modStepSlew_.next(),modDepth=modDepthSlew_.next(),bassCoeff=bassCoeffSlew_.next();
            double patterns[4];for(int j=0;j<4;++j){auto& blend=patternSlew_[j];if(std::abs(blend.current-blend.target)<1e-6)blend.reset();patterns[j]=blend.next();}
            for(int ch=0;ch<2;++ch){
                pre_[ch].push(dry[ch]);extendedPre_[ch].push(dry[ch]);input[ch]=pre>0?pre_[ch].read(pre+1):dry[ch];
                if(patterns[0]!=0)early[ch]+=patterns[0]*(.5*earlyRead(ch,pre+1+lengths[0]*.31*earlySize)+.3*earlyRead(1-ch,pre+1+lengths[2]*.47*earlySize));
                if(patterns[1]!=0)early[ch]+=patterns[1]*(.38*earlyRead(ch,pre+1+lengths[0]*.19*earlySize)+.25*earlyRead(1-ch,pre+1+lengths[1]*.31*earlySize)+.17*earlyRead(ch,pre+1+lengths[3]*.43*earlySize));
                if(patterns[2]!=0)early[ch]+=patterns[2]*(.32*earlyRead(ch,pre+1+lengths[1]*.34*earlySize)+.24*earlyRead(1-ch,pre+1+lengths[4]*.58*earlySize)+.16*earlyRead(ch,pre+1+lengths[7]*.95*earlySize));
                if(patterns[3]!=0)early[ch]+=patterns[3]*(.28*earlyRead(ch,pre+1+lengths[0]*.28*earlySize)+.23*earlyRead(1-ch,pre+1+lengths[1]*.29*earlySize)+.19*earlyRead(ch,pre+1+lengths[2]*.32*earlySize)+.10*earlyRead(1-ch,pre+1+lengths[3]*.35*earlySize));
                input[ch]=diffuse(diffusion_[ch][0],input[ch],lengths[ch]*.131,diffusion);
                input[ch]=diffuse(diffusion_[ch][1],input[ch],lengths[ch+2]*.173,diffusion);
            }
            double tap[8],scatter[8],wetL=0,wetR=0;
            for(int j=0;j<8;++j){tap[j]=lines_[j].read(lengths[j]+std::sin(phase_+j*.83)*modDepth);dampState_[j]=undenormal((1-damping)*tap[j]+damping*dampState_[j]);bassState_[j]=undenormal((1-bassCoeff)*dampState_[j]+bassCoeff*bassState_[j]);scatter[j]=dampState_[j]+(bassGainSlew_[j].next()-1)*bassState_[j];wetL+=tap[j]*(j%2?1:-1)*invSqrt8;wetR+=tap[j]*((j/2)%2?1:-1)*invSqrt8;}
            // Normalized 8x8 Hadamard matrix: an orthogonal feedback scattering
            // network; every loop gain stays strictly below unity.
            for(int stride=1;stride<8;stride*=2)for(int base=0;base<8;base+=stride*2)for(int j=0;j<stride;++j){const double a=scatter[base+j],b=scatter[base+j+stride];scatter[base+j]=a+b;scatter[base+j+stride]=a-b;}
            for(int j=0;j<8;++j){const double injection=(input[0]*(j%2?1:-1)+input[1]*((j/2)%2?1:-1))*.25;lines_[j].push(injection+scatter[j]*invSqrt8*feedback[j]);}
            phase_+=phaseStep;if(phase_>2*pi)phase_-=2*pi;
            double wet[2]={(1-earlyMix)*wetL+earlyMix*early[0],(1-earlyMix)*wetR+earlyMix*early[1]};
            for(int ch=0;ch<2;++ch)wet[ch]=lp_[ch].tick(hp_[ch].tick(wet[ch]));
            const double mid=(wet[0]+wet[1])*.5,side=(wet[0]-wet[1])*.5*width_.next();wet[0]=mid+side;wet[1]=mid-side;
            const double m=mix_.next(),out=output_.next();l[i]=static_cast<float>((dry[0]*(1-m)+wet[0]*m)*out);r[i]=static_cast<float>((dry[1]*(1-m)+wet[1]*m)*out);
        }
    }
    void reset() override{for(auto& d:lines_)d.reset();for(auto& d:pre_)d.reset();for(auto& d:extendedPre_)d.reset();for(auto& ch:diffusion_)for(auto& d:ch)d.reset();for(auto& f:hp_)f.reset();for(auto& f:lp_)f.reset();dampState_.fill(0);bassState_.fill(0);phase_=0;for(auto& s:lengthSlew_)s.reset();for(auto& s:feedbackSlew_)s.reset();mix_.reset();width_.reset();output_.reset();preSlew_.reset();dampSlew_.reset();earlySlew_.reset();diffusionSlew_.reset();earlySizeSlew_.reset();modStepSlew_.reset();modDepthSlew_.reset();bassCoeffSlew_.reset();for(auto& s:bassGainSlew_)s.reset();for(auto& s:patternSlew_)s.reset();}
    std::int64_t tail()const override{
        if(mix_.target<=0)return 0;
        const auto pendingEarly=static_cast<std::int64_t>(std::ceil(std::max(preSlew_.current,preSlew_.target)+.95*std::max(lengthSlew_[7].current,lengthSlew_[7].target)*std::max(earlySizeSlew_.current,earlySizeSlew_.target)+rate_*.2+2));
        return earlySlew_.target==1&&earlySlew_.current==1?std::max(earlyTail_,pendingEarly):std::max(tail_,pendingEarly);
    }
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Reverb&>(source);lines_=old.lines_;pre_=old.pre_;extendedPre_=old.extendedPre_;diffusion_=old.diffusion_;dampState_=old.dampState_;bassState_=old.bassState_;phase_=old.phase_;for(int i=0;i<8;++i){inheritSlew(lengthSlew_[i],old.lengthSlew_[i]);inheritSlew(feedbackSlew_[i],old.feedbackSlew_[i]);}inheritFilters(hp_,old.hp_);inheritFilters(lp_,old.lp_);inheritSlew(mix_,old.mix_);inheritSlew(width_,old.width_);inheritSlew(output_,old.output_);inheritSlew(preSlew_,old.preSlew_);inheritSlew(dampSlew_,old.dampSlew_);inheritSlew(earlySlew_,old.earlySlew_);inheritSlew(diffusionSlew_,old.diffusionSlew_);inheritSlew(earlySizeSlew_,old.earlySizeSlew_);inheritSlew(modStepSlew_,old.modStepSlew_);inheritSlew(modDepthSlew_,old.modDepthSlew_);inheritSlew(bassCoeffSlew_,old.bassCoeffSlew_);for(int i=0;i<8;++i)inheritSlew(bassGainSlew_[i],old.bassGainSlew_[i]);for(int i=0;i<4;++i)inheritSlew(patternSlew_[i],old.patternSlew_[i]);}
};

// Windowed-sinc anti-imaging / anti-aliasing FIR. At factor 2/4 the two FIRs
// contribute exactly 16 base-rate samples of latency. Dry is delayed equally.
struct Fir {
    std::array<double,65> taps{};
    std::array<double,130> state{};int length=1,cursor=0;
    void prepare(int factor){
        length=16*factor+1;cursor=0;state.fill(0);double sum=0;
        const double cutoff=.45/factor;
        for(int i=0;i<length;++i){const double x=i-(length-1)*.5;const double sinc=std::abs(x)<1e-12?2*cutoff:std::sin(2*pi*cutoff*x)/(pi*x);const double window=.42-.5*std::cos(2*pi*i/(length-1))+.08*std::cos(4*pi*i/(length-1));taps[i]=sinc*window;sum+=taps[i];}
        for(int i=0;i<length;++i)taps[i]/=sum;
    }
    void push(double value){state[cursor]=state[cursor+length]=value;if(++cursor==length)cursor=0;}
    double read(int phase=0,int stride=1)const{const double* newest=state.data()+length+cursor-1;double output=0;for(int tap=phase;tap<length;tap+=stride)output+=taps[tap]*newest[-tap];return output;}
    void reset(){state.fill(0);cursor=0;}
};

class Saturation final : public Processor {
    std::array<Fir,2> up_,down_;std::array<Ring,2> dryDelay_;
    std::array<Biquad,2> tone_;
    double dcX_[2]{},dcY_[2]{},dcCoeff_,bias_;int mode_,factor_;bool dcBlock_;
    Slew drive_,mix_,output_;
    double shape(double x)const{if(mode_==1)return std::tanh(x);if(mode_==2)return clamp(x,-1,1);return std::abs(x)>=1?std::copysign(2.0/3,x):x-x*x*x/3;}
public:
    Saturation(const EffectSpec& s,double rate):dcCoeff_(std::exp(-2*pi*10/rate)),bias_(param(s,"bias",0,-1,1)),mode_(static_cast<int>(param(s,"mode",0,0,2))),factor_(1<<static_cast<int>(param(s,"oversample",1,0,2))),dcBlock_(param(s,"dcBlock",1,0,1)>.5){
        drive_.init(dbGain(param(s,"driveDb",3,0,36)),rate);mix_.init(param(s,"mix",100,0,100)/100,rate);output_.init(dbGain(param(s,"outputDb",-3,-36,12)),rate);
        for(int ch=0;ch<2;++ch){if(factor_>1){up_[ch].prepare(factor_);down_[ch].prepare(factor_);}dryDelay_[ch].prepare(20);tone_[ch].design(2,2500,.70710678,param(s,"tone",0,-100,100)*.12,rate);}
    }
    void process(float* l,float* r,int n) override{
        const double center=shape(bias_);
        for(int i=0;i<n;++i){const double x[2]={l[i],r[i]},drive=drive_.next(),m=mix_.next(),out=output_.next();double y[2];
            for(int ch=0;ch<2;++ch){double wet=0;double dry=x[ch];
                if(factor_>1){dryDelay_[ch].push(dry);dry=dryDelay_[ch].read(17);for(int phase=0;phase<factor_;++phase){up_[ch].push(phase==0?x[ch]*factor_:0);const double up=up_[ch].read(phase,factor_);down_[ch].push(shape(up*drive+bias_)-center);if(phase==0)wet=down_[ch].read();}}
                else wet=shape(x[ch]*drive+bias_)-center;
                if(dcBlock_){const double dc=wet-dcX_[ch]+dcCoeff_*dcY_[ch];dcX_[ch]=wet;dcY_[ch]=undenormal(dc);wet=dc;}
                wet=tone_[ch].tick(wet);y[ch]=(dry*(1-m)+wet*m)*out;
            }l[i]=static_cast<float>(y[0]);r[i]=static_cast<float>(y[1]);
        }
    }
    void reset()override{for(auto& f:up_)f.reset();for(auto& f:down_)f.reset();for(auto& d:dryDelay_)d.reset();for(auto& f:tone_)f.reset();dcX_[0]=dcX_[1]=dcY_[0]=dcY_[1]=0;drive_.reset();mix_.reset();output_.reset();}
    int latency()const override{return factor_>1?16:0;}
    std::int64_t tail()const override{return factor_>1?32:0;}
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Saturation&>(source);if(factor_==old.factor_){up_=old.up_;down_=old.down_;}if(factor_>1&&old.factor_>1)dryDelay_=old.dryDelay_;inheritFilters(tone_,old.tone_);for(int ch=0;ch<2;++ch){dcX_[ch]=old.dcX_[ch];dcY_[ch]=old.dcY_[ch];}inheritSlew(drive_,old.drive_);inheritSlew(mix_,old.mix_);inheritSlew(output_,old.output_);}
};

class Stereo final : public Processor {
    Slew gain_,balance_,width_;bool mono_,phaseL_,phaseR_,swap_;int listen_,channelMode_;bool lowMono_;
    std::array<std::array<Biquad,2>,2> low_,high_;
public:
    Stereo(const EffectSpec& s,double rate):mono_(param(s,"mono",0,0,1)>.5),phaseL_(param(s,"phaseLeft",0,0,1)>.5),phaseR_(param(s,"phaseRight",0,0,1)>.5),swap_(param(s,"swapChannels",0,0,1)>.5),listen_(static_cast<int>(param(s,"listen",0,0,4))),channelMode_(static_cast<int>(param(s,"channelMode",0,0,4))),lowMono_(param(s,"monoBelowHz",0,0,500)>0){
        gain_.init(dbGain(param(s,"gainDb",0,-60,24)),rate);balance_.init(param(s,"balance",0,-100,100)/100,rate);width_.init(param(s,"width",100,0,200)/100,rate);
        const double crossover=std::max(20.0,param(s,"monoBelowHz",0,0,500));
        for(auto& ch:low_)for(auto& f:ch)f.design(4,crossover,.70710678,0,rate);
        for(auto& ch:high_)for(auto& f:ch)f.design(3,crossover,.70710678,0,rate);
    }
    void process(float* l,float* r,int n)override{
        for(int i=0;i<n;++i){double x=l[i]*(phaseL_?-1:1),y=r[i]*(phaseR_?-1:1);if(swap_)std::swap(x,y);
            // A complementary Linkwitz-Riley split avoids the crossover boost
            // caused by subtracting a phase-shifted low-pass from raw dry audio.
            if(lowMono_){const double a=low_[0][1].tick(low_[0][0].tick(x)),b=low_[1][1].tick(low_[1][0].tick(y)),mid=(a+b)*.5;x=high_[0][1].tick(high_[0][0].tick(x))+mid;y=high_[1][1].tick(high_[1][0].tick(y))+mid;}
            const double mid=(x+y)*.5,side=(x-y)*.5*width_.next();x=mid+side;y=mid-side;
            // Channel conversion is part of the mix; monitor modes override it only in preview.
            if(channelMode_==1)x=y=mid;else if(channelMode_==2)x=y=side;else if(channelMode_==3)y=x;else if(channelMode_==4)x=y;
            const double monitorMid=channelMode_==0?mid:(x+y)*.5,monitorSide=channelMode_==0?side:(x-y)*.5;
            if(mono_||listen_==1)x=y=monitorMid;else if(listen_==2)x=y=monitorSide;else if(listen_==3)y=x;else if(listen_==4)x=y;
            const double bal=balance_.next(),g=gain_.next();x*=g*(bal>0?1-bal:1);y*=g*(bal<0?1+bal:1);l[i]=static_cast<float>(x);r[i]=static_cast<float>(y);
        }
    }
    void reset()override{for(auto& ch:low_)for(auto& f:ch)f.reset();for(auto& ch:high_)for(auto& f:ch)f.reset();gain_.reset();balance_.reset();width_.reset();}
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Stereo&>(source);for(int ch=0;ch<2;++ch){inheritFilters(low_[ch],old.low_[ch]);inheritFilters(high_[ch],old.high_[ch]);}inheritSlew(gain_,old.gain_);inheritSlew(balance_,old.balance_);inheritSlew(width_,old.width_);}
};

class Limiter final : public Processor {
    static constexpr int radius_=32, taps_=radius_*2, phases_=8, ramp_=32;
    static constexpr int truePeakLatency_=taps_+2*(ramp_-1);
    struct Peak {double value=0;std::int64_t index=0;};
    struct TruePeakState {
        std::array<float,taps_*2> samples{};
        std::array<std::array<double,ramp_>,2> ramp{};
        std::array<double,2> sum{{ramp_,ramp_}};
        std::size_t cursor=0,rampCursor=0;
        TruePeakState(){for(auto& stage:ramp)stage.fill(1);}
        double reconstruct(float x,const std::array<std::array<float,taps_>,phases_-1>& coefficients){
            samples[cursor]=samples[cursor+taps_]=x;
            cursor=(cursor+1)%taps_;
            const auto* signal=samples.data()+cursor;
            double peak=std::abs(signal[radius_-1]);
            for(const auto& kernel:coefficients){
                float value=0;
                for(int k=0;k<taps_;++k)value+=kernel[k]*signal[k];
                peak=std::max(peak,double(std::abs(value)));
            }
            return peak;
        }
        double smooth(double gain){
            for(int stage=0;stage<2;++stage){
                double& previous=ramp[stage][rampCursor];
                sum[stage]=std::max(0.,sum[stage]+gain-previous);previous=gain;gain=sum[stage]/ramp_;
            }
            rampCursor=(rampCursor+1)%ramp_;
            return clamp(gain,0,1);
        }
    };
    static const auto& reconstructionFilter(){
        static const auto kernel=[](){
            std::array<std::array<float,taps_>,phases_-1> result{};
            for(int phase=1;phase<phases_;++phase){
                std::array<double,taps_> raw{};double sum=0;
                for(int k=0;k<taps_;++k){
                    const double t=k-radius_+1-double(phase)/phases_;
                    raw[k]=std::sin(pi*t)/(pi*t)*(.5+.5*std::cos(pi*t/radius_));sum+=raw[k];
                }
                for(int k=0;k<taps_;++k)result[phase-1][k]=static_cast<float>(raw[k]/sum);
            }
            return result;
        }();
        return kernel;
    }
    std::array<Ring,2> delay_;std::array<std::vector<Peak>,2> maxima_;
    std::array<TruePeakState,2> peakState_;
    std::size_t head_[2]{},tail_[2]{};std::int64_t sample_=0;int delaySamples_;
    double ceiling_,effectiveCeiling_,release_,link_,gain_[2]{1,1},applied_[2]{1,1};bool autoRelease_,truePeak_;
    Slew input_,output_;
    void add(int ch,double v){auto& q=maxima_[ch];const auto cap=q.size();while(head_[ch]!=tail_[ch]){const auto back=(tail_[ch]+cap-1)%cap;if(q[back].value>v)break;tail_[ch]=back;}q[tail_[ch]]={v,sample_};tail_[ch]=(tail_[ch]+1)%cap;while(head_[ch]!=tail_[ch]&&q[head_[ch]].index<sample_-delaySamples_)head_[ch]=(head_[ch]+1)%cap;}
    static bool useTruePeak(const EffectSpec& s){return param(s,"truePeak",0,0,1)>.5;}
    static int delaySamples(const EffectSpec& s,double rate){return static_cast<int>(std::round(param(s,"lookaheadMs",5,0,20)*rate*.001))+(useTruePeak(s)?truePeakLatency_:0);}
    void configure(const EffectSpec& s,double rate,bool immediate){
        const double ceilingDb=param(s,"ceilingDb",-1,-24,0);
        ceiling_=dbGain(ceilingDb);
        // Allow for peaks between the 8脳 phases, FIR estimation and PCM quantization.
        effectiveCeiling_=truePeak_?dbGain(ceilingDb-.4):ceiling_;
        release_=coeffMs(param(s,"releaseMs",100,5,2000),rate);
        link_=param(s,"stereoLink",100,0,100)/100;
        autoRelease_=param(s,"autoRelease",0,0,1)>.5;
        setSlew(input_,dbGain(param(s,"inputDb",0,0,24)),rate,15,immediate);
        setSlew(output_,dbGain(param(s,"outputDb",0,-24,0)),rate,15,immediate);
    }
public:
    Limiter(const EffectSpec& s,double rate):delaySamples_(delaySamples(s,rate)),truePeak_(useTruePeak(s)){
        configure(s,rate,true);
        if(truePeak_)(void)reconstructionFilter();
        for(int ch=0;ch<2;++ch){delay_[ch].prepare(static_cast<std::size_t>(delaySamples_)+4);maxima_[ch].resize(static_cast<std::size_t>(delaySamples_)+3);}
    }
    bool configure(const EffectSpec& s,double rate){if(truePeak_!=useTruePeak(s)||delaySamples_!=delaySamples(s,rate))return false;configure(s,rate,false);return true;}
    void process(float* l,float* r,int n)override{
        for(int i=0;i<n;++i){const double in=input_.next(),out=output_.next();double x[2]={l[i]*in,r[i]*in};
            for(int ch=0;ch<2;++ch){
                delay_[ch].push(x[ch]);add(ch,truePeak_?peakState_[ch].reconstruct(static_cast<float>(x[ch]),reconstructionFilter()):std::abs(x[ch]));
            }
            const double peak[2]={maxima_[0][head_[0]].value,maxima_[1][head_[1]].value},linked=std::max(peak[0],peak[1]);double y[2];
            for(int ch=0;ch<2;++ch){
                // Link blends attenuation, then clamps against each channel's
                // own peak. Partial stereo link can NEVER weaken the ceiling.
                const double own=std::min(1.0,effectiveCeiling_/std::max(1e-12,peak[ch])),both=std::min(1.0,effectiveCeiling_/std::max(1e-12,linked));
                const double target=own+(both-own)*link_;double release=release_;
                if(autoRelease_)release=std::pow(release,1/clamp(2-gain_[ch],1,2));
                gain_[ch]=target<gain_[ch]?target:target+release*(gain_[ch]-target);
                // The rounded ramp settles before the input starts contributing to a true peak.
                applied_[ch]=truePeak_?peakState_[ch].smooth(gain_[ch]):gain_[ch];
                const double delayed=delaySamples_?delay_[ch].read(delaySamples_+1):x[ch];
                const double value=delayed*applied_[ch]*out;
                y[ch]=truePeak_?value:clamp(value,-ceiling_,ceiling_);
            }l[i]=static_cast<float>(y[0]);r[i]=static_cast<float>(y[1]);++sample_;
        }
    }
    void reset()override{for(auto& d:delay_)d.reset();head_[0]=head_[1]=tail_[0]=tail_[1]=0;gain_[0]=gain_[1]=applied_[0]=applied_[1]=1;sample_=0;if(truePeak_)peakState_={};input_.reset();output_.reset();}
    int latency()const override{return delaySamples_;}
    std::int64_t tail()const override{return delaySamples_;}
    double reduction()const override{return -gainDb(std::min(applied_[0],applied_[1]));}
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Limiter&>(source);if(delaySamples_==old.delaySamples_&&truePeak_==old.truePeak_){delay_=old.delay_;maxima_=old.maxima_;peakState_=old.peakState_;for(int ch=0;ch<2;++ch){head_[ch]=old.head_[ch];tail_[ch]=old.tail_[ch];gain_[ch]=old.gain_[ch];applied_[ch]=old.applied_[ch];}sample_=old.sample_;}inheritSlew(input_,old.input_);inheritSlew(output_,old.output_);}
};

class Meter final : public Processor {
    double rate_,smoothing_,holdSeconds_;int fftSize_,hop_=0,position_=0;
    std::array<std::vector<double>,3> windows_;
    std::size_t windowPos_=0;double sums_[3]{},weightedSum_=0;
    std::vector<double> weighted_,fftInput_,fftInputRight_,hann_;std::vector<std::complex<double>> fft_;
    std::array<std::array<Biquad,2>,2> k_;
    double held_[2]{},hold_[2]{};DspMeasurement measurement_;
    void fft(){
        // Pack two real transforms into a single complex FFT. Taking stereo
        // energy avoids both anti-phase cancellation and right-only rectifying.
        for(int i=0;i<fftSize_;++i)fft_[i]={fftInput_[(position_+i)%fftSize_]*hann_[i],fftInputRight_[(position_+i)%fftSize_]*hann_[i]};
        for(int i=1,j=0;i<fftSize_;++i){int bit=fftSize_>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)std::swap(fft_[i],fft_[j]);}
        for(int len=2;len<=fftSize_;len<<=1){const std::complex<double> step(std::cos(-2*pi/len),std::sin(-2*pi/len));for(int i=0;i<fftSize_;i+=len){std::complex<double>w(1,0);for(int j=0;j<len/2;++j){const auto u=fft_[i+j],v=fft_[i+j+len/2]*w;fft_[i+j]=u+v;fft_[i+j+len/2]=u-v;w*=step;}}}
        const double ceiling=rate_*.5,ratio=ceiling/20;
        for(int band=0;band<128;++band){const double low=20*std::pow(ratio,static_cast<double>(band)/128),high=20*std::pow(ratio,static_cast<double>(band+1)/128);int first=std::max(1,static_cast<int>(std::floor(low*fftSize_/rate_))),last=std::min(fftSize_/2,static_cast<int>(std::ceil(high*fftSize_/rate_)));double value=0;for(int bin=first;bin<=last;++bin){const auto a=(fft_[bin]+std::conj(fft_[(fftSize_-bin)%fftSize_]))*.5,b=(fft_[bin]-std::conj(fft_[(fftSize_-bin)%fftSize_]))*std::complex<double>(0,-.5);value=std::max(value,std::sqrt((std::norm(a)+std::norm(b))*.5)*4/fftSize_);}const double c=std::exp(-static_cast<double>(fftSize_/4)/(smoothing_*rate_));measurement_.spectrum[band]=static_cast<float>(value+(measurement_.spectrum[band]-value)*c);}
    }
public:
    Meter(const EffectSpec& s,double rate):rate_(rate),smoothing_(std::max(.000001,param(s,"smoothingMs",250,0,2000)*.001)),holdSeconds_(param(s,"peakHoldMs",2000,0,10000)*.001),fftSize_(1024<<static_cast<int>(param(s,"fftSize",1,0,3))){
        const auto window=static_cast<std::size_t>(std::ceil(rate*.4));for(auto& w:windows_)w.assign(window,0);weighted_.assign(window,0);fftInput_.assign(fftSize_,0);fftInputRight_.assign(fftSize_,0);hann_.resize(fftSize_);fft_.resize(fftSize_);
        for(int i=0;i<fftSize_;++i)hann_[i]=.5-.5*std::cos(2*pi*i/(fftSize_-1));
        for(auto& ch:k_){ch[0].design(2,1681.974,.707175,4,rate);ch[1].design(3,38.135,.500327,0,rate);}
    }
    void process(float* l,float* r,int n)override{
        const double decay=dbGain(-24/rate_);for(int i=0;i<n;++i){const double x[2]={l[i],r[i]},square[3]={x[0]*x[0],x[1]*x[1],x[0]*x[1]};
            for(int ch=0;ch<3;++ch){sums_[ch]+=square[ch]-windows_[ch][windowPos_];windows_[ch][windowPos_]=square[ch];}
            double energy=0;for(int ch=0;ch<2;++ch){const double v=k_[ch][1].tick(k_[ch][0].tick(x[ch]));energy+=v*v;const double p=std::abs(x[ch]);if(p>=held_[ch]){held_[ch]=p;hold_[ch]=holdSeconds_*rate_;}else if(hold_[ch]>0)--hold_[ch];else held_[ch]*=decay;}
            weightedSum_+=energy-weighted_[windowPos_];weighted_[windowPos_]=energy;if(++windowPos_==weighted_.size())windowPos_=0;
            fftInput_[position_]=x[0];fftInputRight_[position_]=x[1];if(++position_==fftSize_)position_=0;
            ++measurement_.samples;if(++hop_==fftSize_/4){hop_=0;fft();}
        }
        const double count=static_cast<double>(std::min<std::uint64_t>(measurement_.samples,weighted_.size()));
        if(count>0){measurement_.rmsLeft=std::sqrt(std::max(0.0,sums_[0]/count));measurement_.rmsRight=std::sqrt(std::max(0.0,sums_[1]/count));measurement_.correlation=clamp(sums_[2]/std::sqrt(std::max(1e-24,sums_[0]*sums_[1])),-1,1);measurement_.kWeightedDb=10*std::log10(std::max(1e-12,weightedSum_/count));}
        measurement_.peakLeft=held_[0];measurement_.peakRight=held_[1];measurement_.crestDb=gainDb(std::max(held_[0],held_[1]))-gainDb(std::max(measurement_.rmsLeft,measurement_.rmsRight));
    }
    void reset()override{for(auto& w:windows_)std::fill(w.begin(),w.end(),0);std::fill(weighted_.begin(),weighted_.end(),0);std::fill(fftInput_.begin(),fftInput_.end(),0);std::fill(fftInputRight_.begin(),fftInputRight_.end(),0);for(auto& ch:k_)for(auto& f:ch)f.reset();measurement_={};windowPos_=position_=hop_=0;sums_[0]=sums_[1]=sums_[2]=weightedSum_=held_[0]=held_[1]=hold_[0]=hold_[1]=0;}
    DspMeasurement measurement()const{return measurement_;}
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Meter&>(source);windows_=old.windows_;weighted_=old.weighted_;windowPos_=old.windowPos_;weightedSum_=old.weightedSum_;measurement_=old.measurement_;for(int ch=0;ch<3;++ch)sums_[ch]=old.sums_[ch];for(int ch=0;ch<2;++ch){inheritFilters(k_[ch],old.k_[ch]);held_[ch]=old.held_[ch];hold_[ch]=old.hold_[ch];}if(fftSize_==old.fftSize_){fftInput_=old.fftInput_;fftInputRight_=old.fftInputRight_;position_=old.position_;hop_=old.hop_;}}
};
} // namespace dsp_detail

#include "convolution.h"
#include "modulation.h"
#include "denoise.h"
#include "character-effects.h"

class EffectChain {
    using Vst3Factory=std::unique_ptr<dsp_detail::Processor>(*)(const EffectSpec&,double,int,bool,double,double);
    using Vst3Configure=void(*)(dsp_detail::Processor&,const EffectSpec&,double,double);
    double rate_=48000,tempo_=120;int maxBlock_=512;bool prepared_=false;
    double barBeats_=4;
    std::int64_t nextTimeline_=0;
    std::vector<std::unique_ptr<dsp_detail::Processor>> processors_;
    std::vector<EffectSpec> specs_;
    std::vector<EffectMeasurement> effectReadings_;
    std::unique_ptr<dsp_detail::Meter> outputMeter_;
    dsp_detail::Meter* explicitMeter_=nullptr;
    int latency_=0;std::int64_t tail_=0;
    using MeterCallback=void(*)(void*,const char*,const float*,const float*,int);
    MeterCallback meterCallback_=nullptr;void* meterCallbackUser_=nullptr;
    using InputCallback=void(*)(void*,const float*,const float*,int);
    InputCallback inputCallback_=nullptr;void* inputCallbackUser_=nullptr;std::string inputEffect_;
    using SidechainReader=dsp_detail::SidechainBlockView(*)(void*,const std::string&,const std::string&,std::int64_t,int);
    SidechainReader sidechainReader_=nullptr;void* sidechainContext_=nullptr;std::string sidechainOwner_;
    Vst3Factory vst3Factory_=nullptr;
    Vst3Configure vst3Configure_=nullptr;
    bool offline_=true;
public:
    EffectChain()=default;
    EffectChain(EffectChain&&)=default;EffectChain& operator=(EffectChain&&)=default;
    EffectChain(const EffectChain&)=delete;EffectChain& operator=(const EffectChain&)=delete;
    // Callback runs synchronously at the analyzer's actual insertion point.
    // The host must keep user data alive and implement a non-blocking callback.
    void setMeterCallback(void(*callback)(void*,const char*,const float*,const float*,int),void* user){meterCallback_=callback;meterCallbackUser_=user;}
    void tapEffectInput(std::string id,InputCallback callback,void* user){inputEffect_=std::move(id);inputCallback_=callback;inputCallbackUser_=user;}
    void setSidechainReader(SidechainReader reader,void* context,std::string owner={}){
        sidechainReader_=reader;sidechainContext_=context;sidechainOwner_=std::move(owner);
    }
    void setVst3Host(Vst3Factory factory,Vst3Configure configure,bool offline){
        vst3Factory_=factory;vst3Configure_=configure;offline_=offline;
    }
    dsp_detail::Processor* findVst3(const std::string& id) const {
        for(std::size_t i=0;i<specs_.size();++i)
            if(specs_[i].id==id&&specs_[i].type=="vst3")return processors_[i].get();
        return nullptr;
    }
    int effectInputLatency(const std::string& id)const{
        int delay=0;
        for(std::size_t i=0;i<processors_.size();++i){if(specs_[i].id==id)return delay;delay+=processors_[i]->latency();}
        return -1;
    }
    void listenRemoved(const std::string& id){
        for(std::size_t i=0;i<processors_.size();++i)if(specs_[i].type=="denoise")processors_[i]->setListenRemoved(specs_[i].id==id);
    }
    void prepare(double rate,int maxBlock=512,bool meterOutput=true){
        if(!std::isfinite(rate)||rate<8000||rate>384000||maxBlock<1)throw std::invalid_argument("invalid DSP sample rate or block size");
        rate_=rate;maxBlock_=maxBlock;prepared_=true;processors_.clear();specs_.clear();effectReadings_.clear();latency_=0;tail_=0;explicitMeter_=nullptr;nextTimeline_=0;
        outputMeter_.reset();if(meterOutput){EffectSpec meter;meter.type="meter";outputMeter_=std::make_unique<dsp_detail::Meter>(meter,rate_);}
    }
    void setEffects(const std::vector<EffectSpec>& effects,double bpm=120,double barBeats=4){
        using namespace dsp_detail;if(!prepared_)prepare(rate_,maxBlock_);bpm=clamp(std::isfinite(bpm)?bpm:120,20,400);
        // Session edits also resend unaffected tracks. Keep their processors and
        // large delay buffers intact, with no rebuild or history copy.
        auto samePlugin=[](const EffectSpec& a,const EffectSpec& b){return a.vst3ClassId==b.vst3ClassId&&a.vst3ModulePath==b.vst3ModulePath;};
        auto same=[&](const EffectSpec& a,const EffectSpec& b){return a.id==b.id&&a.type==b.type&&a.params==b.params&&a.noiseProfile==b.noiseProfile&&a.sidechainTrackId==b.sidechainTrackId&&samePlugin(a,b)&&a.vst3EditsSeen==b.vst3EditsSeen;};
        auto tempoChanged=[&](const EffectSpec& spec){
            if(spec.type=="vst3")return tempo_!=bpm||barBeats_!=barBeats;
            return param(spec,"sync",0,0,1)>.5&&((spec.type=="delay"&&tempo_!=bpm)||(spec.type=="modulation"&&(tempo_!=bpm||barBeats_!=barBeats)));
        };
        bool unchanged=true;std::size_t enabled=0;
        for(const auto& spec:effects)if(spec.enabled){if(enabled>=specs_.size()||!same(spec,specs_[enabled])||tempoChanged(spec))unchanged=false;++enabled;}
        if(unchanged&&enabled==specs_.size()){tempo_=bpm;barBeats_=barBeats;return;}
        std::vector<std::unique_ptr<Processor>> next;next.reserve(effects.size());std::vector<EffectSpec> nextSpecs;std::vector<EffectMeasurement> readings;Meter* meter=nullptr;int latency=0;std::int64_t tail=0;std::vector<bool> used(processors_.size(),false);
        for(const auto& s:effects){if(!s.enabled)continue;std::unique_ptr<Processor> p;
            std::size_t previous=specs_.size();for(std::size_t old=0;old<specs_.size();++old)if(!used[old]&&specs_[old].id==s.id&&specs_[old].type==s.type){previous=old;break;}
            if(previous<specs_.size()&&same(s,specs_[previous])&&!tempoChanged(s)){p=std::move(processors_[previous]);used[previous]=true;}
            else if(previous<specs_.size()&&s.type=="delay"){p=std::move(processors_[previous]);static_cast<Delay*>(p.get())->configure(s,rate_,bpm);used[previous]=true;}
            else if(previous<specs_.size()&&s.type=="reverb"){p=std::move(processors_[previous]);static_cast<Reverb*>(p.get())->configure(s,rate_);used[previous]=true;}
            else if(s.type=="convolution"){
                if(previous<specs_.size()&&static_cast<Convolution*>(processors_[previous].get())->configure(s,rate_)){p=std::move(processors_[previous]);used[previous]=true;}
                else p=std::make_unique<Convolution>(s,rate_);
            }
            else if(previous<specs_.size()&&s.type=="multiband"){p=std::move(processors_[previous]);static_cast<MultibandCompressor*>(p.get())->configure(s);used[previous]=true;}
            else if(s.type=="ducker"){
                if(previous<specs_.size()){
                    p=std::move(processors_[previous]);
                    static_cast<Ducker*>(p.get())->configure(s,false,s.sidechainTrackId!=specs_[previous].sidechainTrackId);
                    used[previous]=true;
                }else p=std::make_unique<Ducker>(s,rate_);
            }
            else if(s.type=="modulation"){
                const auto seamless=[&]{const auto& old=specs_[previous];return param(s,"mode",0)==param(old,"mode",0)&&param(s,"stages",1)==param(old,"stages",1)&&param(s,"sync",0)==param(old,"sync",0);};
                if(previous<specs_.size()&&seamless()&&barBeats_==barBeats){p=std::move(processors_[previous]);static_cast<Modulation*>(p.get())->configure(s,bpm);used[previous]=true;}
                else p=std::make_unique<Modulation>(s,rate_,bpm,barBeats);
            }
            else if(s.type=="denoise"){
                const auto modes=denoiseModes(s);
                if(previous<specs_.size()&&denoiseModes(specs_[previous])==modes&&(!modes.spectral||specs_[previous].noiseProfile.empty()==s.noiseProfile.empty())){p=std::move(processors_[previous]);static_cast<Denoise*>(p.get())->configure(s);used[previous]=true;}
                else p=std::make_unique<Denoise>(s,rate_);
            }
            else if(s.type=="lofi"){
                if(previous<specs_.size()&&static_cast<Lofi*>(processors_[previous].get())->configure(s)){p=std::move(processors_[previous]);used[previous]=true;}
                else p=std::make_unique<Lofi>(s,rate_);
            }
            else if(s.type=="pedal"){
                if(previous<specs_.size()&&static_cast<Pedal*>(processors_[previous].get())->configure(s)){p=std::move(processors_[previous]);used[previous]=true;}
                else p=std::make_unique<Pedal>(s,rate_);
            }
            else if(s.type=="eq")p=std::make_unique<Equalizer>(s,rate_);
            else if(s.type=="multiband")p=std::make_unique<MultibandCompressor>(s,rate_);
            else if(s.type=="compressor")p=std::make_unique<Compressor>(s,rate_);
            else if(s.type=="transient")p=std::make_unique<TransientShaper>(s,rate_);
            else if(s.type=="gate")p=std::make_unique<Gate>(s,rate_);
            else if(s.type=="deesser")p=std::make_unique<Deesser>(s,rate_);
            else if(s.type=="reverb")p=std::make_unique<Reverb>(s,rate_);
            else if(s.type=="delay")p=std::make_unique<Delay>(s,rate_,bpm);
            else if(s.type=="saturation")p=std::make_unique<Saturation>(s,rate_);
            else if(s.type=="stereo")p=std::make_unique<Stereo>(s,rate_);
            else if(s.type=="limiter"){
                if(previous<specs_.size()&&static_cast<Limiter*>(processors_[previous].get())->configure(s,rate_)){p=std::move(processors_[previous]);used[previous]=true;}
                else p=std::make_unique<Limiter>(s,rate_);
            }
            else if(s.type=="meter"){auto m=std::make_unique<Meter>(s,rate_);meter=m.get();p=std::move(m);}
            else if(s.type=="vst3"){
                if(!vst3Factory_||!vst3Configure_)throw std::invalid_argument("VST3 is unavailable on this effect chain");
                if(previous<specs_.size()&&samePlugin(specs_[previous],s)){
                    vst3Configure_(*processors_[previous],s,bpm,barBeats);
                    p=std::move(processors_[previous]);used[previous]=true;
                }else p=vst3Factory_(s,rate_,maxBlock_,offline_,bpm,barBeats);
            }
            else throw std::invalid_argument("unknown built-in DSP type: "+s.type);
            if(previous<specs_.size()&&!used[previous]){p->inheritState(*processors_[previous]);used[previous]=true;}
            if(s.type=="meter")meter=static_cast<Meter*>(p.get());
            latency+=p->latency();tail+=p->tail();next.push_back(std::move(p));nextSpecs.push_back(s);EffectMeasurement reading;reading.id=s.id;readings.push_back(reading);
        }
        processors_=std::move(next);specs_=std::move(nextSpecs);effectReadings_=std::move(readings);explicitMeter_=meter;latency_=latency;tail_=tail;tempo_=bpm;barBeats_=barBeats;
    }
    void process(float* left,float* right,int frames,bool measure=true,bool analyze=true,std::int64_t timeline=std::numeric_limits<std::int64_t>::min()){
        if(frames<=0)return;if(!prepared_||!left||!right)return;
        if(timeline==std::numeric_limits<std::int64_t>::min())timeline=nextTimeline_;
        nextTimeline_=timeline+frames;
        for(int offset=0;offset<frames;offset+=maxBlock_){const int n=std::min(maxBlock_,frames-offset);float* l=left+offset;float* r=right+offset;
            for(int i=0;i<n;++i){l[i]=dsp_detail::clean(l[i]);r[i]=dsp_detail::clean(r[i]);}
            double peak=0,energy=0;
            auto scan=[&](){peak=energy=0;for(int i=0;i<n;++i){l[i]=dsp_detail::clean(l[i]);r[i]=dsp_detail::clean(r[i]);if(measure){peak=std::max(peak,double(std::max(std::abs(l[i]),std::abs(r[i]))));energy+=double(l[i])*l[i]+double(r[i])*r[i];}}};
            if(measure&&!processors_.empty())scan();
            auto stageSample=timeline+offset;
            for(std::size_t stage=0;stage<processors_.size();++stage){
                auto& reading=effectReadings_[stage];
                if(measure){reading.inputPeak=peak;reading.inputRms=std::sqrt(energy/(2*n));}
                if(inputCallback_&&inputEffect_==specs_[stage].id)inputCallback_(inputCallbackUser_,l,r,n);
                processors_[stage]->setTimelineSample(stageSample);
                const auto& spec=specs_[stage];
                if(spec.type=="ducker"){
                    const auto key=sidechainReader_
                        ?sidechainReader_(sidechainContext_,spec.sidechainTrackId,sidechainOwner_,stageSample,n):dsp_detail::SidechainBlockView{};
                    static_cast<dsp_detail::Ducker*>(processors_[stage].get())->processKeyed(l,r,n,key);
                }else if(spec.type!="meter"||analyze)processors_[stage]->process(l,r,n);
                stageSample-=processors_[stage]->latency();
                if(analyze&&meterCallback_&&specs_[stage].type=="meter")meterCallback_(meterCallbackUser_,specs_[stage].id.c_str(),l,r,n);
                scan();
                if(measure){reading.outputPeak=peak;reading.outputRms=std::sqrt(energy/(2*n));processors_[stage]->measureGain(reading);}
            }
            if(analyze&&outputMeter_)outputMeter_->process(l,r,n);
        }
    }
    void reset(){nextTimeline_=0;for(auto& p:processors_)p->reset();if(outputMeter_)outputMeter_->reset();clearEffectReadings();}
    // Reset the analyzers without erasing the audible delay, filter or dynamics state.
    void resetMeasurements(){for(std::size_t i=0;i<processors_.size();++i)if(specs_[i].type=="meter")processors_[i]->reset();if(outputMeter_)outputMeter_->reset();clearEffectReadings();}
    int latencySamples()const{return latency_;}
    std::int64_t tailSamples()const{return tail_;}
    double sampleRate()const{return rate_;}
    DspMeasurement measurement()const{DspMeasurement m;if(outputMeter_)m=outputMeter_->measurement();for(const auto& p:processors_)m.gainReductionDb=std::max(m.gainReductionDb,p->reduction());return m;}
    DspMeasurement effectMeasurement()const{return explicitMeter_?explicitMeter_->measurement():measurement();}
    DspMeasurement getMeasurement()const{return measurement();}
    const std::vector<EffectMeasurement>& effectMeasurements()const{return effectReadings_;}
    std::vector<EffectMeterMeasurement> meterMeasurements()const{std::vector<EffectMeterMeasurement> readings;for(std::size_t i=0;i<processors_.size();++i)if(specs_[i].type=="meter")readings.push_back({specs_[i].id,static_cast<const dsp_detail::Meter*>(processors_[i].get())->measurement()});return readings;}
    bool effectMeterMeasurement(const std::string& id,DspMeasurement& reading)const{for(std::size_t i=0;i<processors_.size();++i)if(specs_[i].type=="meter"&&specs_[i].id==id){reading=static_cast<const dsp_detail::Meter*>(processors_[i].get())->measurement();return true;}return false;}
private:
    void clearEffectReadings(){for(auto& m:effectReadings_){m.inputPeak=m.outputPeak=m.inputRms=m.outputRms=m.gainReductionDb=m.transientGainDb=0;m.sidechainInputDb=m.duckerKeyDb=m.duckerProgramDb=-120;m.bandReductionDb.fill(0);m.multibandReductionDb.fill(0);}}
};
} // namespace visiki
