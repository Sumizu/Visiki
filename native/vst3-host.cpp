#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "vst3-host.h"
#include "vst3-window.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstunits.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugview.h"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <mutex>
#include <set>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#endif

namespace visiki::vst3 {
namespace {
using namespace Steinberg;
using namespace Steinberg::Vst;
using VST3::Hosting::ClassInfo;
using VST3::Hosting::Module;
using json = nlohmann::json;

HostApplication* host() {
    static IPtr<HostApplication> instance = owned(new HostApplication());
    static std::once_flag once;
    std::call_once(once, [] { PluginContextFactory::instance().setPluginContext(instance); PlugProvider::setErrorStream(nullptr); });
    return instance;
}
std::string utf8(const TChar* value) {
#ifdef _WIN32
    int count = 0; while (count < 128 && value[count]) ++count;
    if (!count) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, reinterpret_cast<const wchar_t*>(value), count, nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, reinterpret_cast<const wchar_t*>(value), count, &result[0], size, nullptr, nullptr);
    return result;
#else
    std::string result;
    for (int i=0; i<128 && value[i]; ++i) {
        uint32_t c = static_cast<uint16_t>(value[i]);
        if (c >= 0xd800 && c <= 0xdbff && i+1 < 128 && value[i+1] >= 0xdc00 && value[i+1] <= 0xdfff)
            c = 0x10000 + ((c-0xd800)<<10) + (static_cast<uint16_t>(value[++i])-0xdc00);
        if (c < 0x80) result.push_back(static_cast<char>(c));
        else if (c < 0x800) { result.push_back(static_cast<char>(0xc0|(c>>6))); result.push_back(static_cast<char>(0x80|(c&63))); }
        else if (c < 0x10000) { result.push_back(static_cast<char>(0xe0|(c>>12))); result.push_back(static_cast<char>(0x80|((c>>6)&63))); result.push_back(static_cast<char>(0x80|(c&63))); }
        else { result.push_back(static_cast<char>(0xf0|(c>>18))); result.push_back(static_cast<char>(0x80|((c>>12)&63))); result.push_back(static_cast<char>(0x80|((c>>6)&63))); result.push_back(static_cast<char>(0x80|(c&63))); }
    }
    return result;
#endif
}
std::string classId(const ClassInfo& info) {
    auto id=info.ID().toString();
    std::transform(id.begin(),id.end(),id.begin(),[](unsigned char c){return static_cast<char>(std::toupper(c));});
    return id;
}
bool hasCategory(const ClassInfo& info, const char* wanted) {
    const auto& categories=info.subCategories();
    return std::find(categories.begin(), categories.end(), wanted) != categories.end();
}
std::string unsupported(const ClassInfo& info, bool offline = false) {
    if (info.category() != kVstAudioEffectClass) return "";
    if (!hasCategory(info,"Fx")) return "Not an Fx insert";
    if (hasCategory(info,"Instrument")) return "Instruments are not supported";
    if (hasCategory(info,"OnlyARA")) return "ARA-only plug-ins are not supported";
    if (offline && (hasCategory(info,"NoOfflineProcess") || hasCategory(info,"OnlyRT"))) return "Plug-in does not support offline processing";
    if (!offline && hasCategory(info,"OnlyOfflineProcess")) return "Plug-in only supports offline processing";
    return {};
}
Module::Ptr openModule(const std::string& path) {
    // Several inserts can share a module. Each still creates its own component.
    static std::map<std::string,std::weak_ptr<Module>> modules;
    static std::mutex mutex;
    std::lock_guard<std::mutex> guard(mutex);
    for (auto entry=modules.begin();entry!=modules.end();) {
        if (entry->second.expired()) entry=modules.erase(entry);
        else ++entry;
    }
    if (const auto entry=modules.find(path);entry!=modules.end())
        if (auto existing=entry->second.lock()) return existing;
    std::string error;
    auto module = Module::create(path,error);
    if (!module) throw std::runtime_error(error.empty()?"Could not load VST3 module":error);
    module->getFactory().setHostContext(host());
    modules[path]=module;
    return module;
}
class Instance;
class Handler final : public U::Implements<U::Directly<IComponentHandler, IComponentHandler2>> {
    Instance* instance_;
    DWORD owner_ = GetCurrentThreadId();
    bool onOwner() const { return GetCurrentThreadId() == owner_ && instance_; }
public:
    explicit Handler(Instance& instance) : instance_(&instance) {}
    void disconnect() { instance_ = nullptr; }
    tresult PLUGIN_API beginEdit(ParamID id) override;
    tresult PLUGIN_API performEdit(ParamID id, ParamValue value) override;
    tresult PLUGIN_API endEdit(ParamID id) override;
    tresult PLUGIN_API restartComponent(int32 flags) override;
    tresult PLUGIN_API setDirty(TBool) override { return kNotImplemented; }
    tresult PLUGIN_API requestOpenEditor(FIDString) override { return kNotImplemented; }
    tresult PLUGIN_API startGroupEdit() override;
    tresult PLUGIN_API finishGroupEdit() override;
};
class Instance final : public dsp_detail::Processor {
    using Clock = std::chrono::steady_clock;
    Module::Ptr module_;
    std::unique_ptr<PlugProvider> provider_;
    IPtr<IComponent> component_;
    IPtr<IEditController> controller_;
    IPtr<IAudioProcessor> processor_;
    IPtr<Handler> handler_;
    ParameterChanges changes_;
    std::vector<ParameterInfo> parameters_;
    std::vector<double> requested_,applied_;
    std::map<ParamID, std::size_t> parameterIndices_;
    std::vector<std::string> parameterKeys_;
    std::vector<std::uint64_t> localEditSeq_;
    std::set<ParamID> openGestures_;
    std::map<std::string, double> editorEdits_;
    EditorCommit editorCommit_;
    std::unique_ptr<EditorWindow> editor_;
    Clock::time_point lastEditorEdit_{};
    unsigned editGroups_=0;
    bool editorParamsPending_=false, readControllerParams_=false;
    std::vector<AudioBusBuffers> inputBuses_,outputBuses_;
    std::vector<std::vector<Sample32*>> inputChannels_,outputChannels_;
    std::vector<float> outLeft_,outRight_;
    ProcessData data_;
    ProcessContext context_{};
    int inputMain_=-1,outputMain_=-1,maxBlock_;
    int latency_=0;
    std::int64_t tail_=0;
    bool active_=false,processing_=false,pending_=false;
    double rate_,bpm_=120,barBeats_=4;
    std::int64_t position_=0;
    std::string name_;

