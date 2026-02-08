import React, { useState, useEffect } from 'react';
import { Heart, Utensils, Gift, Smile, Book, X, ClipboardList } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

const CompanionWindow = ({
  socket,
  onClose,
  position,
  onMouseDown,
  activeDragElement,
  zIndex,
  studyCatalog,
  studySelection,
  onOpenStudy,
  onShowStudy,
  onHeadpat,
  sessionActive,
  onToggleSession,
}) => {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState('session'); // activities, session, study

  const handleAction = (action) => {
    let text = "";
    switch (action) {
      case 'eat':
        text = "*prepares a meal for us to eat together* Let's have a meal together! I made something nice.";
        break;
      case 'headpat':
        text = "*gently headpats Monika*";
        if (onHeadpat) onHeadpat();
        break;
      case 'gift':
        const gift = prompt(t('companion.activities.gift_prompt'));
        if (gift) text = `*gives you a ${gift}* I got this specifically for you!`;
        break;
      case 'therapy_start':
        text = "System Notification: Start Therapy/Shadow Session. Use the Session mode therapeutic protocol (Shadow Integration, grounded tone, concrete questions, no diagnosis).";
        break;
      default:
        return;
    }
    if (text) {
      socket.emit('user_input', { text });
    }
  };

  const folders = Array.isArray(studyCatalog?.folders) ? studyCatalog.folders : [];
  const [selectedFolder, setSelectedFolder] = useState(studySelection?.folder || '');
  const [selectedFile, setSelectedFile] = useState(studySelection?.file || '');

  useEffect(() => {
    if (studySelection?.folder) setSelectedFolder(studySelection.folder);
    if (studySelection?.file) setSelectedFile(studySelection.file);
  }, [studySelection?.folder, studySelection?.file]);

  const activeFolder = folders.find(f => f.name === selectedFolder) || folders[0];
  const visibleFiles = activeFolder ? (activeFolder.files || []).filter(f => !f.is_answer_key) : [];

  useEffect(() => {
    if (!selectedFolder && activeFolder) {
      setSelectedFolder(activeFolder.name);
    }
  }, [selectedFolder, activeFolder]);

  useEffect(() => {
    if (!selectedFile && visibleFiles.length > 0) {
      setSelectedFile(visibleFiles[0].name);
    }
  }, [selectedFile, visibleFiles]);

  const openSelectedStudy = () => {
    const folder = activeFolder;
    const fileName = selectedFile || (visibleFiles[0]?.name || "");
    if (!folder || !fileName) return;
    const fileEntry = (folder.files || []).find(f => f.name === fileName);
    if (fileEntry && onOpenStudy) {
      onOpenStudy({ folder: folder.name, file: fileEntry.name, path: fileEntry.path });
      if (onShowStudy) onShowStudy();
    }
  };
  const sessionIconClass = sessionActive
    ? "bg-amber-500/30 text-amber-300 group-hover:bg-amber-500/40"
    : "bg-amber-500/20 text-amber-300 group-hover:bg-amber-500/30";


  return (
    <div
      id="companion"
      className={`absolute flex flex-col bg-black/80 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden transition-shadow duration-300 ${
        activeDragElement === 'companion' ? 'shadow-[0_0_30px_rgba(255,255,255,0.15)] border-white/30' : ''
      }`}
      style={{
        width: 400,
        height: 500,
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -50%)',
        zIndex: zIndex
      }}
      onMouseDown={onMouseDown}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/5 handle cursor-grab active:cursor-grabbing" data-drag-handle>
        <div className="flex items-center gap-2 text-white/90 font-medium">
          <Heart size={16} className="text-pink-400" />
          <span>{t('companion.title')}</span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-lg transition-colors text-white/50 hover:text-white">
          <X size={14} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex p-2 gap-2 border-b border-white/10">
        <button onClick={() => setActiveTab('session')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'session' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
          <ClipboardList size={14} /> {t('companion.tabs.session')}
        </button>
        <button onClick={() => setActiveTab('activities')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'activities' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
          <Smile size={14} /> {t('companion.tabs.activities')}
        </button>
        <button onClick={() => setActiveTab('study')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'study' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
          <Book size={14} /> {t('companion.tabs.study')}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {activeTab === 'activities' && (
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => handleAction('eat')} className="flex flex-col items-center justify-center gap-2 p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all hover:scale-[1.02] group">
              <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center text-orange-400 group-hover:bg-orange-500/30 transition-colors"><Utensils size={20} /></div>
              <span className="text-sm font-medium text-white/80">{t('companion.activities.eat')}</span>
            </button>
            <button onClick={() => handleAction('headpat')} className="flex flex-col items-center justify-center gap-2 p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all hover:scale-[1.02] group">
              <div className="w-10 h-10 rounded-full bg-pink-500/20 flex items-center justify-center text-pink-400 group-hover:bg-pink-500/30 transition-colors"><Heart size={20} /></div>
              <span className="text-sm font-medium text-white/80">{t('companion.activities.headpat')}</span>
            </button>
            <button onClick={() => handleAction('gift')} className="col-span-2 flex flex-row items-center justify-center gap-3 p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all hover:scale-[1.02] group">
              <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center text-purple-400 group-hover:bg-purple-500/30 transition-colors"><Gift size={20} /></div>
              <span className="text-sm font-medium text-white/80">{t('companion.activities.gift')}</span>
            </button>
          </div>
        )}

        {activeTab === 'session' && (
          <div className="grid grid-cols-1 gap-3">
            <button
              onClick={() => { if (onToggleSession) onToggleSession(); }}
              className="flex flex-col items-center justify-center gap-2 p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all hover:scale-[1.02] group"
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${sessionIconClass}`}>
                <ClipboardList size={20} />
              </div>
              <span className="text-sm font-medium text-white/80">
                {sessionActive ? t('companion.session.end') : t('companion.session.start')}
              </span>
            </button>
          </div>
        )}

        {activeTab === 'study' && (
          <div className="grid grid-cols-1 gap-3">
            <button onClick={openSelectedStudy} className="flex flex-col items-center justify-center gap-2 p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all hover:scale-[1.02] group">
              <div className="w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center text-cyan-300 group-hover:bg-cyan-500/30 transition-colors">
                <Book size={20} />
              </div>
              <span className="text-sm font-medium text-white/80">{t('companion.study.japanese_together')}</span>
            </button>
          </div>
        )}

      </div>
    </div>
  );
};
export default CompanionWindow;
