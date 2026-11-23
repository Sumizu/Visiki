#define NOMINMAX
#define _USE_MATH_DEFINES
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_DECODING
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#include "vendor/miniaudio/miniaudio.h"
#include "vendor/json/json.hpp"
#include "vendor/libebur128/ebur128/ebur128.h"
#include "dsp.h"
#include <windows.h>
#include <ole2.h>
#include <atomic>
#include <chrono>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>
#include <deque>
#include <future>
#include <condition_variable>
#include <map>
#include <array>
#include <cmath>
#include <filesystem>
#include <cstring>
using json = nlohmann::json;
constexpr int BLOCK=512;
static double gain(double db){return std::pow(10.,db/20.);}
static double db(double x){return x>1e-12?20*std::log10(x):-120;}
static std::wstring wide(const std::string&s){int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),nullptr,0);if(!n)throw std::runtime_error("Invalid UTF-8 path");std::wstring w(n,0);MultiByteToWideChar(CP_UTF8,0,s.data(),int(s.size()),w.data(),n);return w;}
#include "automix-analysis.h"
#include "vst3-host.h"
#include "vst3-window.h"
static std::string utf8(const wchar_t* text){
 const int length=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text,-1,nullptr,0,nullptr,nullptr);
 if(!length)throw std::runtime_error("Invalid Windows path");
 std::string result(size_t(length), '\0');
 WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text,-1,result.data(),length,nullptr,nullptr);
 result.pop_back();
 return result;
}
static std::unique_ptr<visiki::dsp_detail::Processor> createVst3Processor(
 const visiki::EffectSpec& spec,double rate,int block,bool offline,double bpm,double barBeats){
 return visiki::vst3::createProcessor(spec.vst3ModulePath,spec.vst3ClassId,spec.params,rate,block,offline,bpm,barBeats);
}
static void configureVst3Processor(visiki::dsp_detail::Processor& processor,const visiki::EffectSpec& spec,double bpm,double barBeats){
 visiki::vst3::configureProcessor(processor,spec.params,bpm,barBeats,spec.vst3EditsSeen);
}
struct ResampleKernel {
 static constexpr int phases=1024;
 int taps,offset;
 std::vector<float> weights;
 ResampleKernel(int inputRate,int outputRate){
  const double ratio=std::min(1.,double(outputRate)/inputRate),cutoff=.95*ratio;
  const int radius=static_cast<int>(std::ceil(80/ratio));taps=2*radius;offset=1-radius;
  weights.resize(size_t(phases+1)*taps);
  for(int phase=0;phase<=phases;++phase){
   float* row=weights.data()+size_t(phase)*taps;const double fraction=double(phase)/phases;double total=0;
   for(int tap=0;tap<taps;++tap){const double distance=offset+tap-fraction,angle=M_PI*distance/radius,sincAt=M_PI*distance*cutoff;
    const double value=(std::abs(sincAt)<1e-12?1.:std::sin(sincAt)/sincAt)*(.42+.5*std::cos(angle)+.08*std::cos(2*angle));
    row[tap]=float(value);total+=value;
   }
   for(int tap=0;tap<taps;++tap)row[tap]=float(row[tap]/total);
  }
 }
};
using ResampleKernels=std::map<int,std::shared_ptr<const ResampleKernel>>;
struct Source{
 HANDLE file=INVALID_HANDLE_VALUE,mapping=nullptr;const char*data=nullptr;uint64_t offset=0,count=0;int rate=48000,channels=2;
 std::shared_ptr<const ResampleKernel> kernel;
 explicit Source(const json&j,int target,ResampleKernels* kernels=nullptr){
  rate=j.at("sampleRate");channels=j.at("channels");offset=j.at("dataOffset");count=j.at("sampleCount");
  if(rate!=target){if(kernels){auto& shared=(*kernels)[rate];if(!shared)shared=std::make_shared<ResampleKernel>(rate,target);kernel=shared;}else kernel=std::make_shared<ResampleKernel>(rate,target);}
  file=CreateFileW(wide(j.at("file")).c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file==INVALID_HANDLE_VALUE)throw std::runtime_error("Audio cache cannot be opened");
  mapping=CreateFileMappingW(file,nullptr,PAGE_READONLY,0,0,nullptr);if(mapping)data=(const char*)MapViewOfFile(mapping,FILE_MAP_READ,0,0,0);
  if(!data){if(mapping)CloseHandle(mapping);CloseHandle(file);file=INVALID_HANDLE_VALUE;throw std::runtime_error("Audio cache cannot be mapped");}
  LARGE_INTEGER size{};GetFileSizeEx(file,&size);if(offset+count*channels*4>uint64_t(size.QuadPart)){UnmapViewOfFile(data);data=nullptr;CloseHandle(mapping);mapping=nullptr;CloseHandle(file);file=INVALID_HANDLE_VALUE;throw std::runtime_error("Truncated audio cache");}
 }
 ~Source(){if(data)UnmapViewOfFile(data);if(mapping)CloseHandle(mapping);if(file!=INVALID_HANDLE_VALUE)CloseHandle(file);}
 float at(int64_t i,int c)const{if(i<0||uint64_t(i)>=count)return 0;float v;std::memcpy(&v,data+offset+(i*channels+std::min(c,channels-1))*4,4);return std::isfinite(v)?v:0;}
 std::array<float,2> samplePair(double position)const{
  if(!kernel){const int64_t index=std::llround(position);const float left=at(index,0);return{left,channels==1?left:at(index,1)};}
  const int64_t base=int64_t(std::floor(position)),first=base+kernel->offset;
  const double fractional=(position-base)*ResampleKernel::phases;
  const int phase=std::min(ResampleKernel::phases-1,int(fractional));const float cross=float(fractional-phase);
  const float* weights=kernel->weights.data()+size_t(phase)*kernel->taps;
  const int tapStart=int(std::clamp<int64_t>(-first,0,kernel->taps)),tapEnd=int(std::clamp<int64_t>(int64_t(count)-first,0,kernel->taps));
  double left=0,right=0;
  for(int tap=tapStart;tap<tapEnd;++tap){const float weight=weights[tap]+cross*(weights[tap+kernel->taps]-weights[tap]);const char* input=data+offset+(first+tap)*channels*4;
   float samples[2];std::memcpy(samples,input,channels*4);if(std::isfinite(samples[0]))left+=samples[0]*weight;if(channels==2&&std::isfinite(samples[1]))right+=samples[1]*weight;
  }
  return {float(left),float(channels==1?left:right)};
 }
 float sample(double position,int channel)const{return samplePair(position)[channel];}
};
static std::vector<visiki::EffectSpec> effects(const json& owner,const char* key,bool preview=true,std::uint64_t vst3After=0){
 std::vector<visiki::EffectSpec> specs;
 for(const auto& effect:owner.value(key,json::array())){
  visiki::EffectSpec spec;
  spec.id=effect.at("id");spec.type=effect.at("type");spec.enabled=effect.value("enabled",true);
  spec.params=effect.at("params").get<std::map<std::string,double>>();
  if(spec.type=="denoise"&&effect.contains("noiseProfile"))spec.noiseProfile=effect.at("noiseProfile").get<std::vector<double>>();
  if(spec.type=="ducker")spec.sidechainTrackId=effect.value("sidechainTrackId",std::string{});
  if(spec.type=="vst3"){
   const auto& binding=effect.at("vst3");
   spec.vst3ClassId=binding.at("classId");
   if(spec.enabled)spec.vst3ModulePath=binding.at("modulePath");
   spec.vst3EditsSeen=vst3After;
  }
  if(!preview){
   if(spec.type=="eq")spec.params.erase("soloBand");
   else if(spec.type=="gate"||spec.type=="deesser")spec.params.erase("listen");
   else if(spec.type=="stereo"){spec.params.erase("listen");spec.params.erase("mono");}
  }
  specs.push_back(std::move(spec));
 }
 return specs;
}
static bool containsEnabledVst3(const json& session){
 auto hasPlugin=[](const json& owner,const char* key){
  const auto chain=owner.find(key);
  return chain!=owner.end()&&std::any_of(chain->begin(),chain->end(),[](const json& effect){
   return effect.value("enabled",true)&&effect.value("type",std::string())=="vst3";
  });
 };
 if(hasPlugin(session,"masterEffects"))return true;
 const auto& tracks=session.at("tracks");
 return std::any_of(tracks.begin(),tracks.end(),[&](const json& track){return hasPlugin(track,"effects");});
}
struct DelayLine{
 std::vector<float>l,r;size_t cursor=0;
 void configure(int n){n=std::max(0,n);if(int(l.size())!=n){l.assign(n,0);r.assign(n,0);cursor=0;}}
 void reset(){std::fill(l.begin(),l.end(),0.f);std::fill(r.begin(),r.end(),0.f);cursor=0;}
 void process(float*L,float*R,int n){if(l.empty())return;for(int i=0;i<n;i++){std::swap(L[i],l[cursor]);std::swap(R[i],r[cursor]);cursor=(cursor+1)%l.size();}}
};
struct ClipEffects {
 visiki::EffectChain chain;
 std::vector<visiki::EffectSpec> specs;
 bool reported=false;
};
struct ClipData{std::string id;std::shared_ptr<Source> source;double start=0,end=0,sourceIn=0,gain=1,fadeIn=0,fadeOut=0;std::vector<std::pair<double,double>> envelope;
 int64_t first=0,last=0;
 std::unique_ptr<ClipEffects> fx;
 visiki::dsp_detail::Slew audition;
 double level(double local)const{if(!envelope.empty()){if(local<=envelope.front().first)return envelope.front().second;for(size_t k=1;k<envelope.size();k++)if(local<=envelope[k].first){auto a=envelope[k-1],b=envelope[k];return a.second+(b.second-a.second)*(local-a.first)/(b.first-a.first);}return envelope.back().second;}return std::clamp(std::min(fadeIn>0?local/fadeIn:1.,fadeOut>0?(end-start-local)/fadeOut:1.),0.,1.);}};