    void prepareBuses(BusDirection direction, std::vector<AudioBusBuffers>& buses,
                      std::vector<std::vector<Sample32*>>& channels, int main) {
        for (int i=0; i<static_cast<int>(buses.size()); ++i) {
            BusInfo info{};
            if (component_->getBusInfo(kAudio,direction,i,info)!=kResultOk || info.channelCount<0 || info.channelCount>256)
                throw std::runtime_error("Invalid VST3 bus information");
            channels[i].assign(static_cast<size_t>(info.channelCount),nullptr);
            buses[i].numChannels=i==main?info.channelCount:0;
            buses[i].channelBuffers32=i==main?channels[i].data():nullptr;
            if (component_->activateBus(kAudio,direction,i,i==main)!=kResultOk && i==main)
                throw std::runtime_error("Could not activate main audio bus");
        }
    }
    void startProcessing() {
        const auto status=processor_->setProcessing(true);
        // The SDK's base AudioEffect returns kNotImplemented for this notification.
        if(status!=kResultOk&&status!=kNotImplemented)throw std::runtime_error("VST3 could not start processing: "+name_);
        processing_=true;
    }
    void queueParameterChanges() {
        changes_.clearQueue();pending_=false;
        for(size_t i=0;i<parameters_.size();++i){
            const auto& parameter=parameters_[i];
            const auto value=requested_[i];
            if(!std::isfinite(value))continue;
            if(controller_&&controller_->getParamNormalized(parameter.id)!=value)controller_->setParamNormalized(parameter.id,value);
            if(value==applied_[i])continue;
            int32 index=0;
            auto* queue=changes_.addParameterData(parameter.id,index);
            if(!queue||queue->addPoint(0,value,index)!=kResultOk)throw std::runtime_error("VST3 could not queue a parameter: "+name_);
            pending_=true;
        }
    }
public:
    Instance(Module::Ptr module, const ClassInfo& info, double rate, int maxBlock, bool offline)
      : module_(std::move(module)), maxBlock_(maxBlock), rate_(rate), name_(info.name()) {
        if (!std::isfinite(rate) || rate<=0 || maxBlock<=0 || maxBlock>1048576) throw std::runtime_error("Invalid VST3 processing setup");
        const auto reason=unsupported(info,offline); if(!reason.empty()) throw std::runtime_error(reason);
        provider_=std::make_unique<PlugProvider>(module_->getFactory(),info,true);
        if (!provider_->initialize()) throw std::runtime_error("Could not initialize VST3 component");
        component_=provider_->getComponentPtr(); controller_=provider_->getControllerPtr();
        IAudioProcessor* rawProcessor=nullptr;
        if (!component_ || component_->queryInterface(IAudioProcessor::iid,reinterpret_cast<void**>(&rawProcessor))!=kResultOk || !rawProcessor)
            throw std::runtime_error("VST3 component has no audio processor");
        processor_=owned(rawProcessor);
        if (controller_) {
            handler_=owned(new Handler(*this)); controller_->setComponentHandler(handler_);
            MemoryStream state;
            if(component_->getState(&state)==kResultOk && state.seek(0,IBStream::kIBSeekSet,nullptr)==kResultOk) controller_->setComponentState(&state);
            const auto count=controller_->getParameterCount();
            if(count<0 || count>65536) throw std::runtime_error("Invalid VST3 parameter count");
            parameters_.reserve(count);
            for(int32 i=0;i<count;++i){ ParameterInfo p{}; if(controller_->getParameterInfo(i,p)==kResultOk) parameters_.push_back(p); }
            changes_.setMaxParameters(static_cast<int32>(parameters_.size()));
            requested_.assign(parameters_.size(),std::numeric_limits<double>::quiet_NaN());
            applied_=requested_;
            localEditSeq_.assign(parameters_.size(),0);
            parameterKeys_.reserve(parameters_.size());
            for(std::size_t i=0;i<parameters_.size();++i){
                parameterIndices_.emplace(parameters_[i].id,i);
                parameterKeys_.push_back(std::to_string(parameters_[i].id));
            }
        }
        if(processor_->canProcessSampleSize(kSample32)!=kResultTrue) throw std::runtime_error("VST3 plug-in does not support Float32");
        const int ni=component_->getBusCount(kAudio,kInput), no=component_->getBusCount(kAudio,kOutput);
        if(ni<=0||no<=0||ni>64||no>64) throw std::runtime_error("VST3 plug-in needs an audio input and output");
        std::vector<SpeakerArrangement> ins(ni),outs(no);
        auto getArrangements=[&](BusDirection dir,std::vector<SpeakerArrangement>& a,int& main) {
            for(int i=0;i<static_cast<int>(a.size());++i){
                BusInfo info{}; if(component_->getBusInfo(kAudio,dir,i,info)!=kResultOk) throw std::runtime_error("Could not inspect VST3 bus");
                if(info.busType==kMain && main<0) main=i;
                if(processor_->getBusArrangement(dir,i,a[i])!=kResultOk) throw std::runtime_error("Could not inspect VST3 speaker arrangement");
            }
            if(main<0) throw std::runtime_error("VST3 has no main audio bus");
            a[main]=SpeakerArr::kStereo;
        };
        getArrangements(kInput,ins,inputMain_); getArrangements(kOutput,outs,outputMain_);
        processor_->setBusArrangements(ins.data(),ni,outs.data(),no);
        SpeakerArrangement in{},out{};
        if(processor_->getBusArrangement(kInput,inputMain_,in)!=kResultOk || processor_->getBusArrangement(kOutput,outputMain_,out)!=kResultOk || in!=SpeakerArr::kStereo || out!=SpeakerArr::kStereo)
            throw std::runtime_error("Stereo main input and output are required");
        for(auto dir:{kInput,kOutput}) for(int i=0;i<component_->getBusCount(kEvent,dir);++i) component_->activateBus(kEvent,dir,i,false);
        inputBuses_.resize(ni); outputBuses_.resize(no); inputChannels_.resize(ni); outputChannels_.resize(no);
        prepareBuses(kInput,inputBuses_,inputChannels_,inputMain_); prepareBuses(kOutput,outputBuses_,outputChannels_,outputMain_);
        if(inputBuses_[inputMain_].numChannels!=2 || outputBuses_[outputMain_].numChannels!=2) throw std::runtime_error("Invalid stereo main bus");
        ProcessSetup setup{offline?kOffline:kRealtime,kSample32,maxBlock,rate};
        if(processor_->setupProcessing(setup)!=kResultOk) throw std::runtime_error("VST3 setupProcessing failed");
        outLeft_.resize(maxBlock); outRight_.resize(maxBlock);
        data_.processMode=setup.processMode; data_.symbolicSampleSize=kSample32;
        data_.numInputs=ni; data_.numOutputs=no; data_.inputs=inputBuses_.data(); data_.outputs=outputBuses_.data(); data_.processContext=&context_;
        context_.sampleRate=rate;
        if(component_->setActive(true)!=kResultOk) throw std::runtime_error("VST3 activation failed");
        active_=true;
        try {
            const auto latency=processor_->getLatencySamples();
            if(latency>rate*30)throw std::runtime_error("VST3 reports more than 30 seconds of processing latency");
            latency_=static_cast<int>(latency);
            tail_=processor_->getTailSamples();
            startProcessing();
        }catch(...){component_->setActive(false);active_=false;throw;}
    }
    ~Instance() override {
        try { closeNativeEditor(); } catch(...) {}
        if(handler_)handler_->disconnect();
        if(processing_) processor_->setProcessing(false);
        if(active_) component_->setActive(false);
        if(controller_) controller_->setComponentHandler(nullptr);
    }
    json metadata(const ClassInfo& info) const {
        json result={{"classId",classId(info)},{"name",info.name()},{"vendor",info.vendor().empty()?module_->getFactory().info().vendor():info.vendor()}, {"version",info.version()},{"category",info.subCategoriesString()},{"latencySamples",latency_},{"tailSamples",tail_}};
        result["parameters"]=json::array();
        for(const auto& p:parameters_) result["parameters"].push_back({{"id",p.id},{"name",utf8(p.title)},{"unit",utf8(p.units)},{"defaultValue",p.defaultNormalizedValue},{"stepCount",p.stepCount},{"readOnly",bool(p.flags & ParameterInfo::kIsReadOnly)}});
        return result;
    }
    std::string display(ParamID id, double value) const {
        String128 text{};
        return controller_ && controller_->getParamStringByValue(id,value,text)==kResultOk ? utf8(text) : std::string{};
    }
    json summary(std::size_t i, bool includeChoices) const {
        const auto& p=parameters_[i];
        const auto value=controller_->getParamNormalized(p.id);
        if(!std::isfinite(value)||value<0||value>1)throw std::runtime_error("VST3 returned an invalid parameter value: "+std::to_string(p.id));
        json result={{"id",p.id},{"name",utf8(p.title)},{"shortName",utf8(p.shortTitle)},
            {"unit",utf8(p.units)},{"unitId",p.unitId},{"stepCount",p.stepCount},
            {"defaultValue",p.defaultNormalizedValue},{"readOnly",bool(p.flags&ParameterInfo::kIsReadOnly)},
            {"hidden",bool(p.flags&ParameterInfo::kIsHidden)},{"automatable",bool(p.flags&ParameterInfo::kCanAutomate)},
            {"programChange",bool(p.flags&ParameterInfo::kIsProgramChange)},{"bypass",bool(p.flags&ParameterInfo::kIsBypass)},
            {"normalizedValue",value}};
        const auto shown=display(p.id,value); if(!shown.empty()) result["displayValue"]=shown;
        const auto plain=controller_->normalizedParamToPlain(p.id,value); if(std::isfinite(plain))result["plainValue"]=plain;
        FUnknownPtr<IUnitInfo> units(controller_);
        if(units) {
            const auto count=units->getUnitCount();
            if(count>=0&&count<=65536)for(int32 j=0;j<count;++j){UnitInfo unit{};if(units->getUnitInfo(j,unit)==kResultOk&&unit.id==p.unitId){const auto group=utf8(unit.name);if(!group.empty())result["group"]=group;break;}}
        }
        if(includeChoices&&p.stepCount>0&&p.stepCount<=255){
            result["choices"]=json::array();
            for(int32 j=0;j<=p.stepCount;++j){const double n=double(j)/p.stepCount;result["choices"].push_back({{"index",j},{"label",display(p.id,n)},{"normalizedValue",n}});}
        }
        return result;
    }
    json inspect(const json& job) {
        if(!controller_)throw std::runtime_error("VST3 has no edit controller");
        json resolved=json::object(); std::vector<std::size_t> updated;
        if(job.contains("updates")){
            if(!job["updates"].is_array())throw std::runtime_error("updates must be an array");
            if(job["updates"].size()>1000)throw std::runtime_error("Too many VST3 parameter updates");
            std::set<ParamID> seen;
            for(const auto& update:job["updates"]){
                const auto raw=update.at("paramId").get<std::uint64_t>();
                if(raw>std::numeric_limits<ParamID>::max())throw std::runtime_error("Invalid VST3 parameter ID");
                const auto id=static_cast<ParamID>(raw);const auto found=parameterIndices_.find(id);
                if(found==parameterIndices_.end())throw std::runtime_error("Unknown VST3 parameter: "+std::to_string(id));
                if(!seen.insert(id).second)throw std::runtime_error("Duplicate VST3 parameter: "+std::to_string(id));
                const auto i=found->second;const auto& p=parameters_[i];
                if(p.flags&(ParameterInfo::kIsReadOnly|ParameterInfo::kIsHidden|ParameterInfo::kIsProgramChange))throw std::runtime_error("VST3 parameter is not externally writable: "+std::to_string(id));
                const auto format=update.at("format").get<std::string>();const auto& v=update.at("value");double n=0;
                if(update.contains("unit")&&update.at("unit").get<std::string>()!=utf8(p.units))throw std::runtime_error("Unit does not match VST3 parameter: "+std::to_string(id));
                if(format=="normalized"){
                    if(!v.is_number())throw std::runtime_error("Normalized value must be numeric");n=v.get<double>();
                } else if(format=="plain"){
                    if(!v.is_number())throw std::runtime_error("Plain value must be numeric");
                    const double plain=v.get<double>();if(!std::isfinite(plain))throw std::runtime_error("Plain value must be finite");
                    n=controller_->plainParamToNormalized(id,plain);
                    const auto roundTrip=controller_->normalizedParamToPlain(id,n);
                    if(!std::isfinite(roundTrip)||std::abs(roundTrip-plain)>1e-6*std::max(1.,std::abs(plain)))throw std::runtime_error("Plain value is outside the supported range or cannot be converted: "+std::to_string(id));
                } else if(format=="text"){
                    if(!v.is_string())throw std::runtime_error("Text value must be a string");
                    const auto text=v.get<std::string>();String128 wide{};
                    const int len=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.c_str(),-1,reinterpret_cast<wchar_t*>(wide),128);
                    if(!len||controller_->getParamValueByString(id,wide,n)!=kResultOk)throw std::runtime_error("VST3 cannot parse parameter text: "+std::to_string(id));
                } else if(format=="choice"){
                    if(p.stepCount<=0)throw std::runtime_error("VST3 parameter has no discrete choices: "+std::to_string(id));
                    int index=-1;
                    if(v.is_number_integer()){const auto k=v.get<std::int64_t>();if(k>=0&&k<=p.stepCount)index=static_cast<int>(k);}
                    else if(v.is_string()){
                        if(p.stepCount>255)throw std::runtime_error("Use a numeric index or VST3 text conversion for a large choice list");
                        for(int j=0;j<=p.stepCount;++j)if(display(id,double(j)/p.stepCount)==v.get<std::string>()){if(index>=0)throw std::runtime_error("Ambiguous VST3 choice label");index=j;}
                    }
                    if(index<0)throw std::runtime_error("Unknown VST3 choice: "+std::to_string(id));n=double(index)/p.stepCount;
                } else throw std::runtime_error("Unsupported VST3 value format: "+format);
                if(!std::isfinite(n)||n<0||n>1)throw std::runtime_error("VST3 normalized value must be between 0 and 1: "+std::to_string(id));
                if(p.stepCount>0)n=std::min(double(p.stepCount),std::floor(n*(double(p.stepCount)+1.)))/p.stepCount;
                if(controller_->setParamNormalized(id,n)!=kResultOk)throw std::runtime_error("VST3 rejected parameter: "+std::to_string(id));
                const auto actual=controller_->getParamNormalized(id);
                if(!std::isfinite(actual)||actual<0||actual>1||std::abs(actual-n)>1e-6)throw std::runtime_error("VST3 did not confirm parameter: "+std::to_string(id));
                resolved[std::to_string(id)]=actual;updated.push_back(i);
            }
        }
        std::set<ParamID> ids;
        if(job.contains("paramIds"))for(const auto& item:job.at("paramIds")){const auto id=item.get<std::uint64_t>();if(id>std::numeric_limits<ParamID>::max())throw std::runtime_error("Invalid VST3 parameter ID");ids.insert(static_cast<ParamID>(id));}
        auto query=job.value("query",std::string{});std::transform(query.begin(),query.end(),query.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});
        std::vector<std::size_t> selected;
        if(job.contains("updates"))selected=updated;
        else for(std::size_t i=0;i<parameters_.size();++i){
            const auto& p=parameters_[i];if(job.contains("paramIds")&&!ids.count(p.id))continue;
            auto name=utf8(p.title)+" "+utf8(p.shortTitle)+" "+std::to_string(p.id);std::transform(name.begin(),name.end(),name.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});
            if(query.empty()||name.find(query)!=std::string::npos)selected.push_back(i);
        }
        const auto offset=job.value("offset",std::int64_t{0});
        const auto limit=job.value("limit",100);
        if(offset<0||limit<1||limit>128)throw std::runtime_error("Invalid parameter pagination");
        const auto begin=job.contains("updates")?std::size_t{0}:std::min<std::size_t>(offset,selected.size());
        const auto end=job.contains("updates")?selected.size():std::min(selected.size(),begin+static_cast<std::size_t>(limit));
        json result={{"complete",true},{"parameters",json::array()},{"total",selected.size()},{"nextOffset",nullptr}};
        for(auto i=begin;i<end;++i)result["parameters"].push_back(summary(selected[i],job.value("includeChoices",false)));
        if(end<selected.size())result["nextOffset"]=end;
        if(job.contains("updates"))result["resolved"]=resolved;
        return result;
    }
    json values(const json& ids) const {
        if(!ids.is_array())throw std::runtime_error("paramIds must be an array");
        json result=json::array();
        for(const auto& item:ids){
            const auto raw=item.get<std::uint64_t>();if(raw>std::numeric_limits<ParamID>::max())continue;
            const auto found=parameterIndices_.find(static_cast<ParamID>(raw));if(found==parameterIndices_.end()||!controller_)continue;
            const auto i=found->second;const auto id=parameters_[i].id;const auto value=controller_->getParamNormalized(id);
            if(!std::isfinite(value)||value<0||value>1)continue;
            json entry={{"id",id},{"normalizedValue",value},{"processed",std::isfinite(applied_[i])&&applied_[i]==value}};
            const auto shown=display(id,value);if(!shown.empty())entry["displayValue"]=shown;result.push_back(std::move(entry));
        }
        return result;
    }
    void configure(const std::map<std::string,double>& params,double bpm,double barBeats,std::uint64_t editsSeen=0) {
        bpm_=std::isfinite(bpm)&&bpm>0?bpm:120; barBeats_=std::isfinite(barBeats)&&barBeats>0?barBeats:4;
        for(size_t i=0;i<parameters_.size();++i) {
            const auto& p=parameters_[i];
            if(p.flags&ParameterInfo::kIsReadOnly) continue;
            const auto& key=parameterKeys_[i];
            // Project updates queued before the renderer received a native edit
            // must not overwrite a more recent knob movement.
            if(localEditSeq_[i]>editsSeen||editorEdits_.count(key)) continue;
            const auto it=params.find(key);
            if(it!=params.end()&&std::isfinite(it->second))requested_[i]=std::clamp(it->second,0.,1.);
            else if(std::isfinite(requested_[i]))requested_[i]=p.defaultNormalizedValue;
        }
        queueParameterChanges();
    }
    bool openNativeEditor(EditorCommit commit) {
        if(editor_&&editor_->isOpen()){editor_->show();return true;}
        if(editor_)closeNativeEditor();
        if(!controller_)return false;
        auto view=owned(controller_->createView(ViewType::kEditor));
        if(!view||view->isPlatformTypeSupported(kPlatformTypeHWND)!=kResultOk)return false;
        editorCommit_=std::move(commit);
        try { editor_=std::make_unique<EditorWindow>(view,name_+" — Visiki"); editor_->show(); }
        catch(...) { closeNativeEditor(); throw; }
        return editor_->isOpen();
    }
    bool serviceNativeEditor(bool flush) {
        const bool open=editor_&&editor_->isOpen();
        if(!open){closeNativeEditor();return false;}
        readEditorParameters();
        if(editorParamsPending_){editorParamsPending_=false;queueParameterChanges();}
        if(flush||(openGestures_.empty()&&!editGroups_&&Clock::now()-lastEditorEdit_>=std::chrono::milliseconds(120)))
            commitEditorParameters();
        return true;
    }
    void closeNativeEditor() {
        editor_.reset();
        if(!editorCommit_)return;
        readEditorParameters();
        if(editorParamsPending_){editorParamsPending_=false;queueParameterChanges();}
        commitEditorParameters();
        openGestures_.clear();
        editGroups_=0;
        editorCommit_={};
    }
    bool beginEditorGesture(ParamID id) {
        if(!editorCommit_||!parameterIndices_.count(id))return false;
        if(openGestures_.empty()&&!editGroups_)commitEditorParameters();
        openGestures_.insert(id);
        return true;
    }
    bool setEditorParameter(ParamID id,ParamValue value) {
        if(!editorCommit_||!std::isfinite(value)||value<0.||value>1.)return false;
        const auto found=parameterIndices_.find(id);
        if(found==parameterIndices_.end())return false;
        const auto i=found->second;
        if(parameters_[i].flags&ParameterInfo::kIsReadOnly)return false;
        if(requested_[i]==value)return true;
        requested_[i]=value;
        editorEdits_[parameterKeys_[i]]=value;
        editorParamsPending_=true;
        lastEditorEdit_=Clock::now();
        return true;
    }
    bool endEditorGesture(ParamID id) {
        if(!editorCommit_)return false;
        openGestures_.erase(id);
        if(openGestures_.empty()&&!editGroups_)commitEditorParameters();
        return true;
    }
    bool setEditorGroup(bool begins) {
        if(!editorCommit_)return false;
        if(begins)++editGroups_;
        else if(editGroups_&&!--editGroups_&&openGestures_.empty())commitEditorParameters();
        return true;
    }
    bool controllerParamsChanged(int32 flags) {
        if(!editorCommit_||!(flags&kParamValuesChanged))return false;
        // Query the controller after its callback has returned.
        readControllerParams_=true;
        return !(flags&~kParamValuesChanged);
    }
