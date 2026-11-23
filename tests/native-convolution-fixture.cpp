#include "../native/dsp.h"
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>
using namespace visiki;
static void require(bool value,const char* msg){if(!value){std::fprintf(stderr,"FAIL: %s\n",msg);std::exit(1);}}
static EffectSpec spec(int space=0,double wet=100,double pre=0){EffectSpec s;s.id="c";s.type="convolution";s.params={{"space",double(space)},{"mix",wet},{"preDelayMs",pre}};return s;}
static std::vector<float> render(EffectChain& fx,const std::vector<float>& x,int step,bool right=false){auto l=x,r=x;if(right)std::fill(l.begin(),l.end(),0);for(int i=0;i<int(x.size());i+=step)fx.process(l.data()+i,r.data()+i,std::min(step,int(x.size())-i),false,false);return right?r:l;}
static EffectChain chain(double rate,EffectSpec s){EffectChain fx;fx.prepare(rate,512,false);fx.setEffects({s});return fx;}
int main(){
    const double rate=8000;auto s=spec();auto fx=chain(rate,s);const int latency=fx.latencySamples();require(latency==512,"fixed latency");require(fx.tailSamples()==3600,"reported tail excludes latency");
    const int count=5500;std::vector<float> impulse(count);impulse[0]=1;
    auto ir=render(fx,impulse,71);require(std::abs(ir[latency])>1e-8,"wet impulse begins at latency");
    auto fx2=chain(rate,s);auto ir2=render(fx2,impulse,512);for(int i=0;i<count;++i)require(std::abs(ir[i]-ir2[i])<1e-7,"determinism and block splits");
    fx.reset();auto again=render(fx,impulse,127);for(int i=0;i<count;++i)require(std::abs(ir[i]-again[i])<1e-7,"reset deterministic");
    std::vector<float> input(count);for(int i=0;i<180;++i)input[i]=static_cast<float>(std::sin(i*.35)*.25);fx.reset();auto y=render(fx,input,37);
    for(int i=0;i<count;++i){double expected=0;for(int j=0;j<180&&j<=i;++j)expected+=input[j]*ir[i-j];require(std::abs(y[i]-expected)<2e-5,"matches direct convolution");}
    auto dry=chain(rate,spec(0,0));auto dryout=render(dry,impulse,123);for(int i=0;i<count;++i)require(std::abs(dryout[i]-(i==latency?1.f:0.f))<1e-6,"dry latency alignment");
    auto pd=chain(rate,spec(0,100,100));require(pd.tailSamples()==4400,"pre-delay tail");auto delayed=render(pd,impulse,123);for(int i=0;i<count-800;++i)require(std::abs(delayed[i+800]-ir[i])<1e-6,"wet pre-delay");
    auto stereo=chain(rate,s);auto right=render(stereo,impulse,256,true);double diff=0;for(int i=0;i<count;++i)diff+=std::abs(ir[i]-right[i]);require(diff>.1,"stereo decorrelation");
    auto changed=chain(rate,s);std::vector<float> a(1000);a[0]=1;auto part=render(changed,a,71);s.params["mix"]=30;changed.setEffects({s});std::vector<float> silence(512);auto continuation=render(changed,silence,81);double sum=0;for(float v:continuation)sum+=std::abs(v);require(sum>1e-4,"same space parameter edit preserves tail");
    for(int space=0;space<4;++space){auto c=chain(rate,spec(space));const double durations[]={.45,1,1.45,2.1};require(c.tailSamples()==static_cast<long long>(std::ceil(durations[space]*rate)),"space duration");}
    const auto start=std::chrono::steady_clock::now();std::vector<EffectChain> many;for(int i=0;i<32;++i)many.push_back(chain(96000,spec(3)));const auto prepared=std::chrono::steady_clock::now();std::vector<float> l(96000),r(96000);l[0]=r[0]=1;for(auto& c:many){auto left=l,right=r;c.process(left.data(),right.data(),int(left.size()),false,false);}const auto end=std::chrono::steady_clock::now();std::printf("PASS convolution: latency=%d samples at 8k; 32 hall instances at 96k, preparation %.3fs, processing %.3fs per audio second\n",latency,std::chrono::duration<double>(prepared-start).count(),std::chrono::duration<double>(end-prepared).count());
}
