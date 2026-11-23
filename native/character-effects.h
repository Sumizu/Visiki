#pragma once
// Included from dsp.h inside namespace visiki, after dsp_detail::Processor.
// All buffers and coefficient tables are prepared on the control thread.
namespace dsp_detail {

class Lofi final : public Processor {
    double rate_;
    int style_, delaySamples_;
    std::int64_t position_=0;
    std::uint64_t seed_=14695981039346656037ULL;
    std::array<Ring,2> tape_;
    std::array<Biquad,2> low_, high_, anti_, anti2_, reconstruction_;
    Slew amount_, mix_, tone_, saturation_, wow_, flutter_, noise_, crackle_;
    Slew bits_, sampleRate_, smooth_, mono_;
    double env_=0, held_[2]{}, digitalPhase_=0;
    bool digitalStarted_=false;
    static int style(const EffectSpec& s){return static_cast<int>(param(s,"style",0,0,3));}
    static std::uint64_t hash(std::uint64_t x){
        x+=0x9e3779b97f4a7c15ULL; x=(x^(x>>30))*0xbf58476d1ce4e5b9ULL;
        x=(x^(x>>27))*0x94d049bb133111ebULL; return x^(x>>31);
    }
    static double random(std::uint64_t x){return static_cast<double>(hash(x)>>11)*(1.0/9007199254740992.0);}
    void setup(const EffectSpec& s,bool immediate){
        auto set=[&](Slew& p,double value){setSlew(p,value,rate_,20,immediate);};
        set(amount_,param(s,"amount",50,0,100)*.01);set(mix_,param(s,"mix",65,0,100)*.01);
        set(tone_,param(s,"tone",0,-100,100)*.01);set(saturation_,param(s,"saturation",25,0,100)*.01);
        set(wow_,param(s,"wow",15,0,100)*.01);set(flutter_,param(s,"flutter",10,0,100)*.01);
        set(noise_,dbGain(param(s,"noiseDb",-55,-70,-24)));set(crackle_,param(s,"crackle",22,0,100)*.01);
        set(bits_,param(s,"bits",10,4,16));set(sampleRate_,std::min(rate_,param(s,"rateHz",11000,2000,24000)));
        set(smooth_,param(s,"smooth",1,0,1));set(mono_,param(s,"mono",1,0,1));
        const double t=param(s,"tone",0,-100,100)*.01;
        const double lowCut=style_==3?param(s,"lowCutHz",300,80,800):(style_==1?45:18);
        const double highCut=style_==3?param(s,"highCutHz",3600,1000,12000):
                             style_==0?11000*std::pow(2.,t):style_==1?9000*std::pow(2.,t):rate_*.475;
        const double antiCut=std::min(rate_*.475,param(s,"rateHz",11000,2000,24000)*.43);
        for(int ch=0;ch<2;++ch){low_[ch].design(3,lowCut,.7071,0,rate_,immediate);
            high_[ch].design(4,highCut,.7071,0,rate_,immediate);anti_[ch].design(4,antiCut,.7071,0,rate_,immediate);
            anti2_[ch].design(4,antiCut,.7071,0,rate_,immediate);reconstruction_[ch].design(4,antiCut,.7071,0,rate_,immediate);}
    }
public:
    Lofi(const EffectSpec& s,double rate):rate_(rate),style_(style(s)),delaySamples_(style_==0?std::max(2,static_cast<int>(std::ceil(rate*.006))):0){
        for(unsigned char c:s.id){seed_^=c;seed_*=1099511628211ULL;}
        if(delaySamples_)for(auto& d:tape_)d.prepare(static_cast<std::size_t>(delaySamples_*2+8));
        setup(s,true);
    }
    bool configure(const EffectSpec& s){if(style(s)!=style_)return false;setup(s,false);return true;}
    void setTimelineSample(std::int64_t sample) override {position_=sample;}
    void process(float* left,float* right,int frames) override {
        const double attack=coeffMs(8,rate_),release=coeffMs(180,rate_);
        for(int i=0;i<frames;++i,++position_){
            const double source[2]={clean(left[i]),clean(right[i])};
            const double level=std::max(std::abs(source[0]),std::abs(source[1]));
            const double ec=level>env_?attack:release;env_=undenormal(level+ec*(env_-level));
            const double activity=clamp(env_*12,0,1);
            const double amount=amount_.next(), mix=mix_.next(),tone=tone_.next(),sat=saturation_.next();
            const double wow=wow_.next(),flutter=flutter_.next(),noise=noise_.next(),crackle=crackle_.next();
            const double bits=bits_.next(),sr=sampleRate_.next(),smooth=smooth_.next(),mono=mono_.next();
            double dry[2]={source[0],source[1]}, wet[2]={source[0],source[1]};
            if(style_==0){
                const double seconds=static_cast<double>(position_)/rate_;
                const double shift=rate_*(.0028*wow*std::sin(2*pi*.31*seconds)+.00045*flutter*std::sin(2*pi*5.2*seconds));
                for(int ch=0;ch<2;++ch){tape_[ch].push(source[ch]);dry[ch]=tape_[ch].read(delaySamples_+1.);
                    wet[ch]=tape_[ch].read(delaySamples_+1.+shift);}
            }
            if(style_==2){
                // Absolute position anchors the sample-and-hold schedule across block sizes and seeks.
                const double phase=static_cast<double>(position_)*sr/rate_;
                const double fraction=phase-std::floor(phase);
                const bool capture=!digitalStarted_||sr>=rate_||fraction<digitalPhase_;
                const double bitFloor=std::floor(bits), blend=bits-bitFloor;
                const double levels=std::exp2(bitFloor-1);
                for(int ch=0;ch<2;++ch){const double filtered=anti2_[ch].tick(anti_[ch].tick(source[ch]));
                    if(capture){const double v=source[ch]+smooth*(filtered-source[ch]);const double bounded=clamp(v,-1.,1.);const double coarse=std::round(bounded*levels)/levels;
                        const double fine=std::round(bounded*levels*2)/(levels*2);held_[ch]=coarse+blend*(fine-coarse);}
                    const double reconstructed=reconstruction_[ch].tick(held_[ch]);wet[ch]=held_[ch]+smooth*(reconstructed-held_[ch]);}
                digitalPhase_=fraction;digitalStarted_=true;
            }else{
                if(style_==3){const double mid=(wet[0]+wet[1])*.5;for(double& x:wet)x+=mono*(mid-x);}
                for(int ch=0;ch<2;++ch){
                    double x=high_[ch].tick(low_[ch].tick(wet[ch]));
                    if(style_==0||style_==3){const double drive=1+sat*(style_==0?2.5:1.8);
                        x+=sat*(std::tanh(x*drive)/std::tanh(drive)-x);}
                    if(style_==1||style_==3){
                        const auto p=static_cast<std::uint64_t>(position_)^seed_;
                        const double n=(random(p*2+static_cast<std::uint64_t>(ch)+0x12345)-.5)*3.464101615;
                        x+=noise*activity*n;
                        if(style_==1&&random(p+0xa1234)<crackle*7/rate_)
                            x+=(random(p+0x98123)*2-1)*activity*(.04+.18*crackle);
                    }
                    if(style_==3)x*=std::pow(2.,tone*.3);
                    wet[ch]=x;
                }
            }
            for(int ch=0;ch<2;++ch){const double y=dry[ch]+mix*amount*(wet[ch]-dry[ch]);
                (ch?right:left)[i]=static_cast<float>(std::isfinite(y)?y:0.);}
        }
    }
    void reset() override {for(auto& d:tape_)if(!d.data.empty())d.reset();for(auto& f:low_)f.reset();for(auto& f:high_)f.reset();for(auto& f:anti_)f.reset();for(auto& f:anti2_)f.reset();for(auto& f:reconstruction_)f.reset();
        env_=held_[0]=held_[1]=digitalPhase_=0;digitalStarted_=false;position_=0;
        for(Slew* s:{&amount_,&mix_,&tone_,&saturation_,&wow_,&flutter_,&noise_,&crackle_,&bits_,&sampleRate_,&smooth_,&mono_})s->reset();}
    int latency()const override{return delaySamples_;}
    std::int64_t tail()const override{
        if(mix_.target==0||amount_.target==0)return 0;
        return static_cast<std::int64_t>(rate_*(style_==1||style_==3?1.5:.08));
    }
    void inheritState(const Processor& source) override {
        const auto& old=static_cast<const Lofi&>(source);
        if(style_==old.style_){tape_=old.tape_;inheritFilters(low_,old.low_);inheritFilters(high_,old.high_);inheritFilters(anti_,old.anti_);inheritFilters(anti2_,old.anti2_);inheritFilters(reconstruction_,old.reconstruction_);
            env_=old.env_;held_[0]=old.held_[0];held_[1]=old.held_[1];digitalPhase_=old.digitalPhase_;digitalStarted_=old.digitalStarted_;position_=old.position_;}
        Slew* dst[]={&amount_,&mix_,&tone_,&saturation_,&wow_,&flutter_,&noise_,&crackle_,&bits_,&sampleRate_,&smooth_,&mono_};
        const Slew* src[]={&old.amount_,&old.mix_,&old.tone_,&old.saturation_,&old.wow_,&old.flutter_,&old.noise_,&old.crackle_,&old.bits_,&old.sampleRate_,&old.smooth_,&old.mono_};
        for(int i=0;i<12;++i)inheritSlew(*dst[i],*src[i]);
    }
};

class Pedal final : public Processor {
    // Blackman-windowed interpolation/decimation FIRs. Both filters have an
    // eight-sample base-rate group delay, so the exact total latency is 16.
    static constexpr int maxFactor_=4, baseTaps_=16, maxTaps_=baseTaps_*maxFactor_+1;
    struct Fir {std::array<double,maxTaps_> history{};int cursor=0;
        void push(double x,int n){history[cursor]=x;if(++cursor==n)cursor=0;}
        double tick(const std::array<double,maxTaps_>& h,int n)const {double y=0;int p=cursor;
            for(int k=0;k<n;++k){if(--p<0)p=n-1;y+=h[k]*history[p];}return y;}
        double interpolate(const std::array<double,maxTaps_>& h,int n,int factor,int phase)const {
            double y=0;int p=cursor-1-phase;while(p<0)p+=n;
            for(int k=phase;k<n;k+=factor){y+=h[k]*history[p];p-=factor;while(p<0)p+=n;}return y;}};
    double rate_;int mode_,factor_,taps_;
    std::array<double,maxTaps_> kernel_{};
    std::array<Fir,2> up_,down_;
    std::array<Ring,2> dry_;
    std::array<Biquad,2> pre_,low_,wetLow_,cabHigh_,cabLow_,toneFilter_;
    Slew input_,drive_,cab_,mix_,lowKeep_,output_;
    static int mode(const EffectSpec& s){return static_cast<int>(param(s,"mode",0,0,2));}
    static int factor(const EffectSpec& s){return param(s,"oversample",1,1,2)<1.5?2:4;}
    void setup(const EffectSpec& s,bool immediate){
        auto set=[&](Slew& v,double x){setSlew(v,x,rate_,20,immediate);};
        set(input_,param(s,"inputDb",0,-18,18));set(drive_,param(s,"driveDb",6,0,30));
        set(mix_,param(s,"mix",100,0,100)*.01);
        set(lowKeep_,param(s,"lowKeep",0,0,100)*.01);set(output_,param(s,"outputDb",0,-24,12));
        const int cab=static_cast<int>(param(s,"cab",0,0,4));set(cab_,cab?1.:0.);
        const double lowHz=param(s,"lowHz",130,70,250);
        const double hp[]={20,100,75,85,45},lp[]={18000,4300,5700,4800,3500};
        for(int ch=0;ch<2;++ch){low_[ch].design(4,lowHz,.7071,0,rate_,immediate);wetLow_[ch].design(4,lowHz,.7071,0,rate_,immediate);
            pre_[ch].design(3,mode_==0?24:mode_==1?60:96,.7071,0,rate_,immediate);
            cabHigh_[ch].design(3,hp[cab],.7071,0,rate_,immediate);cabLow_[ch].design(4,lp[cab],.7071,0,rate_,immediate);
            toneFilter_[ch].design(2,1800,.7071,param(s,"tone",0,-100,100)*.07,rate_,immediate);}
    }
    double shape(double x,double gain)const {
        x*=gain;
        if(mode_==0)return std::tanh(x*.5)*2.;
        if(mode_==1)return std::tanh(x*1.25)*.8;
        return std::atan(x*2.)*(2./pi);
    }
public:
    Pedal(const EffectSpec& s,double rate):rate_(rate),mode_(mode(s)),factor_(factor(s)),taps_(baseTaps_*factor_+1){
        double sum=0;const int center=(taps_-1)/2;
        for(int k=0;k<taps_;++k){const int n=k-center;const double fc=.45/factor_;
            const double sinc=n==0?2*fc:std::sin(2*pi*fc*n)/(pi*n);
            const double window=.42-.5*std::cos(2*pi*k/(taps_-1))+.08*std::cos(4*pi*k/(taps_-1));
            kernel_[k]=sinc*window;sum+=kernel_[k];}
        for(int k=0;k<taps_;++k)kernel_[k]/=sum;
        for(auto& d:dry_)d.prepare(20);setup(s,true);
    }
    bool configure(const EffectSpec& s){if(mode(s)!=mode_||factor(s)!=factor_)return false;setup(s,false);return true;}
    void process(float* left,float* right,int frames)override{
        for(int i=0;i<frames;++i){const double in[2]={clean(left[i]),clean(right[i])};
            const double ing=dbGain(input_.next()),gain=dbGain(drive_.next()),mix=mix_.next(),keep=lowKeep_.next(),out=dbGain(output_.next()),cab=cab_.next();
            const double normalization=std::pow(gain,mode_==0?-.55:mode_==1?-.38:-.25);
            for(int ch=0;ch<2;++ch){dry_[ch].push(in[ch]);const double dry=dry_[ch].read(17),low=low_[ch].tick(dry);
                const double input=pre_[ch].tick(in[ch]*ing)*factor_;
                double wet=0;
                for(int phase=0;phase<factor_;++phase){
                    up_[ch].push(phase==0?input:0.,taps_);
                    const double u=up_[ch].interpolate(kernel_,taps_,factor_,phase);
                    down_[ch].push(shape(u,gain)*normalization,taps_);
                    if(phase==0)wet=down_[ch].tick(kernel_,taps_);
                }
                wet=toneFilter_[ch].tick(wet);const double boxed=cabLow_[ch].tick(cabHigh_[ch].tick(wet));
                wet+=cab*(boxed-wet);const double processedLow=wetLow_[ch].tick(wet);wet+=keep*(low-processedLow);
                const double y=(dry+mix*(wet-dry))*out;(ch?right:left)[i]=static_cast<float>(std::isfinite(y)?y:0.);
            }
        }
    }
    void reset()override{up_={};down_={};for(auto& d:dry_)d.reset();for(auto* pair:{&pre_,&low_,&wetLow_,&cabHigh_,&cabLow_,&toneFilter_})for(auto& f:*pair)f.reset();
        for(Slew* s:{&input_,&drive_,&cab_,&mix_,&lowKeep_,&output_})s->reset();}
    int latency()const override{return baseTaps_;}
    std::int64_t tail()const override{return mix_.target==0?0:baseTaps_+static_cast<std::int64_t>(rate_*.1);}
    void inheritState(const Processor& source)override{const auto& old=static_cast<const Pedal&>(source);
        if(factor_==old.factor_){up_=old.up_;down_=old.down_;dry_=old.dry_;inheritFilters(pre_,old.pre_);inheritFilters(low_,old.low_);inheritFilters(wetLow_,old.wetLow_);inheritFilters(cabHigh_,old.cabHigh_);inheritFilters(cabLow_,old.cabLow_);inheritFilters(toneFilter_,old.toneFilter_);}
        Slew* dst[]={&input_,&drive_,&cab_,&mix_,&lowKeep_,&output_};const Slew* src[]={&old.input_,&old.drive_,&old.cab_,&old.mix_,&old.lowKeep_,&old.output_};
        for(int i=0;i<6;++i)inheritSlew(*dst[i],*src[i]);}
};
} // namespace dsp_detail