private:
    void readEditorParameters() {
        if(!readControllerParams_)return;
        readControllerParams_=false;
        for(std::size_t i=0;i<parameters_.size();++i){
            const auto& parameter=parameters_[i];
            if(parameter.flags&ParameterInfo::kIsReadOnly)continue;
            const auto actual=controller_->getParamNormalized(parameter.id);
            const auto previous=std::isfinite(requested_[i])?requested_[i]:parameter.defaultNormalizedValue;
            if(actual!=previous)setEditorParameter(parameter.id,actual);
        }
    }
    void commitEditorParameters() {
        if(editorEdits_.empty()||!editorCommit_||readControllerParams_)return;
        const auto sequence=editorCommit_(editorEdits_);
        for(std::size_t i=0;i<parameterKeys_.size();++i)
            if(editorEdits_.count(parameterKeys_[i]))localEditSeq_[i]=sequence;
        editorEdits_.clear();
    }
public:
    void process(float* left,float* right,int frames) override {
        for(int offset=0;offset<frames;) {
            int n=std::min(maxBlock_,frames-offset);
            if(!processing_)throw std::runtime_error("VST3 processor is inactive: "+name_);
            inputChannels_[inputMain_][0]=left+offset; inputChannels_[inputMain_][1]=right+offset;
            outputChannels_[outputMain_][0]=outLeft_.data(); outputChannels_[outputMain_][1]=outRight_.data();
            std::fill_n(outLeft_.data(),n,0.f);std::fill_n(outRight_.data(),n,0.f);
            inputBuses_[inputMain_].silenceFlags=0; outputBuses_[outputMain_].silenceFlags=0;
            context_.state=ProcessContext::kPlaying|ProcessContext::kTempoValid|ProcessContext::kProjectTimeMusicValid|ProcessContext::kBarPositionValid;
            context_.projectTimeSamples=position_; context_.tempo=bpm_;
            context_.projectTimeMusic=static_cast<double>(position_)*bpm_/(rate_*60.);
            context_.barPositionMusic=std::floor(context_.projectTimeMusic/barBeats_)*barBeats_;
            data_.numSamples=n; data_.inputParameterChanges=pending_?&changes_:nullptr;
            if(processor_->process(data_)!=kResultOk)throw std::runtime_error("VST3 audio processing failed: "+name_);
            for(int i=0;i<n;++i){left[offset+i]=(outputBuses_[outputMain_].silenceFlags & 1)?0.f:dsp_detail::clean(outLeft_[i]);right[offset+i]=(outputBuses_[outputMain_].silenceFlags & 2)?0.f:dsp_detail::clean(outRight_[i]);}
            if(pending_){std::copy(requested_.begin(),requested_.end(),applied_.begin());changes_.clearQueue();pending_=false;}
            position_+=n; offset+=n;
        }
    }
    void reset() override {
        // Host calls this on the graph's owner thread, never on the device callback.
        if(processing_){processor_->setProcessing(false);processing_=false;}
        if(active_){component_->setActive(false);active_=false;}
        if(component_->setActive(true)!=kResultOk)throw std::runtime_error("VST3 could not reset: "+name_);
        active_=true;
        startProcessing();
        std::fill(applied_.begin(),applied_.end(),std::numeric_limits<double>::quiet_NaN());
        queueParameterChanges();
    }
    int latency() const override { return latency_; }
    std::int64_t tail() const override { return tail_; }
    void setTimelineSample(std::int64_t value) override { position_=value; }
    void inheritState(const dsp_detail::Processor&) override {}
};
tresult PLUGIN_API Handler::beginEdit(ParamID id) {
    try { return onOwner()&&instance_->beginEditorGesture(id)?kResultOk:kNotImplemented; }
    catch (...) { return kInternalError; }
}
tresult PLUGIN_API Handler::performEdit(ParamID id,ParamValue value) {
    try { return onOwner()&&instance_->setEditorParameter(id,value)?kResultOk:kNotImplemented; }
    catch (...) { return kInternalError; }
}
tresult PLUGIN_API Handler::endEdit(ParamID id) {
    try { return onOwner()&&instance_->endEditorGesture(id)?kResultOk:kNotImplemented; }
    catch (...) { return kInternalError; }
}
tresult PLUGIN_API Handler::restartComponent(int32 flags) {
    return onOwner()&&instance_->controllerParamsChanged(flags)?kResultOk:kNotImplemented;
}
tresult PLUGIN_API Handler::startGroupEdit() {
    try { return onOwner()&&instance_->setEditorGroup(true)?kResultOk:kNotImplemented; }
    catch (...) { return kInternalError; }
}
tresult PLUGIN_API Handler::finishGroupEdit() {
    try { return onOwner()&&instance_->setEditorGroup(false)?kResultOk:kNotImplemented; }
    catch (...) { return kInternalError; }
}
}
json scanModule(const std::string& path) {
    json result={{"complete",true},{"plugins",json::array()},{"issues",json::array()}};
    try {
        auto module=openModule(path);
        for(const auto& info:module->getFactory().classInfos()) {
            if(info.category()!=kVstAudioEffectClass) continue;
            try {
                auto reason=unsupported(info); if(!reason.empty()) throw std::runtime_error(reason);
                Instance instance(module,info,44100,512,false);
                result["plugins"].push_back(instance.metadata(info));
            } catch(const std::exception& e) { result["issues"].push_back({{"classId",classId(info)},{"name",info.name()},{"message",e.what()}}); }
        }
    } catch(const std::exception& e) { result["issues"].push_back({{"message",e.what()}}); }
    if(result["issues"].empty()) result.erase("issues");
    return result;
}
json inspectParameters(const json& job) {
    const auto path=job.at("modulePath").get<std::string>();
    auto id=job.at("classId").get<std::string>();
    std::transform(id.begin(),id.end(),id.begin(),[](unsigned char c){return static_cast<char>(std::toupper(c));});
    auto module=openModule(path);
    for(const auto& info:module->getFactory().classInfos())if(classId(info)==id&&info.category()==kVstAudioEffectClass){
        Instance instance(module,info,job.value("sampleRate",44100.),512,false);
        instance.configure(job.value("params",std::map<std::string,double>{}),120,4);
        return instance.inspect(job);
    }
    throw std::runtime_error("VST3 class ID not found in module");
}
json parameterValues(dsp_detail::Processor& processor,const json& ids) {
    auto* instance=dynamic_cast<Instance*>(&processor);if(!instance)throw std::invalid_argument("Not a VST3 processor");
    return instance->values(ids);
}
std::unique_ptr<dsp_detail::Processor> createProcessor(const std::string& path,const std::string& id,const std::map<std::string,double>& params,double sampleRate,int maxBlock,bool offline,double bpm,double barBeats) {
    auto module=openModule(path);
    for(const auto& info:module->getFactory().classInfos()) if(classId(info)==id && info.category()==kVstAudioEffectClass) {
        auto instance=std::make_unique<Instance>(module,info,sampleRate,maxBlock,offline);
        instance->configure(params,bpm,barBeats); return instance;
    }
    throw std::runtime_error("VST3 class ID not found in module");
}
void configureProcessor(dsp_detail::Processor& processor,const std::map<std::string,double>& params,double bpm,double barBeats,std::uint64_t editsSeen) {
    auto* instance=dynamic_cast<Instance*>(&processor); if(!instance) throw std::invalid_argument("Not a VST3 processor");
    instance->configure(params,bpm,barBeats,editsSeen);
}
bool openEditor(dsp_detail::Processor& processor,EditorCommit commit) {
    return static_cast<Instance&>(processor).openNativeEditor(std::move(commit));
}
bool serviceEditor(dsp_detail::Processor& processor,bool flush) {
    return static_cast<Instance&>(processor).serviceNativeEditor(flush);
}
void closeEditor(dsp_detail::Processor& processor) {
    static_cast<Instance&>(processor).closeNativeEditor();
}
}