struct SidechainBlock {
 int64_t start=0;
 int size=0;
 std::array<float,BLOCK> peaks{},powers{},left{},right{};
};
struct Track{std::vector<ClipData> clips;double pan=0;int clipLatency=0;visiki::dsp_detail::Slew volume,audition;bool inaudible=false;visiki::EffectChain fx;std::vector<visiki::EffectSpec> specs;DelayLine align;std::array<float,BLOCK>l{},r{};SidechainBlock sidechain;};
class Graph{
public:
 int rate=48000,latency=0,trackLatency=0;int64_t length=0,frame=0,tail=0,lookback=0;double bpm=120,barBeats=4;visiki::dsp_detail::Slew masterGain;bool preview=false,hasVst3=false;
 std::map<std::string,std::unique_ptr<Track>>tracks;std::map<std::string,std::shared_ptr<Source>>sources;ResampleKernels kernels;visiki::EffectChain master;std::vector<visiki::EffectSpec> masterSpecs;
 json latestMeters=json::object(),latestEffects=json::object();
 std::map<std::string,std::unique_ptr<AutoMixTrackAnalysis>> autoMixAnalyses;
  struct MeterState{ebur128_state*state=nullptr;int rate;int64_t frames=0;explicit MeterState(int sampleRate):rate(sampleRate){state=ebur128_init(2,rate,EBUR128_MODE_I|EBUR128_MODE_S|EBUR128_MODE_LRA|EBUR128_MODE_TRUE_PEAK|EBUR128_MODE_HISTOGRAM);if(!state)throw std::runtime_error("Meter allocation failed");}~MeterState(){ebur128_destroy(&state);}void add(const float*input,int count){if(ebur128_add_frames_float(state,input,count)==EBUR128_SUCCESS)frames+=count;}};
 std::map<std::string,std::unique_ptr<MeterState>,std::less<>> nodeMeters;
  std::unique_ptr<MeterState> loud;std::array<float,BLOCK*2>interleaved{};bool prepared=false;
 struct Vst3EditorSlot{
   std::string classId;
   std::unique_ptr<visiki::dsp_detail::Processor> bypassedInstance;
 };
 std::map<std::string,Vst3EditorSlot> vst3Editors;
 std::pair<const visiki::EffectSpec*,visiki::dsp_detail::Processor*> findVst3(const std::string& id){
   auto findSpec=[&](const auto& specs)->const visiki::EffectSpec*{
     for(const auto& spec:specs)if(spec.type=="vst3"&&spec.id==id)return &spec;
     return nullptr;
   };
   if(const auto* spec=findSpec(masterSpecs))return {spec,master.findVst3(id)};
   for(auto& [trackId,track]:tracks)if(const auto* spec=findSpec(track->specs))return {spec,track->fx.findVst3(id)};
   return {nullptr,nullptr};
 }
 bool openVst3Editor(const std::string& id,const json& plugin,visiki::vst3::EditorCommit commit){
   const auto [spec,processor]=findVst3(id);
   const auto modulePath=plugin.at("modulePath").get<std::string>();
   if(!spec||spec->vst3ClassId!=plugin.at("classId"))throw std::runtime_error("VST3 insert is unavailable");
   if(!processor&&spec->enabled)throw std::runtime_error("VST3 processor is unavailable");
   if(spec->enabled&&spec->vst3ModulePath!=modulePath)throw std::runtime_error("VST3 module changed; reload the session");

   if(auto existing=vst3Editors.find(id);existing!=vst3Editors.end()){
     auto* instance=existing->second.bypassedInstance?existing->second.bypassedInstance.get():processor;
     if(instance)return visiki::vst3::openEditor(*instance,std::move(commit));
     vst3Editors.erase(existing);
   }
   Vst3EditorSlot slot{spec->vst3ClassId,nullptr};
   if(!processor)slot.bypassedInstance=visiki::vst3::createProcessor(modulePath,spec->vst3ClassId,spec->params,rate,BLOCK,false,bpm,barBeats);
   auto& instance=processor?*processor:*slot.bypassedInstance;
   if(!visiki::vst3::openEditor(instance,std::move(commit)))return false;
   vst3Editors.emplace(id,std::move(slot));
   return true;
 }
 void serviceVst3Editors(bool flush=false,bool updateBypassed=false){
   for(auto entry=vst3Editors.begin();entry!=vst3Editors.end();){
     const auto [spec,processor]=findVst3(entry->first);
     auto& slot=entry->second;
     if(!spec||spec->vst3ClassId!=slot.classId||bool(slot.bypassedInstance)==spec->enabled){
       entry=vst3Editors.erase(entry);
       continue;
     }
     auto* instance=slot.bypassedInstance?slot.bypassedInstance.get():processor;
     if(!instance||!visiki::vst3::serviceEditor(*instance,flush)){
       entry=vst3Editors.erase(entry);
       continue;
     }
     if(updateBypassed&&slot.bypassedInstance)configureVst3Processor(*instance,*spec,bpm,barBeats);
     ++entry;
   }
 }
 void closeVst3Editors(){
   for(auto& [id,slot]:vst3Editors){
     if(slot.bypassedInstance)visiki::vst3::closeEditor(*slot.bypassedInstance);
     else if(auto* instance=findVst3(id).second)visiki::vst3::closeEditor(*instance);
   }
   vst3Editors.clear();
 }
 json openVst3EditorIds()const{
   json ids=json::array();
   for(const auto& entry:vst3Editors)ids.push_back(entry.first);
   return ids;
 }
 void set(const json&session,bool isPreview,bool offline=true,std::uint64_t vst3After=0){
  int nextRate=session.at("sampleRate");if(prepared&&rate!=nextRate)throw std::runtime_error("Restart playback to change sample rate");rate=nextRate;preview=isPreview;
   hasVst3=containsEnabledVst3(session);
   master.setVst3Host(createVst3Processor,configureVst3Processor,offline);
   visiki::dsp_detail::setSlew(masterGain,gain(session.value("masterDb",0.)),rate,8,!prepared);
   if(!prepared){master.prepare(rate,BLOCK,false);master.setSidechainReader(sidechainTap,this);if(preview)loud=std::make_unique<MeterState>(rate);prepared=true;}
   const auto grid=session.value("musicalGrid",json::object());
   bpm=grid.value("bpm",120.);barBeats=grid.value("beatsPerBar",4.)*4/grid.value("beatUnit",4.);length=0;bool solo=false;
  for(const auto&t:session.at("tracks"))solo|=t.value("solo",false);
   std::map<std::string,bool>liveSources;for(const auto&a:session.at("assets")){std::string id=a.at("id");liveSources[id]=true;if(a.contains("file")&&!sources.count(id))sources[id]=std::make_shared<Source>(a,rate,&kernels);}for(auto it=sources.begin();it!=sources.end();)if(!liveSources[it->first])it=sources.erase(it);else++it;
   std::map<std::string,bool>liveMeters;auto setupMeter=[&](const std::vector<visiki::EffectSpec>&specs){if(preview)for(const auto&e:specs)if(e.type=="meter"&&e.enabled){liveMeters[e.id]=true;if(!nodeMeters.count(e.id))nodeMeters[e.id]=std::make_unique<MeterState>(rate);}};
   std::map<std::string,bool> live;
  for(const auto&t:session.at("tracks")){
    std::string id=t.at("id");live[id]=true;auto&ptr=tracks[id];bool first=!ptr;if(first){ptr=std::make_unique<Track>();ptr->fx.prepare(rate,BLOCK,false);ptr->fx.setSidechainReader(sidechainTap,this,id);ptr->audition.init(1,rate,20);}auto&tr=*ptr;
    tr.fx.setVst3Host(createVst3Processor,configureVst3Processor,offline);
    tr.specs=effects(t,"effects",preview,vst3After);setupMeter(tr.specs);tr.fx.setEffects(tr.specs,bpm,barBeats);tr.fx.setMeterCallback(meterTap,this);
    std::map<std::string,ClipData*> previous;
    for(auto& clip:tr.clips)previous.emplace(clip.id,&clip);
    std::vector<ClipData> clips;
    visiki::dsp_detail::setSlew(tr.volume,gain(t.value("volumeDb",0.)),rate,8,first);tr.pan=t.value("pan",0.);bool muted=t.value("muted",false)||(preview&&solo&&!t.value("solo",false));if(muted&&!tr.inaudible){tr.fx.reset();tr.align.reset();}tr.inaudible=muted;
    if(!muted)for(const auto& c:t.at("clips")){
     auto source=sources.find(c.at("assetId"));if(source==sources.end())throw std::runtime_error("An audible source is missing");
     ClipData clip;clip.id=c.at("id");clip.source=source->second;clip.start=c.at("start");clip.end=clip.start+c.at("duration").get<double>();clip.sourceIn=c.at("sourceIn");
     clip.first=static_cast<int64_t>(std::ceil(clip.start*rate-1e-7));clip.last=static_cast<int64_t>(std::ceil(clip.end*rate-1e-7));
     clip.gain=gain(c.value("gainDb",0.));clip.fadeIn=c.value("fadeIn",0.);clip.fadeOut=c.value("fadeOut",0.);
     for(const auto& point:c.value("envelope",json::array()))clip.envelope.emplace_back(point.at("time"),point.at("gain"));
     auto old=previous.find(clip.id);
     if(old==previous.end())clip.audition.init(1,rate,20);else clip.audition=old->second->audition;
     auto inserts=effects(c,"effects",preview);
     if(std::any_of(inserts.begin(),inserts.end(),[](const auto& spec){return spec.enabled;})){
      if(old!=previous.end())clip.fx=std::move(old->second->fx);
      if(!clip.fx){clip.fx=std::make_unique<ClipEffects>();clip.fx->chain.prepare(rate,BLOCK,false);clip.fx->chain.setSidechainReader(sidechainTap,this,id);}
      clip.fx->reported=false;
      clip.fx->specs=std::move(inserts);setupMeter(clip.fx->specs);
      clip.fx->chain.setEffects(clip.fx->specs,bpm,barBeats);clip.fx->chain.setMeterCallback(meterTap,this);
     }
     clips.push_back(std::move(clip));
    }
    tr.clips=std::move(clips);tr.sidechain.size=0;
   for(const auto&c:t.at("clips"))length=std::max(length,int64_t(std::ceil((c.at("start").get<double>()+c.at("duration").get<double>())*rate-1e-7)));
  }
  for(auto it=tracks.begin();it!=tracks.end();)if(!live[it->first])it=tracks.erase(it);else++it;
   masterSpecs=effects(session,"masterEffects",preview,vst3After);setupMeter(masterSpecs);master.setEffects(masterSpecs,bpm,barBeats);master.setMeterCallback(meterTap,this);for(auto it=nodeMeters.begin();it!=nodeMeters.end();)if(!liveMeters[it->first])it=nodeMeters.erase(it);else++it;
   refreshTiming();latestMeters=json::object();latestEffects=json::object();
 }
  void refreshTiming(){
   int maxLatency=0;int64_t trackTail=0;lookback=0;
   for(auto& pair:tracks){auto& track=*pair.second;track.clipLatency=0;
    if(track.inaudible)continue;
    for(const auto& clip:track.clips)if(clip.fx){
     track.clipLatency=std::max(track.clipLatency,clip.fx->chain.latencySamples());
     lookback=std::max(lookback,clip.fx->chain.tailSamples());
    }
    maxLatency=std::max(maxLatency,track.clipLatency+track.fx.latencySamples());trackTail=std::max(trackTail,track.fx.tailSamples());
   }
   for(auto& pair:tracks){auto& track=*pair.second;track.align.configure(track.inaudible?0:maxLatency-track.clipLatency-track.fx.latencySamples());}
   trackLatency=maxLatency;latency=trackLatency+master.latencySamples();tail=std::min(int64_t(rate)*30,trackTail+master.tailSamples());
   lookback=std::min(int64_t(rate)*30,std::max(lookback,tail));
  }
  void mix(const json& change,std::uint64_t vst3After=0){
   const double nextBpm=change.value("bpm",bpm);const bool tempoChanged=nextBpm!=bpm; bpm=nextBpm;
   if(change.contains("masterDb"))masterGain.target=gain(change.at("masterDb"));
   if(change.contains("masterEffects"))masterSpecs=effects(change,"masterEffects",true,vst3After);
   if(tempoChanged||change.contains("masterEffects"))master.setEffects(masterSpecs,bpm,barBeats);
   for(const auto& item:change.at("tracks")){
    auto& track=*tracks.at(item.at("id"));track.volume.target=gain(item.at("volumeDb"));track.pan=item.at("pan");
    if(item.contains("effects")){track.specs=effects(item,"effects",true,vst3After);if(!tempoChanged)track.fx.setEffects(track.specs,bpm,barBeats);}
    for(const auto& clipChange:item.value("clipEffects",json::array())){
     auto clip=std::find_if(track.clips.begin(),track.clips.end(),[&](const auto& c){return c.id==clipChange.at("id");});
     if(clip==track.clips.end()||!clip->fx)continue;
     clip->fx->specs=effects(clipChange,"effects");
     if(!tempoChanged)clip->fx->chain.setEffects(clip->fx->specs,bpm,barBeats);
    }
   }
   if(tempoChanged)for(auto& [id,track]:tracks){
    track->fx.setEffects(track->specs,bpm,barBeats);
    for(auto& clip:track->clips)if(clip.fx)clip.fx->chain.setEffects(clip.fx->specs,bpm,barBeats);
   }
   refreshTiming();
  }
  void reset(int64_t start=0){frame=start;master.reset();masterGain.reset();for(auto&pair:tracks){auto& track=*pair.second;track.fx.reset();track.align.reset();track.volume.reset();track.audition.reset();track.sidechain.size=0;for(auto& clip:track.clips){clip.audition.reset();if(clip.fx){clip.fx->chain.reset();clip.fx->reported=false;}}}resetMeters();latestMeters=json::object();latestEffects=json::object();}
 static double envelope(const json&c,double local){
  if(c.contains("envelope")){const auto&e=c.at("envelope");if(local<=e[0].at("time").get<double>())return e[0].at("gain");for(size_t k=1;k<e.size();k++){double b=e[k].at("time");if(local<=b){double a=e[k-1].at("time"),g=e[k-1].at("gain");return g+(e[k].at("gain").get<double>()-g)*(local-a)/(b-a);}}return e.back().at("gain");}
  double result=1,fi=c.value("fadeIn",0.),fo=c.value("fadeOut",0.),duration=c.at("duration");if(fi>0)result=std::min(result,local/fi);if(fo>0)result=std::min(result,(duration-local)/fo);return std::clamp(result,0.,1.);
 }
 static void meterTap(void*context,const char*id,const float*L,const float*R,int n){auto&self=*(Graph*)context;auto it=self.nodeMeters.find(id);if(it==self.nodeMeters.end())return;std::array<float,BLOCK*2>buffer;for(int i=0;i<n;i++){buffer[i*2]=L[i];buffer[i*2+1]=R[i];}it->second->add(buffer.data(),n);}
 static visiki::dsp_detail::SidechainBlockView sidechainTap(void* context,const std::string& sourceId,const std::string& owner,int64_t start,int count){
  auto& graph=*static_cast<Graph*>(context);
  visiki::dsp_detail::SidechainBlockView signal;
  if(const auto track=graph.tracks.find(owner);track!=graph.tracks.end())signal.programGain=track->second->volume.target;
  if(sourceId.empty()||sourceId==owner)return signal;
  const auto found=graph.tracks.find(sourceId);
  if(found==graph.tracks.end()||found->second->inaudible)return signal;
  auto& cache=found->second->sidechain;
  signal.peak=cache.peaks.data();signal.power=cache.powers.data();signal.keyGain=found->second->volume.target;
  signal.left=cache.left.data();signal.right=cache.right.data();
  if(cache.size==count&&cache.start==start)return signal;

  // Source clips are tapped before inserts, pan and fader. Reading at the
  // receiver's project time keeps the detector aligned through any PDC.
  auto& left=cache.left;auto& right=cache.right;
  std::fill_n(left.begin(),count,0.f);std::fill_n(right.begin(),count,0.f);
  for(const auto& clip:found->second->clips){
   if(clip.first>=start+count||clip.last<=start)continue;
   const int first=static_cast<int>(std::clamp<int64_t>(clip.first-start,0,count));
   const int last=static_cast<int>(std::clamp<int64_t>(clip.last-start,0,count));
   for(int i=first;i<last;++i){
    const double local=std::max(0.,double(start+i)/graph.rate-clip.start);
    const auto sample=clip.source->samplePair((clip.sourceIn+local)*clip.source->rate);
    const float gain=static_cast<float>(clip.gain*clip.level(local));
    left[i]+=sample[0]*gain;right[i]+=sample[1]*gain;
   }
  }
  for(int i=0;i<count;++i){
   cache.peaks[i]=std::max(std::abs(left[i]),std::abs(right[i]));
   cache.powers[i]=.5f*(left[i]*left[i]+right[i]*right[i]);
  }
  cache.start=start;cache.size=count;
  return signal;
 }
 void resetMeters(){if(loud)loud=std::make_unique<MeterState>(rate);for(auto&pair:nodeMeters)pair.second=std::make_unique<MeterState>(rate);latestMeters=json::object();latestEffects=json::object();master.resetMeasurements();collect(master);for(auto&pair:tracks){pair.second->fx.resetMeasurements();collect(pair.second->fx);for(auto& clip:pair.second->clips)if(clip.fx)clip.fx->chain.resetMeasurements();}}
 json loudness(){return loud?readLoudness(*loud):json(nullptr);}
 static json measure(float*l,float*r,int n){double p=0,e=0;for(int i=0;i<n;i++){p=std::max(p,double(std::max(std::abs(l[i]),std::abs(r[i]))));e+=double(l[i])*l[i]+double(r[i])*r[i];}return{{"peak",p},{"rms",std::sqrt(e/(n*2))}};}
 void collect(visiki::EffectChain&chain){for(const auto&m:chain.effectMeasurements()){auto&j=latestEffects[m.id];j={{"inputPeak",m.inputPeak},{"outputPeak",m.outputPeak},{"inputRms",m.inputRms},{"outputRms",m.outputRms},{"gainReductionDb",m.gainReductionDb}};if(m.hasBandReduction)j["bandReductionDb"]=m.bandReductionDb;if(m.hasTransientGain)j["transientGainDb"]=m.transientGainDb;if(m.hasMultibandReduction)j["multibandReductionDb"]=m.multibandReductionDb;if(m.hasSidechain)j["sidechainInputDb"]=m.sidechainInputDb;if(m.hasDuckerBalance){j["duckerKeyDb"]=m.duckerKeyDb;j["duckerProgramDb"]=m.duckerProgramDb;}visiki::DspMeasurement values;if(chain.effectMeterMeasurement(m.id,values)){j["spectrum"]=values.spectrum;j["peakLeft"]=values.peakLeft;j["peakRight"]=values.peakRight;j["rmsLeft"]=values.rmsLeft;j["rmsRight"]=values.rmsRight;j["crestDb"]=values.crestDb;j["correlation"]=values.correlation;auto it=nodeMeters.find(m.id);if(it!=nodeMeters.end())j["loudness"]=readLoudness(*it->second);}}}
 void process(float*L,float*R,int n,bool meters=true,bool analyze=true){
  std::fill_n(L,n,0.f);std::fill_n(R,n,0.f);
  analyze=analyze&&preview;
  for(auto&pair:tracks){auto&tr=*pair.second;auto*l=tr.l.data(),*r=tr.r.data();std::fill_n(l,n,0.f);std::fill_n(r,n,0.f);
   if(!tr.inaudible){
    const double angle=std::abs(tr.pan)*M_PI/2,cs=std::cos(angle),sn=std::sin(angle),ml=std::cos((tr.pan+1)*M_PI/4),mr=std::sin((tr.pan+1)*M_PI/4);
    const int64_t clipFrame=frame-tr.clipLatency;
    for(auto& c:tr.clips){
     // Each clip's source is available on demand. Read ahead by its own fixed DSP delay
     // so that every branch reaches the track at the same project sample.
     const int64_t dspFrame=clipFrame+(c.fx?c.fx->chain.latencySamples():0);
     const bool audible=c.first<clipFrame+n&&c.last>clipFrame;
     const bool processFx=c.fx&&c.first<dspFrame+n&&c.last>clipFrame;
     if(!audible&&!processFx){
      c.audition.reset();
      if(meters&&c.fx&&c.fx->reported){for(const auto& spec:c.fx->specs)latestEffects.erase(spec.id);c.fx->reported=false;}
      continue;
     }
     auto read=[&](int64_t sample){
      const auto& source=*c.source;
      const double local=std::max(0.,double(sample)/rate-c.start),pos=(c.sourceIn+local)*source.rate,g=c.gain*c.level(local);
      auto [left,right]=source.samplePair(pos);
      if(source.channels==1){left*=float(ml);right*=float(mr);}
      else if(tr.pan>=0){right+=float(sn*left);left*=float(cs);}
      else{left+=float(sn*right);right*=float(cs);}
      return std::array<float,2>{float(left*g),float(right*g)};
     };
     const int begin=int(std::clamp<int64_t>(c.first-clipFrame,0,n)),end=int(std::clamp<int64_t>(c.last-clipFrame,0,n));
     if(!processFx){
      for(int i=begin;i<end;++i){const auto sample=read(clipFrame+i);const float level=float(c.audition.next());l[i]+=sample[0]*level;r[i]+=sample[1]*level;}
      continue;
     }
     std::array<float,BLOCK> left{},right{};
     const int inStart=int(std::clamp<int64_t>(c.first-dspFrame,0,n)),inEnd=int(std::clamp<int64_t>(c.last-dspFrame,0,n));
     for(int i=inStart;i<inEnd;++i){const auto sample=read(dspFrame+i);left[i]=sample[0];right[i]=sample[1];}
     c.fx->chain.process(left.data(),right.data(),n,meters,analyze,dspFrame);
     const int edge=std::max(1,int(std::min<int64_t>(rate/500,(c.last-c.first)/4)));
     for(int i=begin;i<end;++i){
      const int64_t sample=clipFrame+i,distance=std::min(sample-c.first,c.last-1-sample);
      if(distance<edge){const float blend=float(distance)/edge;const auto dry=read(sample);left[i]=dry[0]+blend*(left[i]-dry[0]);right[i]=dry[1]+blend*(right[i]-dry[1]);}
      const float level=float(c.audition.next());l[i]+=left[i]*level;r[i]+=right[i]*level;
     }
     if(meters){collect(c.fx->chain);c.fx->reported=true;}
    }
    tr.fx.process(l,r,n,meters,analyze,clipFrame);tr.align.process(l,r,n);
    if(auto it=autoMixAnalyses.find(pair.first);it!=autoMixAnalyses.end())it->second->push(frame-trackLatency,l,r,n);
    for(int i=0;i<n;i++){const float level=float(tr.volume.next()), audition=float(tr.audition.next());l[i]*=level;r[i]*=level;L[i]+=l[i]*audition;R[i]+=r[i]*audition;}
   }
   if(tr.inaudible)if(auto it=autoMixAnalyses.find(pair.first);it!=autoMixAnalyses.end())it->second->push(frame-trackLatency,l,r,n);
   if(meters){latestMeters[pair.first]=measure(l,r,n);collect(tr.fx);}
  }
  for(int i=0;i<n;i++){const float level=float(masterGain.next());L[i]*=level;R[i]*=level;}master.process(L,R,n,meters,analyze,frame-trackLatency);for(int i=0;i<n;i++){if(!std::isfinite(L[i])||!std::isfinite(R[i]))throw std::runtime_error("Non-finite DSP output");if(analyze){interleaved[i*2]=L[i];interleaved[i*2+1]=R[i];}}
  if(analyze&&loud)loud->add(interleaved.data(),n);if(meters){latestMeters["__master__"]=measure(L,R,n);collect(master);}frame+=n;
 }
 static json readLoudness(const MeterState& meter){
  auto value=[&](int64_t minimum,auto measure)->json{double reading=0;return meter.frames>=minimum&&measure(meter.state,&reading)==EBUR128_SUCCESS&&std::isfinite(reading)?json(reading):json(nullptr);};
  const int64_t momentary=int64_t(meter.rate)*4/10,shortTerm=int64_t(meter.rate)*3;
  const auto integrated=value(momentary,ebur128_loudness_global);
  const auto shortReading=value(shortTerm,ebur128_loudness_shortterm);
  double peak=0;
  for(int channel=0;channel<2;++channel){double reading=0;if(ebur128_true_peak(meter.state,channel,&reading)==EBUR128_SUCCESS&&std::isfinite(reading))peak=std::max(peak,reading);}
  return {{"momentary",value(momentary,ebur128_loudness_momentary)},{"shortTerm",shortReading},{"integrated",integrated},{"lra",shortReading.is_null()||integrated.is_null()?json(nullptr):value(int64_t(meter.rate)*4,ebur128_loudness_range)},{"truePeak",meter.frames&&peak>0?json(db(peak)):json(nullptr)}};
 }
};
static json playbackLayout(const json& session){
 const auto grid=session.value("musicalGrid",json::object());
 auto layout=[&](const json& owner,const char* key){json list=json::array();for(const auto& item:owner.value(key,json::array()))if(item.value("enabled",true)){
  const auto type=item.at("type").get<std::string>();const auto& params=item.at("params");
  json identity=json::array({item.at("id"),type});
  if(type=="vst3"){identity.push_back(item.at("vst3").at("classId"));identity.push_back(item.at("vst3").at("modulePath"));}
  else if(type=="saturation")identity.push_back(params.value("oversample",1.));
  else if(type=="limiter"){identity.push_back(params.value("lookaheadMs",5.));identity.push_back(params.value("truePeak",0.));}
  else if(type=="convolution")identity.push_back(params.value("space",0.));
  else if(type=="lofi")identity.push_back(params.value("style",0.));
  else if(type=="ducker")identity.push_back(params.value("mode",0.)==2.);
  else if(type=="denoise"){
   const int mode=std::clamp(params.value("repairMode",0),0,2);
   const bool spectral=params.value("spectralEnabled",mode==0?1.0:0.0)>.5;
   const bool hum=params.value("humEnabled",mode==1?1.0:0.0)>.5;
   const bool dereverb=params.value("dereverbEnabled",mode==2?1.0:0.0)>.5;
   identity.push_back(spectral);identity.push_back(hum);identity.push_back(dereverb);
   identity.push_back(spectral&&item.contains("noiseProfile"));
  }
  else if(type=="pedal"){identity.push_back(params.value("mode",0.));identity.push_back(params.value("oversample",1.));}
  else if(type=="modulation"){
   const bool sync=params.value("sync",0.)>.5;
   identity.push_back(params.value("mode",0.));identity.push_back(params.value("stages",1.));identity.push_back(params.value("waveform",0.));identity.push_back(sync);
   if(sync){identity.push_back(params.value("note",9.));identity.push_back(grid.value("bpm",120.));identity.push_back(grid.value("beatsPerBar",4));identity.push_back(grid.value("beatUnit",4));}
  }
  list.push_back(std::move(identity));
 }return list;};
 const auto& tracks=session.at("tracks");const bool solo=std::any_of(tracks.begin(),tracks.end(),[](const json& track){return track.value("solo",false);});
 json branches=json::object(),assets=json::object();
 for(const auto& track:tracks)if(!track.value("muted",false)&&(!solo||track.value("solo",false))){
  json clips=json::array();
  for(const auto& clip:track.at("clips")){
   auto inserts=layout(clip,"effects");if(inserts.empty())continue;
   clips.push_back(json::array({clip.at("id"),clip.at("assetId"),clip.at("start"),clip.at("sourceIn"),clip.at("duration"),std::move(inserts)}));
  }
  branches[track.at("id").get<std::string>()]=json::array({layout(track,"effects"),std::move(clips)});
 }
 for(const auto& asset:session.at("assets"))assets[asset.at("id").get<std::string>()]=asset.value("file",std::string{});
 return json::array({session.value("id",std::string{}),session.at("sampleRate"),assets,branches,layout(session,"masterEffects")});
}
static void advanceTo(Graph& graph,int64_t target){
 std::array<float,BLOCK> left,right;
 while(graph.frame<target)graph.process(left.data(),right.data(),int(std::min<int64_t>(BLOCK,target-graph.frame)),false,false);
}
struct PreparedChange {
 std::unique_ptr<Graph> graph;
 std::vector<std::array<float,BLOCK*2>> overlap;
 int64_t start=0;
};
static void setNoiseListening(Graph& graph,const std::string& id){
 auto hasNoise=[&](const auto& specs){return std::any_of(specs.begin(),specs.end(),[&](const auto& spec){return spec.type=="denoise"&&spec.enabled&&spec.id==id&&([&]{const auto modes=visiki::dsp_detail::denoiseModes(spec);return modes.hum||modes.dereverb||(modes.spectral&&!spec.noiseProfile.empty());}());});};
 Track* selected=nullptr;ClipData* selectedClip=nullptr;
 if(!id.empty())for(auto& pair:graph.tracks){
  auto& track=*pair.second;if(track.inaudible)continue;
  if(hasNoise(track.specs))selected=&track;
  for(auto& clip:track.clips)if(clip.fx&&hasNoise(clip.fx->specs)){selected=&track;selectedClip=&clip;break;}
  if(selected)break;
 }
 graph.master.listenRemoved(!id.empty()&&hasNoise(graph.masterSpecs)?id:"");
 for(auto& pair:graph.tracks){
  auto& track=*pair.second;track.fx.listenRemoved(selected==&track&&!selectedClip?id:"");track.audition.target=selected&&selected!=&track?0:1;
  for(auto& clip:track.clips){
   if(clip.fx)clip.fx->chain.listenRemoved(selectedClip==&clip?id:"");
   clip.audition.target=selected==&track&&selectedClip&&selectedClip!=&clip?0:1;
  }
 }
}
static PreparedChange prepareChange(const json& session,const std::atomic<int64_t>& produced,std::map<std::string,std::shared_ptr<Source>> sources,ResampleKernels kernels,const std::string& listenNoise){
 PreparedChange next;next.graph=std::make_unique<Graph>();next.graph->sources=std::move(sources);next.graph->kernels=std::move(kernels);next.graph->set(session,true);
 const int rate=next.graph->rate,warmup=int(std::clamp<int64_t>(next.graph->lookback,rate/10,rate/2));
 next.overlap.resize((int(std::ceil(.012*rate))+BLOCK-1)/BLOCK);
 int64_t lead=6*BLOCK;
 for(int attempt=0;attempt<4;++attempt){
  const int64_t before=produced.load();next.start=before+lead;
  if(!listenNoise.empty())setNoiseListening(*next.graph,listenNoise);
  next.graph->reset(std::max<int64_t>(0,next.start-warmup));advanceTo(*next.graph,next.start+next.graph->latency);
  for(auto& block:next.overlap)next.graph->process(block.data(),block.data()+BLOCK,BLOCK,false);
  const int64_t elapsed=produced.load()-before;
  if(lead>=elapsed+4*BLOCK)return next;
  lead=std::max(lead*2,elapsed*2+4*BLOCK);
 }
 throw std::runtime_error("Could not prepare the effect transition in time");
}
struct GraphChange {
 std::future<PreparedChange> task;
 PreparedChange next;
 std::string request;
 json layout;
 size_t block=0;
 double compareDb=0;float compareGain=1;
};
struct Ring{
 static constexpr uint64_t CAP=16384;std::array<float,CAP*2>samples{};std::atomic<uint64_t>read{0},write{0},consumed{0},underruns{0};std::atomic<float>monitor{1};std::atomic<bool>active{false};
 float currentGain=1,targetGain=1,step=0;uint32_t rampLeft=0;
 uint64_t available(){return write.load(std::memory_order_acquire)-read.load(std::memory_order_acquire);}
 void clear(){read=0;write=0;consumed=0;}
 void put(float*l,float*r,int n){auto w=write.load();for(int k=0;k<n;k++){samples[((w+k)%CAP)*2]=l[k];samples[((w+k)%CAP)*2+1]=r[k];}write.store(w+n,std::memory_order_release);}
 static void callback(ma_device*d,void*out,const void*,ma_uint32 frames){auto&ring=*(Ring*)d->pUserData;auto*f=(float*)out;std::fill_n(f,frames*2,0.f);if(!ring.active.load())return;uint64_t r=ring.read.load(),w=ring.write.load(std::memory_order_acquire),n=std::min<uint64_t>(frames,w-r);const float target=ring.monitor.load();
  if(!ring.consumed.load()){ring.currentGain=ring.targetGain=target;ring.rampLeft=0;}
  if(target!=ring.targetGain){ring.targetGain=target;ring.rampLeft=std::max(1u,d->sampleRate/100);ring.step=(target-ring.currentGain)/float(ring.rampLeft);}
  for(uint64_t i=0;i<n;++i){if(ring.rampLeft)ring.currentGain=--ring.rampLeft?ring.currentGain+ring.step:ring.targetGain;f[i*2]=ring.samples[((r+i)%CAP)*2]*ring.currentGain;f[i*2+1]=ring.samples[((r+i)%CAP)*2+1]*ring.currentGain;}
  ring.read.store(r+n,std::memory_order_release);ring.consumed.fetch_add(n);if(n<frames)ring.underruns++;
 }
};
static std::mutex outputMutex;static void emit(const json&j){std::lock_guard<std::mutex> lock(outputMutex);std::cout<<j.dump(-1,' ',false,json::error_handler_t::replace)<<std::endl;}
static void write16(std::ostream&o,uint16_t v){o.write((char*)&v,2);}static void write32(std::ostream&o,uint32_t v){o.write((char*)&v,4);}
static json measureComparison(const std::wstring& job){
 std::ifstream input{std::filesystem::path(job)};json session;input>>session;
 const std::string id=session.at("compareId");const double cursor=session.at("comparePosition");
 ResampleKernels kernels;std::map<std::string,std::shared_ptr<Source>> sources;
 std::array<json,2> levels;
 double windowStart=0,windowEnd=0;
 for(int slot=0;slot<2;++slot){
  Graph graph;graph.kernels=kernels;graph.sources=sources;graph.set(session,true);kernels=graph.kernels;sources=graph.sources;
  int64_t first=0,last=graph.length;
  for(const auto& pair:graph.tracks)for(const auto& clip:pair.second->clips)
   if(clip.fx&&clip.fx->chain.effectInputLatency(id)>=0){first=clip.first;last=clip.last;}
  const int64_t length=std::min<int64_t>(last-first,int64_t(graph.rate)*5);
  const int64_t start=std::clamp<int64_t>(std::llround(cursor*graph.rate),first,last-length);
  windowStart=double(start)/graph.rate;windowEnd=double(start+length)/graph.rate;
  if(length<int64_t(graph.rate)*4/10){levels[slot]=nullptr;break;}
  graph.reset(std::max<int64_t>(0,start-int64_t(graph.rate)));advanceTo(graph,start+graph.latency);
  Graph::MeterState meter(graph.rate);std::array<float,BLOCK> l,r;std::array<float,BLOCK*2> samples;
  for(int64_t remaining=length;remaining>0;){
   const int count=int(std::min<int64_t>(remaining,BLOCK));graph.process(l.data(),r.data(),count,false,false);
   for(int i=0;i<count;++i){samples[i*2]=l[i];samples[i*2+1]=r[i];}meter.add(samples.data(),count);remaining-=count;
  }
  double value=0;levels[slot]=ebur128_loudness_global(meter.state,&value)==EBUR128_SUCCESS&&std::isfinite(value)?json(value):json(nullptr);
  if(levels[slot].is_null())break;
  if(slot==0){
   auto replace=[&](json& owner,const char* key){
    if(owner.contains(key))for(auto& effect:owner.at(key))if(effect.at("id")==id){
     if(!effect.contains("bState"))return false;
     effect["params"]=effect.at("bState");
     if(effect.contains("bNoiseProfile"))effect["noiseProfile"]=effect.at("bNoiseProfile");else effect.erase("noiseProfile");
     if(effect.contains("bSidechainTrackId"))effect["sidechainTrackId"]=effect.at("bSidechainTrackId");else effect.erase("sidechainTrackId");
     return true;
    }
    return false;
   };
   bool updated=replace(session,"masterEffects");
   for(auto& track:session.at("tracks")){
    if(replace(track,"effects"))updated=true;
    for(auto& clip:track.at("clips"))if(replace(clip,"effects"))updated=true;
   }
   if(!updated)throw std::runtime_error("Comparison requires two parameter slots");
  }
 }
 return{{"complete",true},{"activeLufs",levels[0]},{"otherLufs",levels[1]},{"start",windowStart},{"end",windowEnd}};
}
static json learnNoise(const std::wstring& job){
 std::ifstream input{std::filesystem::path(job)};json session;input>>session;
 Graph graph;graph.set(session,session.value("noisePreview",true));
 const std::string target=session.at("noiseTarget"),effectId=session.at("noiseEffect");
 visiki::EffectChain* chain=&graph.master;
 int latency=graph.trackLatency;
 int64_t first=0,last=graph.length;
 if(target.rfind("clip:",0)==0){
  chain=nullptr;const auto clipId=target.substr(5);
  for(auto& pair:graph.tracks){
   auto& track=*pair.second;
   for(auto& clip:track.clips)if(clip.id==clipId&&clip.fx){
    chain=&clip.fx->chain;latency=track.clipLatency-chain->latencySamples();first=clip.first;last=clip.last;break;
   }
   if(chain)break;
  }
  if(!chain)throw std::runtime_error("Selected clip is inaudible");
 }else if(target!="master"){
  auto it=graph.tracks.find(target);if(it==graph.tracks.end()||it->second->inaudible)throw std::runtime_error("Selected track is inaudible");
  chain=&it->second->fx;latency=it->second->clipLatency;
 }
 const int upstream=chain->effectInputLatency(effectId);
 const int64_t start=std::llround(session.at("noiseStart").get<double>()*graph.rate);
 const int64_t duration=std::llround(session.at("noiseDuration").get<double>()*graph.rate);
 if(upstream<0||start<first||duration<graph.rate/2||duration>int64_t(graph.rate)*3||start+duration>last+1)throw std::runtime_error("Invalid noise analysis range");
 graph.reset(std::max<int64_t>(0,start-graph.rate));advanceTo(graph,start+latency+upstream);
 visiki::dsp_detail::DenoiseProfileAnalysis analysis(graph.rate);
 chain->tapEffectInput(effectId,[](void* context,const float* left,const float* right,int n){static_cast<visiki::dsp_detail::DenoiseProfileAnalysis*>(context)->push(left,right,n);},&analysis);
 advanceTo(graph,graph.frame+duration);
 return{{"complete",true},{"noiseProfile",analysis.finish()}};
}
static int autoMixScan(const std::wstring& job){
 std::ifstream input{std::filesystem::path(job)};json session;input>>session;Graph graph;graph.set(session,false);graph.reset();
 const int64_t frames=graph.length+(session.value("includeTail",true)?graph.tail:0);
 const json trackIds=session.value("autoMixOutputOnly",false)?json::array():session.value("autoMixTrackIds",json::array());
 const auto backingId=session.value("autoMixBackingTrackId",std::string{});
 for(size_t i=0;i<trackIds.size();i++){
  const auto name=trackIds.at(i).get<std::string>();
  if(!graph.tracks.count(name))throw std::runtime_error("AutoMix track not found");
  const bool vocal=backingId.empty()?i<2:name!=backingId;
  if(!graph.autoMixAnalyses.emplace(name,std::make_unique<AutoMixTrackAnalysis>(name,graph.rate,graph.length,false,vocal)).second)
   throw std::runtime_error("Duplicate AutoMix track");
 }
 std::map<std::string,std::unique_ptr<AutoMixTrackAnalysis>> dry;
 if(!trackIds.empty()){const auto lead=trackIds.at(0).get<std::string>();dry.emplace(lead,std::make_unique<AutoMixTrackAnalysis>(lead,graph.rate,graph.length,true));}
 const auto probeIds=session.value("autoMixProbeIds",json::array());if(!probeIds.is_array()||probeIds.size()>32)throw std::runtime_error("Invalid AutoMix probes");
 std::map<std::string,bool> validProbes;auto collectProbes=[&](const auto& specs){for(const auto& spec:specs)if(spec.enabled)validProbes[spec.id]=true;};collectProbes(graph.masterSpecs);for(const auto& pair:graph.tracks){collectProbes(pair.second->specs);for(const auto& clip:pair.second->clips)if(clip.fx)collectProbes(clip.fx->specs);}
 const int64_t hop=std::max<int64_t>(1,std::llround(graph.rate*.2)),frameCount=(frames+hop-1)/hop;
 struct Probe {std::vector<double> reduction; double inputEnergy=0,outputEnergy=0;};
 std::map<std::string,Probe> probes;
 for(const auto& id:probeIds){const auto name=id.get<std::string>();if(!validProbes.count(name)||!probes.emplace(name,Probe{std::vector<double>(size_t(frameCount),0)}).second)throw std::runtime_error("Invalid or duplicate AutoMix probe ID");}
 std::array<float,BLOCK> left{},right{},silence{};std::array<float,BLOCK*2> samples{};Graph::MeterState meter(graph.rate);
 const int64_t total=frames+std::max(graph.latency,graph.trackLatency);
 for(int64_t done=0;done<total;){const int n=int(std::min<int64_t>(BLOCK,total-done));graph.process(left.data(),right.data(),n,!probes.empty(),false);
  for(auto& pair:dry){const int64_t projectStart=done-graph.trackLatency;const auto key=Graph::sidechainTap(&graph,pair.first,"",projectStart,n);pair.second->push(projectStart,key.left?key.left:silence.data(),key.right?key.right:silence.data(),n);}
   if(!probes.empty()){
    const int64_t begin=std::max<int64_t>(0,done-graph.trackLatency),end=std::min<int64_t>(frames,done+n-graph.trackLatency);
    if(begin<end)for(auto& [id,probe]:probes){
     const auto it=graph.latestEffects.find(id);if(it==graph.latestEffects.end())continue;
     const double value=it->value("gainReductionDb",0.);
     if(std::isfinite(value))for(int64_t f=begin/hop;f<=(end-1)/hop;f++)probe.reduction[size_t(f)]=std::max(probe.reduction[size_t(f)],std::max(0.,value));
     const double incoming=it->value("inputRms",0.),outgoing=it->value("outputRms",0.);
     if(incoming>.00056&&std::isfinite(incoming)&&std::isfinite(outgoing)){
      probe.inputEnergy+=incoming*incoming*(end-begin);probe.outputEnergy+=outgoing*outgoing*(end-begin);
     }
    }
   }
  int used=0;for(int i=0;i<n;i++){const int64_t pos=done+i-graph.latency;if(pos>=0&&pos<frames){samples[2*used]=left[i];samples[2*used+1]=right[i];used++;}}if(used)meter.add(samples.data(),used);done+=n;
 }
 json tracks=json::array();
 for(const auto& id:trackIds){
  const auto name=id.get<std::string>();const auto& a=*graph.autoMixAnalyses.at(name);json entries=a.frames;
  if(auto key=dry.find(name);key!=dry.end()){
   const auto& raw=key->second->frames;
   for(size_t i=0;i<entries.size()&&i<raw.size();i++){
    entries[i]["keyBandsPeakDb"]=raw[i]["bandPeakDb"];
    entries[i]["keyRmsDb"]=raw[i]["rmsDb"];
   }
  }
  tracks.push_back({{"id",a.id},{"frames",entries}});
 }
 json probeResult=json::object();
 for(auto& [id,probe]:probes){
  auto sorted=probe.reduction;std::sort(sorted.begin(),sorted.end());
  const double max=sorted.empty()?0:sorted.back(),p90=sorted.empty()?0:sorted[size_t(std::ceil(sorted.size()*.9))-1];
  const auto active=std::count_if(sorted.begin(),sorted.end(),[](double value){return value>=.5;});
  const auto loss=probe.inputEnergy>0&&probe.outputEnergy>0?json(10*std::log10(probe.inputEnergy/probe.outputEnergy)):json(nullptr);
  probeResult[id]={{"maxDb",max},{"p90Db",p90},{"activeFraction",sorted.empty()?0.:double(active)/sorted.size()},{"frames",probe.reduction},{"levelLossDb",loss}};
 }
 emit({{"complete",true},{"hopSec",double(hop)/graph.rate},{"tracks",tracks},{"output",Graph::readLoudness(meter)},{"probes",probeResult}});return 0;
}
static int autoMixPreview(const std::wstring& job,const std::wstring& output){
 std::ifstream input{std::filesystem::path(job)};json session;input>>session;Graph graph;graph.set(session,session.value("monitoring",false));
 const double start=session.at("autoMixStart").get<double>(),duration=session.at("autoMixDuration").get<double>();
 if(!std::isfinite(start)||!std::isfinite(duration)||start<0||duration<=0||duration>20+1e-9)throw std::runtime_error("Invalid AutoMix preview range");
 const double monitorTrimDb=session.value("monitorTrimDb",0.);
 if(!std::isfinite(monitorTrimDb)||monitorTrimDb< -60||monitorTrimDb>0)throw std::runtime_error("Invalid preview trim");
 const double monitorGain=gain(monitorTrimDb);
 const int64_t first=std::llround(start*graph.rate),frames=std::llround(duration*graph.rate);
 if(!frames||first>=graph.length+graph.tail||first>INT64_MAX-frames-graph.latency)throw std::runtime_error("Invalid AutoMix preview range");
 const int64_t warm=std::max<int64_t>(0,first-std::max<int64_t>(int64_t(graph.rate)*2,graph.lookback));graph.reset(warm);advanceTo(graph,first+graph.latency);
 std::ofstream file(std::filesystem::path(output),std::ios::binary);if(!file)throw std::runtime_error("Cannot create preview output");
 file.write("RIFF",4);write32(file,uint32_t(frames*6+36));file.write("WAVEfmt ",8);write32(file,16);write16(file,1);write16(file,2);write32(file,graph.rate);write32(file,graph.rate*6);write16(file,6);write16(file,24);file.write("data",4);write32(file,uint32_t(frames*6));
 std::array<float,BLOCK> l{},r{};std::array<float,BLOCK*2> samples{};std::array<char,BLOCK*6> bytes{};Graph::MeterState meter(graph.rate);int64_t written=0,clipped=0;uint32_t random=0x12345678;auto noise=[&](){random=random*1664525+1013904223;return double(random)/4294967296.;};
 while(written<frames){const int n=int(std::min<int64_t>(BLOCK,frames-written));graph.process(l.data(),r.data(),n,false,false);int used=0;for(int i=0;i<n;i++)for(int c=0;c<2;c++){const double sample=(c?r[i]:l[i])*monitorGain;if(sample>1.||sample< -1.)clipped++;const int32_t v=int32_t(std::llround(std::clamp(sample+(noise()-noise())/8388608.,-1.,1.-1./8388608)*8388608));samples[2*i+c]=float(double(v)/8388608.);bytes[used++]=char(v);bytes[used++]=char(v>>8);bytes[used++]=char(v>>16);}file.write(bytes.data(),used);meter.add(samples.data(),n);written+=n;}
 if(!file)throw std::runtime_error("Incomplete preview output");emit({{"complete",true},{"duration",double(frames)/graph.rate},{"sampleCount",frames},{"sampleRate",graph.rate},{"latencySamples",graph.latency},{"clippedSamples",clipped},{"loudness",Graph::readLoudness(meter)}});return 0;
}
static int render(const std::wstring&job,const std::wstring&output){
 std::ifstream input{std::filesystem::path(job)};json session;input>>session;Graph graph;graph.set(session,false);graph.reset();int64_t frames=graph.length+(session.value("includeTail",true)?graph.tail:0),skip=graph.latency,total=frames+skip;
 if(uint64_t(frames)*6+36>0xffffffffULL)throw std::runtime_error("WAV exceeds RIFF size limit");std::ofstream file(std::filesystem::path(output),std::ios::binary);if(!file)throw std::runtime_error("Cannot create render output");file.write("RIFF",4);write32(file,uint32_t(frames*6+36));file.write("WAVEfmt ",8);write32(file,16);write16(file,1);write16(file,2);write32(file,graph.rate);write32(file,graph.rate*6);write16(file,6);write16(file,24);file.write("data",4);write32(file,uint32_t(frames*6));
 std::array<float,BLOCK>l{},r{};std::array<float,BLOCK*2>outputSamples{};std::array<char,BLOCK*6>bytes{};Graph::MeterState outputMeter(graph.rate);int64_t written=0,clipped=0;uint32_t random=0x12345678;auto noise=[&](){random=random*1664525+1013904223;return double(random)/4294967296.;};
 for(int64_t done=0;done<total;){int n=int(std::min<int64_t>(BLOCK,total-done));graph.process(l.data(),r.data(),n,false,false);int first=int(std::min<int64_t>(n,std::max<int64_t>(0,skip-done))),used=0,samples=0;for(int k=first;k<n;k++)for(int c=0;c<2;c++){double sample=c?r[k]:l[k];if(sample>1.||sample< -1.)clipped++;int32_t v=int32_t(std::llround(std::clamp(sample+(noise()-noise())/8388608.,-1.,1.-1./8388608)*8388608));outputSamples[samples++]=float(double(v)/8388608.);bytes[used++]=char(v);bytes[used++]=char(v>>8);bytes[used++]=char(v>>16);}file.write(bytes.data(),used);if(samples)outputMeter.add(outputSamples.data(),samples/2);written+=used/6;done+=n;}
 if(!file||written!=frames)throw std::runtime_error("Incomplete render output");emit({{"complete",true},{"duration",double(frames)/graph.rate},{"sampleCount",frames},{"sampleRate",graph.rate},{"latencySamples",graph.latency},{"tailSeconds",double(frames-graph.length)/graph.rate},{"clippedSamples",clipped},{"loudness",Graph::readLoudness(outputMeter)}});return 0;
}
int wmain(int argc,wchar_t**argv){
 try{
  if(argc==3&&std::wstring(argv[1])==L"--scan-vst3"){emit(visiki::vst3::scanModule(utf8(argv[2])));return 0;}
  if(argc==3&&std::wstring(argv[1])==L"--vst3-parameters"){std::ifstream input{std::filesystem::path(argv[2])};json job;input>>job;emit(visiki::vst3::inspectParameters(job));return 0;}
  if(argc==4&&std::wstring(argv[1])==L"--render")return render(argv[2],argv[3]);
  if(argc==3&&std::wstring(argv[1])==L"--automix-scan")return autoMixScan(argv[2]);
  if(argc==4&&std::wstring(argv[1])==L"--automix-preview")return autoMixPreview(argv[2],argv[3]);
  if(argc==3&&std::wstring(argv[1])==L"--compare"){emit(measureComparison(argv[2]));return 0;}
  if(argc==3&&std::wstring(argv[1])==L"--learn-noise"){emit(learnNoise(argv[2]));return 0;}
  // The live controller and its Win32 editor share this thread. The
  // WASAPI callback continues to read the ring buffer on its own thread.
  struct OleScope{
   HRESULT result=OleInitialize(nullptr);
   ~OleScope(){if(SUCCEEDED(result))OleUninitialize();}
  } ole;
  using SetDpiContext=HANDLE(WINAPI*)(HANDLE);
  const auto setDpiContext=reinterpret_cast<SetDpiContext>(GetProcAddress(GetModuleHandleW(L"user32.dll"),"SetThreadDpiAwarenessContext"));
  if(setDpiContext)setDpiContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  std::mutex queueMutex;std::condition_variable wake;std::deque<json>queue;std::atomic<bool>quit{false};std::thread input([&](){std::string line;while(std::getline(std::cin,line)){if(line.size()>8*1024*1024){emit({{"error","Command too large"}});continue;}try{auto command=json::parse(line);{std::lock_guard<std::mutex>lock(queueMutex);if(queue.size()<128)queue.push_back(std::move(command));}wake.notify_one();}catch(const std::exception&e){emit({{"error",e.what()}});}}quit=true;wake.notify_one();});
  std::uint64_t vst3EditSequence=0;
  std::string projectId;
  Ring ring;ma_device device{};bool deviceReady=false,playing=false;std::unique_ptr<Graph>graph;double base=0;auto stamp=std::chrono::steady_clock::now();
  visiki::dsp_detail::Slew compareSlew;double compareDb=0;std::string listenNoise;
  auto setCompare=[&](double value,bool immediate){compareDb=value;visiki::dsp_detail::setSlew(compareSlew,gain(value),graph?graph->rate:48000,5,immediate);};
  auto scaleCompare=[&](float* l,float* r){if(std::abs(compareSlew.current-compareSlew.target)<1e-6)compareSlew.reset();if(compareSlew.current==1&&compareSlew.target==1)return;for(int i=0;i<BLOCK;++i){const float level=float(compareSlew.next());l[i]*=level;r[i]*=level;}};
  std::atomic<int64_t> produced{0};std::unique_ptr<GraphChange> change;std::future<void> retired;json layout;std::deque<json> pending;
  auto position=[&](){return base+(graph?double(ring.consumed.load())/graph->rate:0);};
  auto stopDevice=[&](){ring.active=false;if(deviceReady)ma_device_stop(&device);playing=false;};
  auto initDevice=[&](){if(deviceReady){ma_device_uninit(&device);deviceReady=false;}auto config=ma_device_config_init(ma_device_type_playback);config.playback.format=ma_format_f32;config.playback.channels=2;config.sampleRate=graph->rate;config.periodSizeInFrames=512;config.dataCallback=Ring::callback;config.pUserData=&ring;ma_backend backends[]={ma_backend_wasapi};if(ma_device_init_ex(backends,1,nullptr,&config,&device)!=MA_SUCCESS)throw std::runtime_error("WASAPI output device unavailable");deviceReady=true;};
  auto prime=[&](double time){stopDevice();ring.clear();base=time;int64_t desired=int64_t(std::round(time*graph->rate));int64_t first=std::max<int64_t>(0,desired-std::max<int64_t>(graph->rate*2,graph->lookback));graph->reset(first);advanceTo(*graph,desired+graph->latency);compareSlew.reset();std::array<float,BLOCK>left,right;for(int block=0;block<4;++block){graph->process(left.data(),right.data(),BLOCK,block==3);scaleCompare(left.data(),right.data());ring.put(left.data(),right.data(),BLOCK);}produced=graph->frame-graph->latency;};
  auto startDevice=[&](){if(!deviceReady)initDevice();ring.active=true;if(ma_device_start(&device)!=MA_SUCCESS){ring.active=false;throw std::runtime_error("Could not start audio output");}playing=true;};
  auto reply=[&](const std::string& request){emit({{"reply",request},{"ok",true},{"playing",playing},{"position",position()}});};
  auto editorReply=[&](const std::string& request,json values){
   values["reply"]=request;values["ok"]=true;values["playing"]=playing;values["position"]=position();
   values["vst3Editors"]=graph?graph->openVst3EditorIds():json::array();
   emit(values);
  };
  auto publishChange=[&](){
   retired=std::async(std::launch::async,[old=std::move(graph)]()mutable{old.reset();});
   graph=std::move(change->next.graph);layout=std::move(change->layout);setCompare(change->compareDb,true);reply(change->request);change.reset();
  };
  emit({{"ready",true},{"engine","Visiki Native DSP"},{"version",1}});
  while(!quit){
   visiki::vst3::pumpEditorWindows();
   if(graph)graph->serviceVst3Editors();
   if(!change&&pending.empty()){std::lock_guard<std::mutex>lock(queueMutex);pending.swap(queue);}
   while(!change&&!pending.empty()){const auto command=std::move(pending.front());pending.pop_front();std::string request=command.value("requestId","");try{std::string op=command.at("op");
    if(op=="session"){
     const auto& session=command.at("session");auto nextLayout=playbackLayout(session);
     const int rate=session.at("sampleRate");const bool resume=playing;
     const auto nextProjectId=session.value("id",std::string{});
     if(graph&&(graph->rate!=rate||projectId!=nextProjectId))graph->closeVst3Editors();
     projectId=nextProjectId;
     const auto vst3After=command.value("vst3After",std::uint64_t{0});
     const bool layoutChanged=layout!=nextLayout;
     const bool vst3Change=layoutChanged&&(containsEnabledVst3(session)||(graph&&(graph->hasVst3||!graph->vst3Editors.empty())));
     if(graph&&resume&&graph->rate==rate&&layoutChanged&&!vst3Change){
      change=std::make_unique<GraphChange>();change->request=request;change->layout=std::move(nextLayout);
      change->compareDb=command.value("compareDb",compareDb);change->compareGain=float(gain(change->compareDb));
      produced=graph->frame-graph->latency;
      change->task=std::async(std::launch::async,[session,&produced,sources=graph->sources,kernels=graph->kernels,listenNoise]()mutable{return prepareChange(session,produced,std::move(sources),std::move(kernels),listenNoise);});continue;
     }
     if(!graph||graph->rate!=rate){double old=position();stopDevice();if(deviceReady){ma_device_uninit(&device);deviceReady=false;}ring.clear();base=old;graph=std::make_unique<Graph>();graph->set(session,true,false,vst3After);setNoiseListening(*graph,listenNoise);setCompare(command.value("compareDb",compareDb),true);if(resume){prime(old);startDevice();}}
     else {
      const double old=position();
      if(resume&&vst3Change){stopDevice();base=old;ring.clear();}
      graph->set(session,true,false,vst3After);
      setNoiseListening(*graph,listenNoise);
      if(command.contains("compareDb"))setCompare(command.at("compareDb"),!playing);
      if(resume&&vst3Change){prime(std::min(old,double(graph->length)/graph->rate));startDevice();}
     }
     layout=std::move(nextLayout);
     graph->serviceVst3Editors(false,true);
    }
    else if(op=="mix"){
     if(!graph)throw std::runtime_error("Load a session first");
     graph->mix(command.at("mix"),command.value("vst3After",std::uint64_t{0}));
     graph->serviceVst3Editors(false,true);
     if(command.contains("compareDb"))setCompare(command.at("compareDb"),!playing);
    }
    else if(op=="vst3-parameter-values"){
     json values=json::array();
     try {
      for(const auto& item:command.at("requests")){
       const auto id=item.at("effectId").get<std::string>();
       json entry={{"effectId",id},{"state","unavailable"},{"values",json::array()}};
       try {
        if(graph){const auto [spec,processor]=graph->findVst3(id);
         if(spec){
          entry["state"]=spec->enabled?(processor?"active":"unavailable"):"bypassed";
          auto* instance=processor;
          if(!instance){const auto editor=graph->vst3Editors.find(id);if(editor!=graph->vst3Editors.end())instance=editor->second.bypassedInstance.get();}
          if(instance)entry["values"]=visiki::vst3::parameterValues(*instance,item.at("paramIds"));
         }
        }
       }catch(const std::exception&) {entry["state"]="unavailable";entry["values"]=json::array();}
       values.push_back(std::move(entry));
      }
     }catch(const std::exception&) { /* A failed probe must never interrupt playback. */ }
     editorReply(request,{{"vst3Values",values}});continue;
    }
    else if(op=="vst3-open"){
     json values={{"editorOpened",false}};
     try {
      if(!graph)throw std::runtime_error("Load a session first");
      const auto id=command.at("effectId").get<std::string>();
      values["editorOpened"]=graph->openVst3Editor(id,command.at("plugin"),[&vst3EditSequence,id](const auto& params){
       const auto seq=++vst3EditSequence;
       emit({{"vst3Edit",{{"seq",seq},{"effectId",id},{"params",params}}}});
       return seq;
      });
     } catch(const std::exception& error) { values["editorError"]=error.what(); }
     editorReply(request,std::move(values));continue;
    }
    else if(op=="vst3-sync"){
     if(graph)graph->serviceVst3Editors(true);
     editorReply(request,json::object());continue;
    }
    else if(op=="vst3-close"){
     if(graph)graph->closeVst3Editors();
     editorReply(request,json::object());continue;
    }
    else if(op=="play"){if(!graph)throw std::runtime_error("Load a session first");double time=command.value("position",position());if(time>=double(graph->length)/graph->rate)time=0;prime(time);startDevice();}
    else if(op=="pause"){double time=position();stopDevice();base=time;ring.clear();}
    else if(op=="seek"){double time=command.value("position",0.);if(graph&&playing){prime(time);startDevice();}else{base=time;ring.clear();}}
    else if(op=="monitor"){ring.monitor=float(gain(command.value("db",0.)));if(command.contains("compareDb"))setCompare(command.at("compareDb"),!playing);}
    else if(op=="listen-noise"){listenNoise=command.value("effectId",std::string{});if(graph)setNoiseListening(*graph,listenNoise);}
    else if(op=="reset-meters"){if(graph){graph->resetMeters();emit({{"reply",request},{"ok",true},{"playing",playing},{"position",position()},{"meters",graph->latestMeters},{"effects",graph->latestEffects},{"loudness",graph->loudness()}});continue;}}
    else if(op=="quit"){quit=true;stopDevice();}
    else throw std::runtime_error("Unsupported native command");
    reply(request);
   }catch(const std::exception&e){change.reset();const double time=position();stopDevice();ring.clear();base=time;emit({{"reply",request},{"error",e.what()},{"playing",false}});}}
   if(change&&change->task.valid()&&change->task.wait_for(std::chrono::seconds(0))==std::future_status::ready){
    try{change->next=change->task.get();if(!playing)publishChange();}
    catch(const std::exception& error){const double time=position();stopDevice();base=time;ring.clear();emit({{"reply",change->request},{"error",error.what()},{"playing",false}});change.reset();}
   }
   auto now=std::chrono::steady_clock::now();const bool telemetry=now-stamp>=std::chrono::milliseconds(50);
   bool wrote=false;
   if(playing&&graph){
    if(position()>=double(graph->length+graph->tail)/graph->rate){double end=double(graph->length)/graph->rate;stopDevice();base=end;ring.clear();if(change&&change->next.graph)publishChange();}
    else if(ring.available()<2048){
     std::array<float,BLOCK> left,right;
     try{
      const int64_t nextFrame=graph->frame-graph->latency;
      graph->process(left.data(),right.data(),BLOCK,telemetry);
      if(change&&change->next.graph&&nextFrame>=change->next.start){
       if(nextFrame!=change->next.start+int64_t(change->block)*BLOCK)throw std::runtime_error("Missed the effect transition boundary");
       const auto& buffer=change->next.overlap.at(change->block);
       const size_t count=change->next.overlap.size()*BLOCK;
       scaleCompare(left.data(),right.data());
       for(int sample=0;sample<BLOCK;++sample){const float blend=float(change->block*BLOCK+sample)/float(count-1);left[sample]+=(buffer[sample]*change->compareGain-left[sample])*blend;right[sample]+=(buffer[BLOCK+sample]*change->compareGain-right[sample])*blend;}
       if(++change->block==change->next.overlap.size())publishChange();
      }else scaleCompare(left.data(),right.data());
      ring.put(left.data(),right.data(),BLOCK);produced=graph->frame-graph->latency;wrote=true;
     }catch(const std::exception& error){const double time=position();stopDevice();base=time;ring.clear();if(change){emit({{"reply",change->request},{"error",error.what()},{"playing",false}});change.reset();}else emit({{"error",error.what()}});}
    }
   }
   if(telemetry){stamp=now;json status={{"status",true},{"playing",playing},{"position",position()},{"underruns",ring.underruns.load()},{"vst3Editors",graph?graph->openVst3EditorIds():json::array()}};if(graph){status["meters"]=graph->latestMeters;status["effects"]=graph->latestEffects;status["loudness"]=graph->loudness();status["latencySamples"]=graph->latency;status["sampleRate"]=graph->rate;}emit(status);}
   if(!wrote){std::unique_lock<std::mutex> lock(queueMutex);wake.wait_for(lock,std::chrono::milliseconds(playing||change?2:20),[&]{return quit||(!change&&!queue.empty());});}
  }
  stopDevice();if(deviceReady)ma_device_uninit(&device);if(input.joinable()){if(!std::cin.eof())CancelSynchronousIo((HANDLE)input.native_handle());input.join();}graph.reset();return 0;
 }catch(const std::exception&e){emit({{"error",e.what()}});return 1;}
}
