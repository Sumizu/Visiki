// Build: cl /std:c++17 /EHsc /O2 tests/native-dsp-fixture.cpp /Fe:native-dsp-fixture.exe
#include "../native/dsp.h"
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <new>
#include <random>

static bool watchAllocations=false;
static bool watchLargestAllocation=false;
static std::size_t allocationCount=0;
static std::size_t largestAllocation=0;
void* operator new(std::size_t n){if(watchAllocations)++allocationCount;if(watchLargestAllocation)largestAllocation=std::max(largestAllocation,n);if(void* p=std::malloc(n?n:1))return p;throw std::bad_alloc();}
void* operator new[](std::size_t n){return ::operator new(n);}
void operator delete(void* p) noexcept{std::free(p);}
void operator delete[](void* p) noexcept{std::free(p);}
void operator delete(void* p,std::size_t) noexcept{std::free(p);}
void operator delete[](void* p,std::size_t) noexcept{std::free(p);}

namespace {
constexpr double rate=48000;
int checks=0;
void expect(bool okay,const char* message){++checks;if(!okay)throw std::runtime_error(message);}
visiki::EffectSpec effect(std::string type,std::map<std::string,double> params={}){return {type,type,true,std::move(params)};}
struct Audio{std::vector<float> l,r;explicit Audio(int n):l(n),r(n){};};
Audio sine(double hz,double amplitude=1,int frames=48000,double rightScale=1){Audio a(frames);for(int i=0;i<frames;++i){a.l[i]=static_cast<float>(amplitude*std::sin(2*visiki::dsp_detail::pi*hz*i/rate));a.r[i]=a.l[i]*static_cast<float>(rightScale);}return a;}
double rms(const std::vector<float>& a,int begin=0,int end=-1){if(end<0)end=static_cast<int>(a.size());double energy=0;for(int i=begin;i<end;++i)energy+=static_cast<double>(a[i])*a[i];return std::sqrt(energy/std::max(1,end-begin));}
double peak(const std::vector<float>& a){double p=0;for(float v:a)p=std::max(p,std::abs(static_cast<double>(v)));return p;}
double amplitudeAt(const std::vector<float>& a,double hz,int begin=24000){std::complex<double> sum;for(int i=begin;i<static_cast<int>(a.size());++i)sum+=static_cast<double>(a[i])*std::polar(1.,-2*visiki::dsp_detail::pi*hz*i/rate);return std::abs(sum)*2/(a.size()-begin);}
void run(visiki::EffectChain& c,Audio& a,int block=512){for(int i=0;i<static_cast<int>(a.l.size());i+=block)c.process(a.l.data()+i,a.r.data()+i,std::min(block,static_cast<int>(a.l.size())-i));}
visiki::EffectChain chain(const std::vector<visiki::EffectSpec>& fx){visiki::EffectChain c;c.prepare(rate);c.setEffects(fx);return c;}
void finite(const Audio& a){for(std::size_t i=0;i<a.l.size();++i)if(!std::isfinite(a.l[i])||!std::isfinite(a.r[i]))throw std::runtime_error("non-finite output");++checks;}
struct MeterHooks{double peak[2]{};std::uint64_t samples[2]{};};
void meterHook(void* user,const char* id,const float* left,const float*,int frames){auto& hooks=*static_cast<MeterHooks*>(user);const int slot=std::strcmp(id,"first")==0?0:1;for(int i=0;i<frames;++i)hooks.peak[slot]=std::max(hooks.peak[slot],std::abs(static_cast<double>(left[i])));hooks.samples[slot]+=frames;}
}

