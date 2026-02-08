import React from 'react';
import { X, Upload, Mic, Speaker, Video, Shield, Cpu, Globe, Lock } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

const CONFIGURABLE_TOOLS = [
  'cancel_reminder',
  'control_light',
  'clear_work_memory',
  'notes_set',
  'run_web_agent',
  'write_file'
];

const SettingsWindow = ({
  micDevices,
  speakerDevices,
  webcamDevices,
  selectedMicId,
  setSelectedMicId,
  selectedSpeakerId,
  setSelectedSpeakerId,
  selectedWebcamId,
  setSelectedWebcamId,
  isCameraFlipped,
  setIsCameraFlipped,
  toolPermissions = {},
  onTogglePermission,
  handleFileUpload,
  onClose
}) => {
  const { t, language, setLanguage } = useLanguage();

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-black/60 backdrop-blur-2xl border border-white/10 rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
        
        {/* Header - Fixed */}
        <div className="flex items-center justify-between p-6 border-b border-white/10 bg-white/5 shrink-0">
          <h2 className="text-xl font-light tracking-wider text-white flex items-center gap-3">
            <Cpu size={20} className="text-white" />
            {t('settings.title')}
          </h2>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-lg text-white/50 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content - Scrollable */}
        <div className="p-6 overflow-y-auto space-y-8 custom-scrollbar">
          
          {/* Language */}
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-white uppercase tracking-widest flex items-center gap-2">
              <Globe size={16} />
              {t('settings.language')}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setLanguage('en')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  language === 'en' 
                    ? 'bg-white/20 border-white/50 text-white' 
                    : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
                }`}
              >
                English
              </button>
              <button
                onClick={() => setLanguage('pl')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  language === 'pl' 
                    ? 'bg-white/20 border-white/50 text-white' 
                    : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
                }`}
              >
                Polski
              </button>
            </div>
          </section>

          {/* Devices */}
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-white uppercase tracking-widest flex items-center gap-2">
              <Mic size={16} />
              {t('settings.microphone')}
            </h3>
            <select
              value={selectedMicId}
              onChange={(e) => setSelectedMicId(e.target.value)}
              className="w-full bg-black border border-white/20 rounded-lg p-3 text-white focus:border-white focus:outline-none"
            >
              {micDevices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.slice(0, 5)}...`}
                </option>
              ))}
            </select>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-medium text-white uppercase tracking-widest flex items-center gap-2">
              <Speaker size={16} />
              {t('settings.speaker')}
            </h3>
            <select
              value={selectedSpeakerId}
              onChange={(e) => setSelectedSpeakerId(e.target.value)}
              className="w-full bg-black border border-white/20 rounded-lg p-3 text-white focus:border-white focus:outline-none"
            >
              {speakerDevices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Speaker ${device.deviceId.slice(0, 5)}...`}
                </option>
              ))}
            </select>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-medium text-white uppercase tracking-widest flex items-center gap-2">
              <Video size={16} />
              {t('settings.camera')}
            </h3>
            <select
              value={selectedWebcamId}
              onChange={(e) => setSelectedWebcamId(e.target.value)}
              className="w-full bg-black border border-white/20 rounded-lg p-3 text-white focus:border-white focus:outline-none"
            >
              {webcamDevices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${device.deviceId.slice(0, 5)}...`}
                </option>
              ))}
            </select>

            <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10">
              <span className="text-white/80">{t('settings.mirror_vision')}</span>
              <button
                onClick={() => setIsCameraFlipped(!isCameraFlipped)}
                className={`w-12 h-6 rounded-full transition-colors relative ${
                  isCameraFlipped ? 'bg-white' : 'bg-white/20'
                }`}
              >
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                  isCameraFlipped ? 'left-7' : 'left-1'
                }`} />
              </button>
            </div>
          </section>

          {/* Security / Permissions */}
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-white uppercase tracking-widest flex items-center gap-2">
              <Lock size={16} />
              {t('settings.security')}
            </h3>
            
            <div className="bg-white/5 p-4 rounded-lg border border-white/10 space-y-4">
              <p className="text-xs text-white/60">{t('settings.permissions')}</p>
              <div className="space-y-3">
                {Object.entries(toolPermissions)
                  .filter(([key]) => CONFIGURABLE_TOOLS.includes(key))
                  .map(([key, val]) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-sm text-white/80 capitalize font-mono">{key.replace(/_/g, ' ')}</span>
                    <button
                      onClick={() => onTogglePermission && onTogglePermission(key)}
                      className={`w-10 h-5 rounded-full transition-colors relative ${
                        val ? 'bg-white' : 'bg-white/10'
                      }`}
                    >
                      <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-transform ${
                        val ? 'left-6' : 'left-1'
                      }`} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Memory */}
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-white uppercase tracking-widest flex items-center gap-2">
              <Shield size={16} />
              {t('settings.memory')}
            </h3>
            
            <div className="bg-white/5 p-4 rounded-lg border border-white/10">
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-white/20 rounded-lg cursor-pointer hover:border-white/50 hover:bg-white/5 transition-all group">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <Upload className="w-8 h-8 mb-3 text-white/40 group-hover:text-white transition-colors" />
                  <p className="mb-2 text-sm text-white/60 group-hover:text-white/90">
                    <span className="font-semibold">{t('settings.import_memory')}</span>
                  </p>
                  <p className="text-xs text-white/40">TXT, MD, JSON</p>
                </div>
                <input type="file" className="hidden" onChange={handleFileUpload} accept=".txt,.md,.json" />
              </label>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
};

export default SettingsWindow;
