#pragma once
#include <complex>

// Windowed, stereo-averaged energy in the requested project-time frames.
struct AutoMixTrackAnalysis {
 static constexpr int fftSize=1024, bandCount=11;
 const std::string id; const int rate; const int64_t hop, end; const bool peakOnly, vocal;
 int64_t count=0; double energy=0, peak=0, bandWeight=0;
 double leftPower=0, rightPower=0, crossPower=0;
 std::array<double,bandCount> bandPower{},bandPeak{};
 std::array<std::array<visiki::dsp_detail::Biquad,2>,2> k{};
 std::array<visiki::dsp_detail::Biquad,2> hp{};
 std::array<std::array<visiki::dsp_detail::Biquad,2>,bandCount> bandFilters{};
 double weightedEnergy=0, detectorPeak=0, detectorEnvelope[2]{}, detectorCoeff=0;
 static constexpr int sibilanceBands=3, firstSibilanceBand=7;
 int sibilanceSamples=0;
 double sibilancePower=0, sibilanceAttack=0, sibilanceRelease=0;
 std::array<double,sibilanceBands> sibilanceBandPower{}, sibilanceEnvelope{}, sibilancePeak{}, sibilanceBestRatio{}, sibilanceBestEnvelope{};
 std::array<float,fftSize> left{},right{}; int buffered=0;
 json frames=json::array();
 AutoMixTrackAnalysis(std::string name,int sampleRate,int64_t endFrame,bool onlyPeaks=false,bool isVocal=false)
  :id(std::move(name)),rate(sampleRate),hop(std::max<int64_t>(1,std::llround(sampleRate*.2))),end(endFrame),peakOnly(onlyPeaks),vocal(isVocal){
  static constexpr double edges[bandCount+1]={20,60,120,250,500,1000,2000,4000,6000,8000,12000,20000};
  for(auto& ch:k){ch[0].design(2,1681.974,.707175,4,rate);ch[1].design(3,38.135,.500327,0,rate);}
  for(auto& f:hp)f.design(3,20,.70710678,0,rate);
  for(int b=0;b<bandCount;b++){const double center=std::sqrt(edges[b]*edges[b+1]),q=.8;for(auto& f:bandFilters[b])f.design(6,center,q,0,rate);}
  detectorCoeff=visiki::dsp_detail::coeffMs(10,rate);
  sibilanceAttack=visiki::dsp_detail::coeffMs(1,rate);
  sibilanceRelease=visiki::dsp_detail::coeffMs(80,rate);
  sibilanceBestRatio.fill(-120);
 }
 static void fft(std::array<std::complex<double>,fftSize>& a){
  for(int i=1,j=0;i<fftSize;i++){int bit=fftSize>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)std::swap(a[i],a[j]);}
  for(int len=2;len<=fftSize;len<<=1){const double angle=-2*M_PI/len;const std::complex<double> step(std::cos(angle),std::sin(angle));for(int i=0;i<fftSize;i+=len){std::complex<double> w(1,0);for(int j=0;j<len/2;j++){const auto u=a[i+j],v=a[i+j+len/2]*w;a[i+j]=u+v;a[i+j+len/2]=u-v;w*=step;}}}
 }
 void spectrum(){
  if(!buffered)return;
  static constexpr double edges[bandCount+1]={20,60,120,250,500,1000,2000,4000,6000,8000,12000,20000};
  std::array<std::complex<double>,fftSize> l{},r{};double windowEnergy=0;
  // Pad short chunks after applying a window over their actual length.
  for(int i=0;i<buffered;i++){const double w=buffered==1?1.:.5-.5*std::cos(2*M_PI*i/(buffered-1));windowEnergy+=w*w;l[i]=left[i]*w;r[i]=right[i]*w;}
  if(windowEnergy>0){fft(l);fft(r);std::array<double,bandCount> powers{};
   for(int k=0;k<=fftSize/2;k++){double hz=double(k)*rate/fftSize;for(int b=0;b<bandCount;b++)if(hz>=edges[b]&&hz<(b==bandCount-1?edges[b+1]+1e-9:edges[b+1])){const double factor=(k==0||k==fftSize/2)?1.:2.;powers[b]+=factor*(std::norm(l[k])+std::norm(r[k]))/(2.*fftSize*windowEnergy);break;}}
   for(int b=0;b<bandCount;b++)bandPower[b]+=powers[b]*buffered;bandWeight+=buffered;
  }
  buffered=0;
 }
 void finishSibilanceWindow(){
  if(!sibilanceSamples)return;
  // A short band/full-band energy comparison keeps a consonant detectable
  // even when a longer analysis window mostly contains sustained vowels.
  if(sibilancePower/sibilanceSamples>4e-7){
   for(int band=0;band<sibilanceBands;band++){
    const double relative=10*std::log10(std::max(1e-12,sibilanceBandPower[band]/sibilancePower));
    if(relative>sibilanceBestRatio[band]){
     sibilanceBestRatio[band]=relative;sibilanceBestEnvelope[band]=sibilancePeak[band];
    }
   }
  }
  sibilanceSamples=0;sibilancePower=0;sibilanceBandPower.fill(0);sibilancePeak.fill(0);
 }
 void finish(int64_t first){
  if(!peakOnly)spectrum();if(!count)return;json bands=json::array();for(double p:bandPower)bands.push_back(db(std::sqrt(std::max(0.,bandWeight?p/bandWeight:0.))));
  json peaks=json::array();for(double p:bandPeak)peaks.push_back(db(p));
  json frame={{"time",double(first)/rate},{"duration",double(count)/rate},{"rmsDb",db(std::sqrt(energy/count))},{"peakDb",db(peak)},{"kDb",db(std::sqrt(weightedEnergy/count))},{"detectorDb",db(detectorPeak)},{"bandsDb",bands}};
  if(!peakOnly){
   // Correlation is undefined when either channel is silent; report a neutral value.
   const double threshold=double(count)*1e-24;
   const double correlation=leftPower>threshold&&rightPower>threshold?std::clamp(crossPower/std::sqrt(leftPower*rightPower),-1.,1.):0.;
   frame["stereo"]={{"leftDb",db(std::sqrt(leftPower/count))},{"rightDb",db(std::sqrt(rightPower/count))},{"correlation",correlation}};
  }
  if(peakOnly)frame["bandPeakDb"]=peaks;
  if(vocal){
   finishSibilanceWindow();
   auto events=json::array();
   for(int band=0;band<sibilanceBands;band++)events.push_back({{"ratioDb",sibilanceBestRatio[band]},{"envelopeDb",db(sibilanceBestEnvelope[band])}});
   frame["sibilance"]=std::move(events);
   sibilanceBestRatio.fill(-120);sibilanceBestEnvelope.fill(0);
  }
  frames.push_back(std::move(frame));
  count=0;energy=peak=bandWeight=weightedEnergy=detectorPeak=0;leftPower=rightPower=crossPower=0;bandPower.fill(0);bandPeak.fill(0);
 }
 void push(int64_t start,const float* l,const float* r,int n){
  for(int i=0;i<n;i++){const int64_t pos=start+i;if(pos<0||pos>=end)continue;
   const double a=std::isfinite(l[i])?l[i]:0.,b=std::isfinite(r[i])?r[i]:0.;
   const double aPower=a*a,bPower=b*b,power=(aPower+bPower)*.5;
   energy+=power;peak=std::max(peak,std::max(std::abs(a),std::abs(b)));
   if(!peakOnly){leftPower+=aPower;rightPower+=bPower;crossPower+=a*b;}
   const double x[2]={a,b};
   for(int ch=0;ch<2;ch++){
    if(!peakOnly){const double weighted=k[ch][1].tick(k[ch][0].tick(x[ch]));weightedEnergy+=weighted*weighted*.5;
    const double filtered=hp[ch].tick(x[ch]);detectorEnvelope[ch]=detectorCoeff*detectorEnvelope[ch]+(1-detectorCoeff)*filtered*filtered;detectorPeak=std::max(detectorPeak,std::sqrt(std::max(0.,detectorEnvelope[ch])));}
    if(peakOnly)for(int band=5;band<=6;band++)bandPeak[band]=std::max(bandPeak[band],std::abs(bandFilters[band][ch].tick(x[ch])));
   }
   if(vocal){
    sibilancePower+=power;
    for(int band=0;band<sibilanceBands;band++){
     const int filter=firstSibilanceBand+band;
     const double leftBand=bandFilters[filter][0].tick(a), rightBand=bandFilters[filter][1].tick(b);
     sibilanceBandPower[band]+=(leftBand*leftBand+rightBand*rightBand)*.5;
     const double maximum=std::max(std::abs(leftBand),std::abs(rightBand));
     const double previous=sibilanceEnvelope[band];
     sibilanceEnvelope[band]=visiki::dsp_detail::undenormal(maximum+(maximum>previous?sibilanceAttack:sibilanceRelease)*(previous-maximum));
     sibilancePeak[band]=std::max(sibilancePeak[band],sibilanceEnvelope[band]);
    }
    if(++sibilanceSamples>=std::max(1,rate*15/1000))finishSibilanceWindow();
   }
   if(!peakOnly){left[buffered]=float(a);right[buffered]=float(b);buffered++;}count++;
   if(!peakOnly&&buffered==fftSize)spectrum();if(count==hop||pos+1==end)finish(pos+1-count);
  }
 }
};