int main(){try{
    {
        auto spec=effect("ducker",{{"thresholdDb",-30},{"depthDb",12},{"attackMs",10},{"holdMs",50},{"releaseMs",35}});
        visiki::dsp_detail::Ducker ducker(spec,rate);
        Audio program(48000);
        std::vector<float> key(program.l.size(),0.f);
        std::fill(program.l.begin(),program.l.end(),.4f);
        std::fill(program.r.begin(),program.r.end(),.1f);
        std::fill(key.begin()+4800,key.begin()+14400,.3f);
        const auto before=allocationCount;
        watchAllocations=true;
        ducker.processKeyed(program.l.data(),program.r.data(),18000,{key.data()});
        visiki::EffectMeasurement metered;ducker.measureGain(metered);
        ducker.processKeyed(program.l.data()+18000,program.r.data()+18000,30000,{key.data()+18000});
        ducker.reset();
        watchAllocations=false;
        expect(allocationCount==before,"ducking allocates while processing");
        expect(program.l[4799]==.4f&&program.l[4801]<.4f&&program.l[4801]>.395f,"ducking has no smooth attack or triggers early");
        expect(std::abs(program.l[10000]/.4-std::pow(10.,-.6))<.001,"ducking fails to reach its requested depth");
        expect(metered.hasSidechain&&metered.sidechainInputDb<-20&&metered.gainReductionDb>11.9,"ducking loses attenuation during its hold");
        expect(std::abs(program.r[10000]/program.l[10000]-.25)<1e-6,"ducking changes the stereo balance");
        expect(std::abs(program.l[46000]-.4)<1e-6,"ducking does not release");
        const float dry=program.l[4799];
        ducker.process(program.l.data()+4799,program.r.data()+4799,1);
        expect(program.l[4799]==dry&&ducker.reduction()==0,"a missing sidechain changes the audio");
    }
    {
        // Opt-in activity follows sustained broadband vocal energy through short
        // pauses, then lets a harmony return to unity after the lead stops.
        const auto spec=effect("ducker",{{"mode",1},{"smoothTrigger",1},{"thresholdDb",-38},{"depthDb",9},{"marginDb",2},{"attackMs",20},{"holdMs",120},{"releaseMs",180}});
        visiki::dsp_detail::Ducker duck(spec,rate);
        const int frames=static_cast<int>(rate)*2;
        auto voice=sine(400,.10,frames);Audio harmony(frames);
        std::fill(harmony.l.begin(),harmony.l.end(),.3f);std::fill(harmony.r.begin(),harmony.r.end(),.3f);
        std::fill(voice.l.begin()+14400,voice.l.begin()+15360,0.f);std::fill(voice.r.begin()+14400,voice.r.begin()+15360,0.f);
        std::fill(voice.l.begin()+28800,voice.l.end(),0.f);std::fill(voice.r.begin()+28800,voice.r.end(),0.f);
        std::vector<float> peaks(frames),powers(frames);
        for(int i=0;i<frames;++i){peaks[i]=std::abs(voice.l[i]);powers[i]=voice.l[i]*voice.l[i];}
        const auto before=allocationCount;watchAllocations=true;
        duck.processKeyed(harmony.l.data(),harmony.r.data(),15360,{peaks.data(),powers.data()});
        const double duringPause=duck.reduction();
        duck.processKeyed(harmony.l.data()+15360,harmony.r.data()+15360,frames-15360,{peaks.data()+15360,powers.data()+15360});
        watchAllocations=false;
        expect(allocationCount==before,"smooth adaptive ducking allocates while processing");
        expect(duringPause>5,"smooth vocal activity loses attenuation during a short pause");
        expect(harmony.l[50400]>.23,"smooth harmony ducking holds beyond the phrase");
        expect(std::abs(harmony.l.back()-.3)<.003,"smooth harmony ducking does not release after the lead stops");
        finite(harmony);
    }
    {
        // Strong speech outside the selected band must not create a full cut.
        const auto spec=effect("ducker",{{"mode",2},{"smoothTrigger",1},{"thresholdDb",-38},{"depthDb",9},{"marginDb",3},{"bandHz",1800},{"bandQ",1},{"attackMs",20}});
        auto bandReduction=[&](double hz){
            visiki::dsp_detail::Ducker duck(spec,rate);auto program=sine(1800,.4),voice=sine(hz,.15);
            std::vector<float> peaks(48000),powers(48000);
            for(int i=0;i<48000;++i){peaks[i]=std::abs(voice.l[i]);powers[i]=voice.l[i]*voice.l[i];}
            duck.processKeyed(program.l.data(),program.r.data(),48000,{peaks.data(),powers.data(),1,1,voice.l.data(),voice.r.data()});
            finite(program);return duck.reduction();
        };
        expect(bandReduction(1800)>3,"smooth band ducking misses voice in the selected band");
        expect(bandReduction(80)<.2,"smooth band ducking overreacts to voice outside the selected band");
    }
    {
        auto a=sine(1000,.2),original=a;auto c=chain({});run(c,a,137);
        expect(a.l==original.l&&a.r==original.r,"empty graph changes audio");
        c.setEffects({effect("stereo",{{"gainDb",6}})});a=sine(1000,.1);run(c,a);expect(std::abs(rms(a.l,24000)-.1/std::sqrt(2)*std::pow(10,.3))<1e-5,"stereo gain dB mapping");
    }
    {
        auto c=chain({effect("eq",{{"band1Enabled",1},{"band1Freq",1000},{"band1Gain",6},{"band1Q",1}})});auto a=sine(1000,.1);run(c,a);
        expect(std::abs(20*std::log10(rms(a.l,24000)/(.1/std::sqrt(2)))-6)<.05,"EQ Bell gain at centre");
        c=chain({effect("eq",{{"band1Enabled",1},{"band1Freq",1000},{"band1Type",3},{"band1Slope",3}})});a=sine(100,.2);run(c,a);expect(rms(a.l,24000)<1e-6,"EQ 48dB/oct high-pass attenuation");
    }
    {
        const auto fx=effect("eq",{{"band1Enabled",1},{"band1Freq",3000},{"band1Q",4},{"band1Dyn",1},{"band1Threshold",-28},{"band1Range",6},{"band1Attack",6},{"band1Release",60}});
        auto c=chain({fx});auto quiet=sine(3000,.012),quietReference=quiet;
        run(c,quiet,373);expect(quiet.l==quietReference.l&&quiet.r==quietReference.r,"dynamic EQ changes below-threshold audio");
        auto offBand=sine(100,.4),offBandReference=offBand;c.reset();run(c,offBand);
        expect(offBand.l==offBandReference.l&&c.effectMeasurements()[0].bandReductionDb[0]==0,"strong off-band content triggers dynamic EQ");
        auto loud=sine(3000,.4,48000,-1),loudReference=loud;c.reset();run(c,loud,57);
        const auto m=c.effectMeasurements()[0];const auto db=20*std::log10(rms(loud.l,24000)/rms(loudReference.l,24000));
        expect(m.hasBandReduction&&std::abs(m.bandReductionDb[0]-6)<.01&&std::abs(db+6)<.03,"dynamic EQ gain does not match its band telemetry or range");
        expect(std::abs(rms(loud.r,24000)-rms(loud.l,24000))<1e-7,"dynamic EQ does not link stereo gain");
        auto rightOnly=sine(3000,.4);std::fill(rightOnly.l.begin(),rightOnly.l.end(),0.f);c.reset();run(c,rightOnly);
        expect(c.effectMeasurements()[0].bandReductionDb[0]>5.9&&peak(rightOnly.l)==0,"dynamic EQ misses right-only detector content or leaks audio");
        auto recovered=quietReference;run(c,recovered);
        expect(c.effectMeasurements()[0].bandReductionDb[0]<.015&&std::abs(rms(recovered.l,36000)/rms(quietReference.l,36000)-1)<.003,"dynamic EQ attenuation does not release after a loud tone");
        c.reset();auto byFrame=loudReference,byBlock=loudReference;auto d=chain({fx});
        const auto before=allocationCount;watchAllocations=true;run(c,byFrame,1);run(d,byBlock,733);c.reset();watchAllocations=false;
        expect(allocationCount==before&&byFrame.l==byBlock.l&&byFrame.r==byBlock.r,"dynamic EQ allocates or varies with block size/reset");
        auto shelf=fx;shelf.params["band1Type"]=2;shelf.params["band1Freq"]=4000;d=chain({shelf});
        auto top=sine(10000,.4);run(d,top);expect(d.effectMeasurements()[0].bandReductionDb[0]>5.9&&rms(top.l,24000)<.18,"dynamic high shelf does not attenuate high frequencies");
        shelf.params["soloBand"]=1;auto solo=sine(4000,.4);d=chain({shelf});run(d,solo);
        expect(!d.effectMeasurements()[0].hasBandReduction&&amplitudeAt(solo.l,4000)>.399,"EQ solo is changed by dynamics");
    }
    {
        // Neutral LR4 recombination should retain unity magnitude at all sample rates,
        // including frequencies close to both crossovers and the low-rate Nyquist limit.
        for(double sr:{8000.,11025.,44100.,48000.}){
            for(double hz:{31.,100.,160.,250.,800.,1600.,3200.,3700.}){
                if(hz>=sr*.475)continue;
                const int count=static_cast<int>(sr*2);Audio a(count);
                for(int i=0;i<count;++i)a.l[i]=a.r[i]=static_cast<float>(.3*std::sin(2*visiki::dsp_detail::pi*hz*i/sr));
                const double input=rms(a.l,count/2);visiki::EffectChain c;c.prepare(sr,512,false);c.setEffects({effect("multiband")});run(c,a,173);
                expect(std::abs(rms(a.l,count/2)/input-1)<.004,"multiband neutral crossover magnitude is not unity");
                expect(c.latencySamples()==0,"multiband reports a fixed sample delay");
            }
        }
        for(int band=0;band<3;++band){
            auto fx=effect("multiband",{{"band1AttackMs",1},{"band2AttackMs",1},{"band3AttackMs",1}});
            const auto prefix="band"+std::to_string(band+1);fx.params[prefix+"Ratio"]=8;fx.params[prefix+"ThresholdDb"]=-35;
            const double hz=band==0?50:band==1?800:10000;
            auto c=chain({fx});auto a=sine(hz,.5,48000,.25),reference=a;run(c,a,137);
            const auto m=c.effectMeasurements()[0];
            expect(m.hasMultibandReduction&&m.multibandReductionDb[band]>8&&rms(a.l,24000)<rms(reference.l,24000)*.5,"multiband selected band does not compress");
            expect(std::abs(rms(a.r,24000)/rms(a.l,24000)-.25)<1e-6,"multiband stereo compression is not linked");
            for(int other=0;other<3;++other)if(other!=band)expect(m.multibandReductionDb[other]<.01,"multiband reports gain reduction on a neutral band");
            fx.params["mix"]=0;c=chain({fx});a=reference;run(c,a);
            auto neutral=reference;auto d=chain({effect("multiband")});run(d,neutral);
            expect(a.l==neutral.l&&a.r==neutral.r,"multiband dry mix has mismatched crossover phase");
        }
        auto fx=effect("multiband",{{"band2Ratio",6},{"band2ThresholdDb",-30}});
        auto first=sine(800,.4),second=first;auto c=chain({fx}),d=chain({fx});
        const auto before=allocationCount;watchAllocations=true;run(c,first,1);run(d,second,733);c.reset();watchAllocations=false;
        expect(allocationCount==before&&first.l==second.l&&first.r==second.r,"multiband allocates or varies with block size");
        auto c1=chain({fx}),c2=chain({fx});auto warm=sine(800,.4,12000),warm2=warm;run(c1,warm);run(c2,warm2);
        fx.params["outputDb"]=6;fx.params["crossoverLowHz"]=250;fx.params["band2Ratio"]=4;c1.setEffects({fx});
        auto after=sine(800,.4,48000),control=after;run(c1,after,127);run(c2,control,127);
        expect(std::abs(after.l[0]-control.l[0])<.01&&rms(after.l,36000)>rms(control.l,36000)*1.9,"multiband live edit resets state or fails to converge");
        finite(after);
    }
    {
        auto spec = effect("convolution", {{"mix", 0}});
        auto dry = chain({spec});
        Audio input(1500);
        input.l[10] = .5f;
        input.r[20] = -.25f;
        run(dry, input, 131);
        expect(dry.latencySamples() == 512 && dry.tailSamples() == 0, "convolution dry latency or tail is incorrect");
        expect(input.l[522] == .5f && input.r[532] == -.25f, "convolution dry sample is shifted incorrectly");

        spec.params["mix"] = 100;
        Audio room(106000);
        for (int space = 0; space < 4; ++space) {
            spec.params["space"] = space;
            auto wet = chain({spec});
            Audio impulse(106000);
            impulse.l[0] = 1;
            run(wet, impulse, 317);
            if (peak(impulse.l) <= .02 || peak(impulse.r) <= .005)
                std::cerr << "Convolution space " << space << ", left peak " << peak(impulse.l) << ", right peak " << peak(impulse.r) << '\n';
            expect(peak(impulse.l) > .02 && peak(impulse.r) > .005, "convolution does not create stereo reflections from a panned source");
            expect(rms(impulse.l, 512 + 3000, 512 + 10000) > .0001, "convolution diffuse tail is missing");
            if (space == 0) room = impulse;
            else expect(impulse.l != room.l && wet.tailSamples() > 21600, "convolution space reuses the same impulse response");
            finite(impulse);
        }
        spec.params["space"] = 0;
        auto wet = chain({spec});
        Audio split(29000), together(29000);
        split.l[0] = together.l[0] = 1;
        split.l[817] = together.l[817] = .5f;
        const auto before = allocationCount;
        watchAllocations = true;
        run(wet, split, 1);
        wet.reset();
        run(wet, together, 733);
        watchAllocations = false;
        expect(allocationCount == before && split.l == together.l && split.r == together.r, "convolution allocates or varies with block size or reset");
        double error = 0;
        for (int i = 0; i < static_cast<int>(together.l.size()); ++i) {
            const double expected = room.l[i] + (i < 817 ? 0 : .5 * room.l[i - 817]);
            error = std::max(error, std::abs(together.l[i] - expected));
        }
        expect(error < 2e-6, "convolution does not sum shifted impulses linearly across blocks");
        spec.params["preDelayMs"] = 50;
        auto predelayed = chain({spec});
        Audio impulse(9000);
        impulse.l[0] = 1;
        run(predelayed, impulse);
        error = 0;
        for (int i = 2400; i < static_cast<int>(impulse.l.size()); ++i) error = std::max(error, std::abs(static_cast<double>(impulse.l[i] - room.l[i - 2400])));
        expect(rms(impulse.l, 0, 512 + 2400) < 1e-8 && error < 2e-6, "convolution pre-delay also changes the impulse shape");
    }
    {
        for(double sr:{8000.,44100.,48000.,96000.,192000.}){
            const auto exercise=[&](const visiki::EffectSpec& spec){
                constexpr int count=5731;
                Audio original(count);
                for(int i=0;i<count;++i){original.l[i]=.2f*static_cast<float>(std::sin(2*visiki::dsp_detail::pi*777*i/sr));original.r[i]=original.l[i]*.7f;}
                auto buffered=original,single=original;
                visiki::EffectChain a,b;
                for(auto* chain:{&a,&b}){chain->prepare(sr,512,false);chain->setEffects({spec});}
                const auto before=allocationCount;
                watchAllocations=true;
                run(a,buffered,511);run(b,single,1);a.reset();
                watchAllocations=false;
                expect(allocationCount==before,"creative DSP allocates while processing");
                for(int i=0;i<count;++i){
                    if(std::abs(buffered.l[i]-single.l[i])>2e-6f||std::abs(buffered.r[i]-single.r[i])>2e-6f)
                        throw std::runtime_error("creative effect depends on caller block size");
                }
                ++checks;
                expect(peak(buffered.l)>1e-4&&peak(buffered.l)<4&&buffered.l!=original.l,"creative effect produces invalid or unchanged audio");
                finite(buffered);
            };
            for(int mode=0;mode<5;++mode)
                exercise(effect("modulation",{{"mode",mode},{"sync",1},{"note",9},{"feedback",-80},{"depth",100}}));
            for(int style=0;style<4;++style)exercise(effect("lofi",{{"style",style},{"amount",100},{"mix",100}}));
            for(int mode=0;mode<3;++mode)exercise(effect("pedal",{{"mode",mode},{"oversample",2},{"cab",4}}));
        }
    }
    {
        auto input=Audio(48000);
        std::mt19937 rng(19);
        for(int i=0;i<48000;++i)input.l[i]=static_cast<float>((double(rng())/4294967296.-.5)*.02);
        input.r=input.l;
        auto source=input,wet=input,removed=input;
        visiki::dsp_detail::DenoiseProfileAnalysis analyzer(rate);
        analyzer.push(input.l.data(),input.r.data(),static_cast<int>(input.l.size()));
        auto spec=effect("denoise");spec.noiseProfile=analyzer.finish();
        expect(spec.noiseProfile.size()==128,"noise profile analysis did not yield 128 bands");
        auto normal=chain({spec}),listen=chain({spec});
        listen.listenRemoved(spec.id);listen.reset();
        const auto before=allocationCount;
        watchAllocations=true;run(normal,wet,109);run(listen,removed,527);watchAllocations=false;
        expect(allocationCount==before,"noise reduction allocates while processing");
        expect(rms(wet.l,12000)/rms(removed.l,12000)<.9,"noise removal does not isolate audible residual");
        double error=0;
        for(int i=4096;i<48000;++i)error=std::max(error,std::abs(double(wet.l[i]+removed.l[i]-source.l[i-2048])));
        expect(error<2e-8,"noise residual and processed audio do not reconstruct the aligned dry input");
    }
    {
        // All combinations, including partial overrides of legacy sessions.
        for (int legacy=0; legacy<3; ++legacy) {
            auto old=effect("denoise",{{"repairMode",legacy}});
            auto explicitModes=old;
            explicitModes.params["spectralEnabled"]=legacy==0;
            explicitModes.params["humEnabled"]=legacy==1;
            explicitModes.params["dereverbEnabled"]=legacy==2;
            auto a=sine(50,.2,10000),b=a;
            auto c=chain({old}),d=chain({explicitModes}); run(c,a);run(d,b);
            expect(c.latencySamples()==d.latencySamples()&&a.l==b.l,"legacy denoise mode changed");
            auto partial=old;partial.params["humEnabled"]=1;
            const auto modes=visiki::dsp_detail::denoiseModes(partial);
            expect(modes.hum&&modes.spectral==(legacy==0)&&modes.dereverb==(legacy==2),"denoise switch fallback is not per key");
        }
        for (int mask=0;mask<8;++mask) {
            auto spec=effect("denoise",{{"spectralEnabled",double(mask&1)}, {"humEnabled",double((mask>>1)&1)}, {"dereverbEnabled",double((mask>>2)&1)}});
            spec.noiseProfile.assign(128,-50);
            auto source=sine(50,.2,16000),wet=source,removed=source,bySample=source;
            auto normal=chain({spec}),listen=chain({spec}),single=chain({spec});
            const int delay=((mask&1)?2048:0)+((mask&4)?2048:0);
            expect(normal.latencySamples()==delay,"combined denoise latency incorrect");
            listen.listenRemoved(spec.id);listen.reset();
            const auto before=allocationCount;
            watchAllocations=true;run(normal,wet,511);run(listen,removed,137);run(single,bySample,1);watchAllocations=false;
            expect(allocationCount==before,"combined denoise allocates while processing");
            double error=0,blockError=0;
            for(int i=std::max(delay,5000);i<16000;++i){
                error=std::max(error,std::abs(double(wet.l[i]+removed.l[i]-source.l[i-delay])));
                blockError=std::max(blockError,std::abs(double(wet.l[i]-bySample.l[i])));
            }
            expect(error<1e-6,"combined residual does not reconstruct aligned dry");
            expect(blockError<1e-6,"combined denoise depends on block size");
            auto dry=source;spec.params["mix"]=0;auto dryChain=chain({spec});run(dryChain,dry);
            double dryError=0;for(int i=delay;i<16000;++i)dryError=std::max(dryError,std::abs(double(dry.l[i]-source.l[i-delay])));
            expect(dryError<1e-7,"combined denoise dry mix is not aligned");
        }
    }
    {
        auto a=sine(1000,.2,24000,-.5);
        for(std::size_t i=0;i<a.l.size();++i){
            const float env=i<1200?float(i)/1200.f:static_cast<float>(std::exp(-(double(i)-1200.)/(rate*.018)));
            a.l[i]*=env;a.r[i]*=env;
        }
        auto reference=a;auto c=chain({effect("transient")});run(c,a,101);
        expect(c.latencySamples()==0&&a.l==reference.l&&a.r==reference.r,"neutral transient shaper changes audio or latency");
        auto sharper=reference,softer=reference,tighter=reference,longer=reference;
        auto attackUp=effect("transient",{{"attack",60}});c=chain({attackUp});run(c,sharper);
        c=chain({effect("transient",{{"attack",-60}})});run(c,softer);
        c=chain({effect("transient",{{"sustain",-60}})});run(c,tighter);
        c=chain({effect("transient",{{"sustain",60}})});run(c,longer);
        expect(rms(sharper.l,200,1000)>rms(reference.l,200,1000)*1.4&&rms(softer.l,200,1000)<rms(reference.l,200,1000)*.8,"attack control does not change the onset in both directions");
        expect(rms(tighter.l,2400,4200)<rms(reference.l,2400,4200)*.8&&rms(longer.l,2400,4200)>rms(reference.l,2400,4200)*1.2,"sustain control does not change the envelope tail in both directions");
        expect(std::abs(rms(tighter.r)/rms(tighter.l)-.5)<1e-7&&c.effectMeasurements()[0].hasTransientGain,"transient shaper breaks stereo balance or has no live gain telemetry");
        auto dry=reference;c=chain({effect("transient",{{"attack",100},{"sustain",100},{"mix",0}})});run(c,dry);
        expect(dry.l==reference.l&&dry.r==reference.r,"transient shaper dry mix is not transparent");
        auto bySample=reference,byBlock=reference;c=chain({attackUp});auto d=chain({attackUp});
        const auto before=allocationCount;watchAllocations=true;run(c,bySample,1);run(d,byBlock,733);c.reset();watchAllocations=false;
        expect(allocationCount==before&&bySample.l==byBlock.l&&bySample.r==byBlock.r,"transient shaper allocates or varies with processing block size");
    }
    {
        auto c=chain({effect("compressor",{{"thresholdDb",-24},{"ratio",4},{"attackMs",1},{"kneeDb",0}})});auto a=sine(1000,.5);run(c,a);
        expect(rms(a.l,24000)<.14,"compressor does not attenuate");expect(c.measurement().gainReductionDb>8,"compressor GR meter missing");
        c.setEffects({effect("compressor",{{"thresholdDb",-24},{"ratio",4},{"attackMs",1},{"mix",0}})});a=sine(1000,.5,48000);run(c,a);expect(std::abs(rms(a.l,36000)-.5/std::sqrt(2))<1e-5,"compressor dry parallel path");
    }
    {
        auto c=chain({effect("gate",{{"thresholdDb",-30},{"rangeDb",60},{"releaseMs",5}})});auto a=sine(1000,.001);run(c,a);expect(rms(a.l,24000)<2e-6,"gate below-threshold suppression");
        a=sine(1000,.4);run(c,a);expect(rms(a.l,24000)>.27,"gate does not reopen");
    }
    {
        const auto fx=effect("deesser",{{"freqHz",8000},{"thresholdDb",-40},{"rangeDb",12},{"mode",1}});auto a=sine(8000,.4),b=sine(500,.4);auto c=chain({fx});run(c,a);c.reset();run(c,b);
        expect(rms(a.l,24000)<rms(b.l,24000)*.75,"split deesser fails high-band suppression");expect(rms(b.l,24000)>.27,"split deesser damages low band");
    }
    {
        auto fx=effect("delay",{{"timeMs",10},{"timeRightMs",10},{"mix",100},{"feedback",50},{"pingPong",1},{"lowCutHz",20},{"highCutHz",20000}});auto c=chain({fx});Audio a(5000);a.l[0]=1;run(c,a);
        expect(std::abs(a.l[480]-.5)<1e-5,"delay time/ping-pong first repeat");expect(std::abs(a.r[960])>.1,"ping-pong cross feedback missing");expect(c.tailSamples()>480,"delay tail metadata missing");
        c=chain({effect("delay",{{"sync",1},{"noteL",6},{"noteR",6},{"feedback",0},{"mix",100}})});a=Audio(14000);a.l[0]=1;run(c,a);expect(a.l[12000]>.99,"tempo-synced eighth note at 120 BPM");
    }
    {
        auto fx=effect("reverb",{{"mix",100},{"decaySec",.8},{"preDelayMs",0}});auto c=chain({fx});Audio a(96000);a.l[0]=a.r[0]=1;run(c,a);
        expect(rms(a.l,1000,20000)>1e-5,"FDN reverb has no tail");expect(rms(a.l,72000)<rms(a.l,5000,25000)*.1,"FDN reverb does not decay");finite(a);
    }
    {
        auto base=effect("reverb",{{"mix",100},{"preDelayMs",0},{"lowCutHz",20},{"earlyMix",0},{"decaySec",2}});
        auto explicitDefaults=base;
        for(const auto& value:std::map<std::string,double>{{"diffusion",60},{"earlySize",100},{"modRateHz",.17},{"modDepthMs",.12},{"bassDecay",1},{"bassCrossHz",250},{"earlyPattern",0}})explicitDefaults.params[value.first]=value.second;
        Audio implicit(96000);implicit.l[0]=1;implicit.r[0]=.3f;auto explicitAudio=implicit;
        auto c=chain({base}),d=chain({explicitDefaults});run(c,implicit,137);run(d,explicitAudio,733);
        expect(implicit.l==explicitAudio.l&&implicit.r==explicitAudio.r,"explicit reverb defaults change legacy output");
        auto render=[&](const visiki::EffectSpec& fx){Audio a(96000);a.l[0]=1;a.r[0]=.3f;auto processor=chain({fx});run(processor,a);return a;};
        auto changed=base;changed.params["diffusion"]=0;auto lessDiffused=render(changed);
        expect(lessDiffused.l!=implicit.l,"diffusion does not affect the late reverb");
        changed=base;changed.params["modDepthMs"]=0;auto unmodulated=render(changed);
        changed.params["modDepthMs"]=1.2;changed.params["modRateHz"]=3;auto modulated=render(changed);
        expect(unmodulated.l!=modulated.l,"modulation depth does not affect the late reverb");
        changed.params["modRateHz"]=.05;auto slowModulation=render(changed);
        expect(slowModulation.l!=modulated.l,"modulation rate does not affect the late reverb");
        changed=base;changed.params["bassDecay"]=.25;changed.params["bassCrossHz"]=800;auto shortBass=render(changed);
        expect(rms(shortBass.l,24000,72000)<rms(implicit.l,24000,72000)*.95,"bass decay does not shorten low-frequency feedback");
        changed.params["bassCrossHz"]=80;auto lowCross=render(changed);
        expect(lowCross.l!=shortBass.l,"bass crossover does not alter the tail");
        base.params["earlyMix"]=100;auto early=render(base);
        for(int pattern=1;pattern<4;++pattern){changed=base;changed.params["earlyPattern"]=pattern;auto alternative=render(changed);expect(alternative.l!=early.l&&alternative.r!=early.r,"early pattern has no distinct stereo response");}
        changed=base;changed.params["earlySize"]=200;auto large=render(changed);
        expect(early.l!=large.l,"early size does not change reflection timing");
        changed.params["earlyPattern"]=2;changed.params["preDelayMs"]=250;changed.params["size"]=100;
        c=chain({changed});const auto earlyTail=c.tailSamples();auto last=render(changed);
        expect(earlyTail>24000&&earlyTail<rate&&peak(last.l)>1e-4,"early-only tail omits reflections or extends to the full late decay");
        changed.params["earlyMix"]=0;changed.params["decaySec"]=15;changed.params["diffusion"]=100;changed.params["modRateHz"]=3;changed.params["modDepthMs"]=1.2;changed.params["bassDecay"]=.25;changed.params["bassCrossHz"]=800;
        auto extreme=render(changed);finite(extreme);expect(peak(extreme.l)<10&&peak(extreme.r)<10,"maximum reverb parameters are unstable");
        base.params["earlyMix"]=0;c=chain({base});Audio priming(24000);priming.l[0]=1;run(c,priming);
        changed=base;changed.params["earlyPattern"]=3;changed.params["earlySize"]=200;changed.params["diffusion"]=100;changed.params["modDepthMs"]=1.2;changed.params["bassDecay"]=.25;
        largestAllocation=0;watchLargestAllocation=true;c.setEffects({changed});watchLargestAllocation=false;
        Audio live(48000);const auto before=allocationCount;watchAllocations=true;run(c,live,101);c.reset();watchAllocations=false;
        expect(largestAllocation<65536&&allocationCount==before&&rms(live.l)>1e-8,"reverb update loses tail or allocates audio history");
    }
    {
        for(int mode=0;mode<3;++mode){auto c=chain({effect("saturation",{{"mode",static_cast<double>(mode)},{"driveDb",18},{"oversample",0},{"dcBlock",0}})});auto a=sine(1000,.5);run(c,a);expect(peak(a.l)<=1.00001,"saturation transfer out of bounds");expect(std::abs(rms(a.l)-.5/std::sqrt(2))>.05,"saturation algorithm is a placeholder");}
        for(int os=1;os<3;++os){auto c=chain({effect("saturation",{{"oversample",static_cast<double>(os)},{"mix",0},{"outputDb",0}})});Audio a(64);a.l[0]=1;run(c,a);expect(c.latencySamples()==16&&a.l[16]==1&&a.l[0]==0,"oversampling dry latency alignment");}
        auto dryFx=effect("saturation",{{"oversample",1},{"mix",0},{"outputDb",0}});auto dry=chain({dryFx});
        Audio primed(128),afterSwitch(128);
        std::fill(primed.l.begin(),primed.l.end(),.3f);std::fill(afterSwitch.l.begin(),afterSwitch.l.end(),.3f);
        run(dry,primed);dryFx.params["oversample"]=2;dry.setEffects({dryFx});run(dry,afterSwitch);
        expect(std::all_of(afterSwitch.l.begin(),afterSwitch.l.end(),[](float value){return std::abs(value-.3f)<1e-7f;}),"2x to 4x at dry mix inserts silent samples");
        auto fx=effect("saturation",{{"mode",2},{"driveDb",18},{"oversample",0},{"outputDb",0},{"dcBlock",0}});auto a=sine(10000,.5),b=a;auto c=chain({fx});run(c,a);fx.params["oversample"]=2;c=chain({fx});run(c,b);expect(amplitudeAt(b.l,18000)<amplitudeAt(a.l,18000)*.6,"4x oversampling fails to reduce harmonic alias");
    }
    {
        auto c=chain({effect("stereo",{{"width",0}})});auto a=sine(1000,.2,4096,-1);run(c,a);expect(peak(a.l)<1e-8&&peak(a.r)<1e-8,"mono fold does not cancel anti-phase");
        c=chain({effect("stereo",{{"phaseLeft",1}})});a=sine(1000,.2,4096);run(c,a);expect(std::abs(a.l[12]+a.r[12])<1e-8,"polarity inversion failed");
        c=chain({effect("stereo",{{"monoBelowHz",200}})});a=sine(40,.5,48000,-1);run(c,a);expect(rms(a.l,24000)<.001,"low-frequency mono fails to remove bass side signal");c.reset();a=sine(200,.5);run(c,a);expect(std::abs(rms(a.l,24000)-.5/std::sqrt(2))<1e-4,"low mono split boosts crossover");
    }
    {
        for(double link:{0.,50.,100.}){auto c=chain({effect("limiter",{{"lookaheadMs",5},{"ceilingDb",-6},{"stereoLink",link}})});auto a=sine(1700,3);a.r[3000]=8;run(c,a,137);expect(peak(a.l)<=std::pow(10,-6./20)+1e-7&&peak(a.r)<=std::pow(10,-6./20)+1e-7,"limiter ceiling violated");expect(c.latencySamples()==240,"limiter latency wrong");}
        auto c=chain({effect("limiter",{{"lookaheadMs",5}})});Audio a(500);a.l[0]=.1f;run(c,a);expect(std::abs(a.l[240]-.1)<1e-6&&a.l[0]==0,"limiter actual delay disagrees with metadata");
    }
    {
        const auto fx=effect("limiter",{{"truePeak",1},{"lookaheadMs",0},{"ceilingDb",-3}});
        auto c=chain({fx});Audio a(512);a.l[1]=.1f;a.r[3]=-.2f;
        const int latency=c.latencySamples();run(c,a);
        expect(latency==126&&peak(a.l)==a.l[1+latency]&&std::abs(a.l[1+latency]-.1)<1e-7&&std::abs(a.r[3+latency]+.2)<1e-7,"true peak must preserve quiet input and report actual integer delay");
        auto x=sine(12000,2,16000,-1),y=x;auto d=chain({fx});
        const auto before=allocationCount;
        watchAllocations=true;c.reset();run(c,x,117);run(d,y,211);watchAllocations=false;
        expect(allocationCount==before&&x.l==y.l&&x.r==y.r,"true peak processing/reset depends on block size or allocates");
    }
    {
        auto c=chain({effect("meter",{{"smoothingMs",10}})});auto a=sine(1000,.5);auto original=a;run(c,a);const auto m=c.measurement();expect(a.l==original.l&&a.r==original.r,"meter changes sound");expect(std::abs(m.rmsLeft-.5/std::sqrt(2))<1e-4,"RMS measurement incorrect");expect(std::abs(m.correlation-1)<1e-6,"correlation measurement incorrect");expect(*std::max_element(m.spectrum.begin(),m.spectrum.end())>.45,"FFT spectrum missing");
        const auto readings=c.effectMeasurements();expect(readings.size()==1&&readings[0].id=="meter"&&readings[0].outputRms>.3,"per-effect readings unavailable");
        c.reset();a=sine(1000,.5,48000,-1);run(c,a);auto antiPhase=c.measurement();expect(*std::max_element(antiPhase.spectrum.begin(),antiPhase.spectrum.end())>.45&&antiPhase.correlation<-.999,"spectrum cancels anti-phase audio");c.reset();a=sine(1000,.5);std::fill(a.l.begin(),a.l.end(),0.f);run(c,a);const auto rightOnly=c.measurement();expect(*std::max_element(rightOnly.spectrum.begin(),rightOnly.spectrum.end())>.3,"right-only FFT missing");
    }
    {
        auto first=effect("meter"),second=first;first.id="first";second.id="second";auto c=chain({first,effect("stereo",{{"gainDb",-6}}),second});MeterHooks hooks;c.setMeterCallback(meterHook,&hooks);auto a=sine(1000,.5);const auto before=allocationCount;watchAllocations=true;run(c,a,733);watchAllocations=false;expect(allocationCount==before,"meter callback process allocates");expect(hooks.samples[0]==48000&&hooks.samples[1]==48000,"meter callback misses samples");expect(std::abs(hooks.peak[0]/hooks.peak[1]-std::pow(10,.3))<1e-5,"meter callback observes wrong insertion point");auto points=c.meterMeasurements();expect(points.size()==2&&points[0].id=="first"&&points[1].id=="second","per-node FFT readings missing");visiki::DspMeasurement one,two;expect(c.effectMeterMeasurement("first",one)&&c.effectMeterMeasurement("second",two)&&std::abs(one.rmsLeft/two.rmsLeft-std::pow(10,.3))<1e-5,"meter point measurements observe master output");
    }
    {
        const std::vector<visiki::EffectSpec> fx{effect("delay",{{"timeMs",20},{"timeRightMs",20},{"mix",50},{"feedback",50}}),effect("reverb",{{"mix",30},{"preDelayMs",0}}),effect("meter")};
        auto c=chain(fx),d=chain(fx);Audio input(512);input.l[0]=input.r[0]=1;auto reference=input;run(c,input);run(d,reference);
        expect(c.measurement().peakLeft>.1,"meter reset fixture was not primed");
        const auto before=allocationCount;watchAllocations=true;c.resetMeasurements();watchAllocations=false;
        expect(allocationCount==before,"meter-only reset allocates memory");visiki::DspMeasurement reading;
        expect(c.effectMeterMeasurement("meter",reading)&&reading.samples==0&&reading.peakLeft==0&&reading.rmsLeft==0&&*std::max_element(reading.spectrum.begin(),reading.spectrum.end())==0,"meter-only reset retains stale explicit readings");
        expect(c.measurement().samples==0&&c.measurement().peakLeft==0&&c.effectMeasurements()[0].outputPeak==0,"meter-only reset retains output/stage readings");
        const auto beforeUnchanged=allocationCount;watchAllocations=true;c.setEffects(fx);watchAllocations=false;
        expect(allocationCount==beforeUnchanged,"unchanged effect configuration allocates or rebuilds processors");
        auto changed=fx;changed.back().params["targetLufs"]=-20;c.setEffects(changed);
        Audio a(48000),b(48000);run(c,a);run(d,b);
        expect(a.l==b.l&&a.r==b.r&&rms(a.l)>1e-5,"meter reset or another processor update changes unchanged delay/reverb tails");
        expect(c.effectMeasurements().size()==3,"processor reuse drops effect measurement nodes");
    }
    {
        const std::vector<visiki::EffectSpec> fx{effect("eq",{{"band1Gain",3}}),effect("compressor"),effect("reverb"),effect("delay"),effect("saturation",{{"oversample",2}}),effect("limiter")};
        auto a=sine(817,.25,16384),b=a;auto c=chain(fx),d=chain(fx);run(c,a,1);run(d,b,733);expect(a.l==b.l&&a.r==b.r,"preview/export differs with block size");
        const auto before=allocationCount;Audio silence(8192);watchAllocations=true;run(c,silence);c.reset();watchAllocations=false;expect(allocationCount==before,"audio process/reset allocates memory");
    }
    {
        auto fx=effect("delay",{{"timeMs",20},{"timeRightMs",20},{"mix",100},{"feedback",0}});auto c=chain({fx});Audio input(480);input.l[0]=1;run(c,input);fx.params["outputDb"]=-1;c.setEffects({fx});Audio tail(960);run(c,tail);expect(tail.l[480]>.8,"live parameter update discards delay history");
        fx=effect("reverb",{{"mix",100}});c=chain({fx});input=Audio(24000);input.l[0]=1;run(c,input);fx.params["mix"]=80;c.setEffects({fx});tail=Audio(1024);run(c,tail);expect(rms(tail.l)>1e-7,"live parameter update discards FDN history");
        auto dry=chain({effect("delay",{{"mix",0}}),effect("reverb",{{"mix",0}})});expect(dry.tailSamples()==0,"fully dry spatial effects add silent export tail");
    }
    {
        auto delay=effect("delay",{{"mix",50}}), reverb=effect("reverb",{{"mix",30}});
        auto processors=chain({delay,reverb});
        delay.params["mix"]=75;reverb.params["size"]=90;
        const std::vector<visiki::EffectSpec> next{delay,reverb};
        largestAllocation=0;watchLargestAllocation=true;processors.setEffects(next,113);watchLargestAllocation=false;
        expect(largestAllocation<65536,"delay/reverb parameter changes reallocate audio history");
        largestAllocation=0;watchLargestAllocation=true;processors.setEffects(next,108);watchLargestAllocation=false;
        expect(largestAllocation<65536,"BPM changes rebuild a delay with sync turned off");
    }
    {
        auto fx=effect("stereo",{{"gainDb",0}});auto c=chain({fx});auto a=sine(1000,.1,1024);run(c,a);fx.params["gainDb"]=-12;c.setEffects({fx});c.reset();auto b=sine(1000,.1,1024),reference=b;auto d=chain({fx});run(c,b);run(d,reference);expect(b.l==reference.l&&b.r==reference.r,"seek reset leaves parameter smoothing in flight");
    }
    {
        std::mt19937 random(42);std::uniform_real_distribution<float> noise(-2,2);std::vector<visiki::EffectSpec> fx;for(const char* type:{"eq","compressor","gate","deesser","reverb","delay","saturation","stereo","limiter","meter"})fx.push_back(effect(type));auto c=chain(fx);Audio a(8192);for(std::size_t i=0;i<a.l.size();++i){a.l[i]=noise(random);a.r[i]=noise(random);}a.l[10]=std::numeric_limits<float>::infinity();a.r[11]=std::numeric_limits<float>::quiet_NaN();run(c,a);finite(a);expect(c.latencySamples()>0,"combined graph latency missing");
    }
    std::cout<<"{\"ok\":true,\"checks\":"<<checks<<",\"processingAllocations\":"<<allocationCount<<"}\n";return 0;
}catch(const std::exception& e){watchAllocations=false;std::cerr<<"DSP fixture failed: "<<e.what()<<"\n";return 1;}}
