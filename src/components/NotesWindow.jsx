import React, { useEffect, useRef, useState } from 'react';
import { X, FileText } from 'lucide-react';

const NotesWindow = ({
    socket,
    position,
    onClose,
    onMouseDown,
    zIndex = 40
}) => {
    const [notesText, setNotesText] = useState('');
    const [project, setProject] = useState('temp');
    const [status, setStatus] = useState('');
    const textareaRef = useRef(null);
    const timeoutRef = useRef(null);
    const saveTimeoutRef = useRef(null);
    const typingTimeoutRef = useRef(null);
    const isTypingRef = useRef(false);
    const notesTextRef = useRef('');

    const requestNotes = () => {
        if (!socket) return;
        socket.emit('notes_get');
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setStatus(''), 1200);
    };

    useEffect(() => {
        if (!socket) return;
        requestNotes();

        const onNotes = (data) => {
            if (data && typeof data.text === 'string') {
                if (!isTypingRef.current || data.text !== notesTextRef.current) {
                    setNotesText(data.text);
                }
            }
            if (data && data.project) setProject(data.project);
            setStatus('Zapisałam!');
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => setStatus(''), 1200);
        };

        socket.on('notes_data', onNotes);
        return () => {
            socket.off('notes_data', onNotes);
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [socket]);

    useEffect(() => {
        return () => {
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        };
    }, []);

    useEffect(() => {
        notesTextRef.current = notesText;
    }, [notesText]);

    const scheduleSave = (text) => {
        if (!socket) return;
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        setStatus('Zapisywanie…');
        saveTimeoutRef.current = setTimeout(() => {
            socket.emit('notes_set', { content: text || '' });
        }, 450);
    };

    const handleChange = (e) => {
        const val = e.target.value;
        setNotesText(val);
        isTypingRef.current = true;
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
            isTypingRef.current = false;
        }, 700);
        scheduleSave(val);
    };

    return (
        <div
            id="notes"
            onMouseDown={onMouseDown}
            className="absolute flex flex-col gap-3 p-4 rounded-xl backdrop-blur-md bg-gradient-to-br from-[#1b1a17]/95 via-[#1f1b16]/92 to-[#15110d]/92 border border-[#f5d27a]/20 shadow-[0_0_28px_rgba(0,0,0,0.55)] select-none"
            style={{
                left: position.x,
                top: position.y,
                width: '500px',
                minHeight: '550px',
                transform: 'translate(-50%, -50%)',
                zIndex
            }}
        >
            {/* Header */}
            <div data-drag-handle className="flex items-center justify-between pb-2 border-b border-white/10 cursor-grab active:cursor-grabbing">
                <div className="flex items-center gap-2">
                    <FileText size={16} className="text-[#f5d27a]/90" />
                    <h3 className="font-bold text-[#f5d27a] tracking-wider text-sm">
                        Notatnik
                    </h3>
                </div>
                <div className="flex items-center gap-1">
                    <span className="text-[10px] text-white/35 mr-2">{status}</span>
                    <button
                        onClick={onClose}
                        className="p-1 rounded hover:bg-white/10 transition-colors text-white/50 hover:text-white"
                        title="Zamknij"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>

            {/* Body */}
            <div className="flex flex-col gap-2">
                <textarea
                    ref={textareaRef}
                    value={notesText}
                    onChange={handleChange}
                    placeholder="Będę dla Ciebie tutaj notować ważne rzeczy~"
                    rows={25}
                    className="w-full resize-none rounded-lg bg-[#1a1712]/70 border border-[#f5d27a]/15 p-3 text-[13px] text-white/90 outline-none shadow-inner shadow-black/40"
                />
            </div>
        </div>
    );
};

export default NotesWindow;
