import React from 'react';
import { X, ClipboardList } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import NoteWorkspace from './NoteWorkspace';

const SessionNotesWindow = ({ socket, onClose, position, onMouseDown, activeDragElement, zIndex, width = 620, height = 640 }) => {
  const { t } = useLanguage();
  return (
    <div
      id="session_notes"
      className={`absolute flex flex-col transition-[box-shadow,border-color] duration-200
        backdrop-blur-2xl bg-black/55 border border-white/[0.14] shadow-2xl overflow-hidden rounded-xl
        ${activeDragElement === 'session_notes' ? 'ring-1 ring-white/50 border-white/30' : ''}
      `}
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -50%)',
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: 'auto',
        zIndex: zIndex,
      }}
      onMouseDown={onMouseDown}
    >
      <div
        className="flex items-center justify-between p-4 border-b border-white/10 bg-white/5 shrink-0 cursor-grab active:cursor-grabbing"
        data-drag-handle
      >
        <div className="flex items-center gap-3">
          <ClipboardList size={18} className="text-white" />
          <span className="text-sm font-medium tracking-wider text-white/90 uppercase">{t('session.notes_title')}</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-lg text-white/50 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <NoteWorkspace
          socket={socket}
          defaultPath="session/session-notes.md"
          filterPrefix="session"
          hideCategories={true}
        />
      </div>
    </div>
  );
};

export default SessionNotesWindow;
