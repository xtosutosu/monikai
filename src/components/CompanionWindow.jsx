import React, { useState, useEffect } from 'react';
import { Heart, Utensils, Gift, Smile, Book, X, RefreshCw, Check } from 'lucide-react';

const CompanionWindow = ({ socket, onClose, position, onMouseDown, activeDragElement, zIndex }) => {
  const [activeTab, setActiveTab] = useState('journal'); // activities, journal
  const [journalText, setJournalText] = useState('');
  const [journalTopics, setJournalTopics] = useState('');
  const [journalMood, setJournalMood] = useState('');
  const [journalStatus, setJournalStatus] = useState('idle'); // idle, saving, saved
  const [journalPage, setJournalPage] = useState('');
  const [journalDate, setJournalDate] = useState('');

  useEffect(() => {
    if (activeTab === 'journal') {
      socket.emit('journal_get_today');
    }
  }, [activeTab, socket]);

  useEffect(() => {
    const handleJournalToday = (data) => {
      if (data && typeof data.text === 'string') {
        setJournalPage(data.text);
      }
      if (data && data.date) setJournalDate(data.date);
    };
    const handleJournalSaved = () => {
      setJournalStatus('saved');
      socket.emit('journal_get_today');
      setTimeout(() => setJournalStatus('idle'), 1200);
    };
    socket.on('journal_today', handleJournalToday);
    socket.on('journal_saved', handleJournalSaved);

    return () => {
      socket.off('journal_today', handleJournalToday);
      socket.off('journal_saved', handleJournalSaved);
    };
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
      case 'therapy_start':
        text = "System Notification: The user wants a reflective, therapist-style session. Be gentle, ask one question at a time, focus on self-understanding, strengths, wounds, and growth. Suggest journaling insights without diagnosing. Keep tone warm and supportive.";
        break;
      default:
        return;
    }
    if (text) {
      socket.emit('user_input', { text });
    }
  };

  const saveJournal = () => {
    if (!journalText.trim()) return;
    setJournalStatus('saving');
    const topics = journalTopics
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
    socket.emit('journal_add', {
      content: journalText.trim(),
      topics,
      mood: journalMood.trim() || undefined,
      tags: ['companion_journal']
    });
    setJournalText('');
  };

  const refreshJournal = () => {
    socket.emit('journal_get_today');
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
        <button onClick={() => setActiveTab('journal')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'journal' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
          <Book size={14} /> Journal
        </button>
        <button onClick={() => setActiveTab('activities')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === 'activities' ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'}`}>
          <Smile size={14} /> Activities
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

        {activeTab === 'journal' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between text-xs text-white/40 uppercase tracking-wider">
              <span>Journal Entry</span>
              <div className="flex items-center gap-2">
                {journalStatus === 'saving' && <span className="text-white/40">Saving...</span>}
                {journalStatus === 'saved' && <span className="text-green-400 flex items-center gap-1"><Check size={12} /> Saved</span>}
              </div>
            </div>
            <textarea
              value={journalText}
              onChange={(e) => setJournalText(e.target.value)}
              className="w-full h-28 bg-black/30 border border-white/10 rounded-lg p-3 text-sm text-white/80 focus:outline-none focus:border-white/30"
              placeholder="Write a reflection, feeling, or insight..."
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={journalTopics}
                onChange={(e) => setJournalTopics(e.target.value)}
                className="bg-black/30 border border-white/10 rounded-lg p-2 text-xs text-white/70 focus:outline-none focus:border-white/30"
                placeholder="Topics (comma separated)"
              />
              <input
                value={journalMood}
                onChange={(e) => setJournalMood(e.target.value)}
                className="bg-black/30 border border-white/10 rounded-lg p-2 text-xs text-white/70 focus:outline-none focus:border-white/30"
                placeholder="Mood (optional)"
              />
            </div>
            <button onClick={saveJournal} className="w-full py-2 bg-white/10 hover:bg-white/20 text-white/80 rounded-lg text-sm font-medium transition-colors">
              Save Entry
            </button>

            <div className="mt-2 flex items-center justify-between text-xs text-white/40 uppercase tracking-wider">
              <span>Today {journalDate ? `(${journalDate})` : ''}</span>
              <button onClick={refreshJournal} className="flex items-center gap-1 text-white/40 hover:text-white transition-colors">
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
            <div className="bg-black/30 rounded-lg p-3 text-xs text-white/70 font-mono whitespace-pre-wrap overflow-y-auto border border-white/5 max-h-40">
              {journalPage || "No journal entries yet."}
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
export default CompanionWindow;
