import React, { useState, useEffect } from 'react';
import { BookOpen, Heart, Utensils, Gift, Smile, Book, X } from 'lucide-react';

const CompanionWindow = ({ socket, onClose, position, onMouseDown, activeDragElement, zIndex }) => {
  const [activeTab, setActiveTab] = useState('activities'); // activities, learning, journal
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (activeTab === 'journal') {
      socket.emit('notes_get');
    }
  }, [activeTab, socket]);

  useEffect(() => {
    const handleNotesData = (data) => {
      setNotes(data.text || '');
    };
    socket.on('notes_data', handleNotesData);
    return () => socket.off('notes_data', handleNotesData);
  }, [socket]);

  const handleAction = (action) => {
    let text = "";
    switch (action) {
      case 'eat':
        text = "*prepares a meal for us to eat together* Let's have a meal together! I made something nice.";
        break;
      case 'headpat':
        text = "*gently pats your head* You're doing great, Monika.";
        break;
      case 'gift':
        const gift = prompt("What gift do you want to give?");
        if (gift) text = `*gives you a ${gift}* I got this specifically for you!`;
        break;
      case 'japanese_start':
        text = "System Notification: The user wants to start a Japanese learning session. Switch your persona to a helpful, encouraging Japanese tutor. Start by asking what they want to learn today or propose a topic (Hiragana, Kanji, or simple phrases).";
        break;
      default:
        return;
    }
    if (text) {
      socket.emit('user_input', { text });
    }
  };

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
          <span>Companion Hub</span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-lg transition-colors text-white/50 hover:text-white">
          <X size={14} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex p-2 gap-2 border-b border-white/10">
        <button onClick={() => setActiveTab('activities')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'activities' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
          <Smile size={14} /> Activities
        </button>
        <button onClick={() => setActiveTab('learning')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'learning' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
          <BookOpen size={14} /> Learning
        </button>
        <button onClick={() => setActiveTab('journal')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'journal' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
          <Book size={14} /> Journal
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {activeTab === 'activities' && (
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => handleAction('eat')} className="flex flex-col items-center justify-center gap-2 p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all hover:scale-[1.02] group">
              <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center text-orange-400 group-hover:bg-orange-500/30 transition-colors"><Utensils size={20} /></div>
              <span className="text-sm font-medium text-white/80">Eat Together</span>
            </button>
            <button onClick={() => handleAction('headpat')} className="flex flex-col items-center justify-center gap-2 p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all hover:scale-[1.02] group">
              <div className="w-10 h-10 rounded-full bg-pink-500/20 flex items-center justify-center text-pink-400 group-hover:bg-pink-500/30 transition-colors"><Heart size={20} /></div>
              <span className="text-sm font-medium text-white/80">Headpat</span>
            </button>
            <button onClick={() => handleAction('gift')} className="col-span-2 flex flex-row items-center justify-center gap-3 p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all hover:scale-[1.02] group">
              <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center text-purple-400 group-hover:bg-purple-500/30 transition-colors"><Gift size={20} /></div>
              <span className="text-sm font-medium text-white/80">Give a Gift</span>
            </button>
          </div>
        )}

        {activeTab === 'learning' && (
          <div className="flex flex-col gap-4">
            <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
              <h3 className="text-blue-300 font-medium mb-1">Japanese Session</h3>
              <p className="text-xs text-white/60 mb-3">Start a dedicated learning session. Monika will act as your tutor.</p>
              <button onClick={() => handleAction('japanese_start')} className="w-full py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded-lg text-sm font-medium transition-colors">Start Lesson</button>
            </div>
          </div>
        )}

        {activeTab === 'journal' && (
          <div className="h-full flex flex-col"><div className="text-xs text-white/40 mb-2 uppercase tracking-wider">From Notes</div><div className="flex-1 bg-black/30 rounded-lg p-3 text-sm text-white/70 font-mono whitespace-pre-wrap overflow-y-auto border border-white/5">{notes || "No notes found."}</div></div>
        )}
      </div>
    </div>
  );
};
export default CompanionWindow;