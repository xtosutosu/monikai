import React, { useEffect, useRef, useState } from 'react';
import { X, FileText, Loader2, Check, Eye, Edit2 } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

// Helper to parse inline markdown for the overlay
const parseLine = (text) => {
    // Split by bold (**...**) and italic (*...*) and code (`...`)
    // We keep the delimiters visible but styled
    const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
    
    return parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
            return <span key={i} className="font-bold text-white/90">{part}</span>;
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
            return <span key={i} className="italic text-white/80">{part}</span>;
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
            return <span key={i} className="bg-white/10 text-white rounded-sm">{part}</span>;
        }
        return <span key={i}>{part}</span>;
    });
};

const MarkdownOverlay = ({ content }) => {
    // We render line by line to handle block styles (headers, lists)
    // Note: We cannot change font-size or layout (padding/margins) because it would desync from the textarea
    const lines = content.split('\n');
    
    return (
        <>
            {lines.map((line, i) => {
                let inner = parseLine(line);
                let className = "";
                
                if (line.startsWith('# ')) {
                    className = "font-bold text-white";
                } else if (line.startsWith('## ')) {
                    className = "font-bold text-white";
                } else if (line.startsWith('### ')) {
                    className = "font-bold text-white";
                } else if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
                    className = "text-white/80";
                    // Highlight the bullet
                    const match = line.match(/^(\s*[-*])(\s.*)/);
                    if (match) {
                        inner = <><span className="text-white font-bold">{match[1]}</span>{parseLine(match[2])}</>;
                    }
                } else if (line.startsWith('> ')) {
                    className = "text-white/60 italic";
                }

                return (
                    <div key={i} className={`${className} min-h-[1.5em]`}>
                        {inner}
                        {line.length === 0 && <br />} 
                    </div>
                );
            })}
        </>
    );
};

// Helper to parse inline markdown for the rendered view (removes syntax)
const parseInlineRendered = (text) => {
    const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
    return parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
            return <strong key={i} className="font-bold text-white/90">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
            return <em key={i} className="italic text-white/80">{part.slice(1, -1)}</em>;
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
            return <code key={i} className="bg-white/10 px-1 py-0.5 rounded text-white font-mono text-xs border border-white/5">{part.slice(1, -1)}</code>;
        }
        return part;
    });
};

const RenderedView = ({ content }) => {
    if (!content) return <div className="p-5 text-white/30 italic">Empty...</div>;
    
    const lines = content.split('\n');
    const elements = [];
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        
        if (line.startsWith('# ')) {
            elements.push(<h1 key={i} className="text-xl font-bold text-white mt-4 mb-2 border-b border-white/10 pb-1">{parseInlineRendered(line.slice(2))}</h1>);
        } else if (line.startsWith('## ')) {
            elements.push(<h2 key={i} className="text-lg font-bold text-white mt-3 mb-2">{parseInlineRendered(line.slice(3))}</h2>);
        } else if (line.startsWith('### ')) {
            elements.push(<h3 key={i} className="text-base font-bold text-white mt-2 mb-1">{parseInlineRendered(line.slice(4))}</h3>);
        } else if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
             elements.push(
                <div key={i} className="flex items-start gap-2 ml-1 mb-1">
                    <span className="text-white mt-1.5 text-[10px]">•</span>
                    <span className="text-white/80 leading-relaxed">{parseInlineRendered(line.trim().slice(2))}</span>
                </div>
            );
        } else if (line.startsWith('> ')) {
             elements.push(
                <div key={i} className="border-l-2 border-cyan-500/50 pl-3 py-1 my-2 text-white/60 italic bg-white/5 rounded-r">
                    {parseInlineRendered(line.slice(2))}
                </div>
            );
        } else if (!line.trim()) {
            elements.push(<div key={i} className="h-2" />);
        } else {
            elements.push(<p key={i} className="mb-1 text-white/80 leading-relaxed">{parseInlineRendered(line)}</p>);
        }
    }
    
    return <div className="p-5 overflow-y-auto custom-scrollbar h-full select-text">{elements}</div>;
};

const NotesWindow = ({ socket, onClose, position, onMouseDown, activeDragElement, zIndex }) => {
    const { t } = useLanguage();
    const [notesText, setNotesText] = useState('');
    const [isPreview, setIsPreview] = useState(true);
    const [project, setProject] = useState('temp');
    const [status, setStatus] = useState('idle'); // idle, saving, saved
    const textareaRef = useRef(null);
    const timeoutRef = useRef(null);
    const saveTimeoutRef = useRef(null);
    const typingTimeoutRef = useRef(null);
    const isTypingRef = useRef(false);
    const notesTextRef = useRef('');
    const backdropRef = useRef(null);

    const requestNotes = () => {
        if (!socket) return;
        socket.emit('notes_get');
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setStatus('idle'), 1200);
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
            setStatus('saved');
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => setStatus('idle'), 1200);
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
        setStatus('saving');
        saveTimeoutRef.current = setTimeout(() => {
            socket.emit('notes_set', { content: text || '' });
        }, 450);
    };

    const updateText = (val) => {
        setNotesText(val);
        isTypingRef.current = true;
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
            isTypingRef.current = false;
        }, 700);
        scheduleSave(val);
    };

    const handleChange = (e) => {
        updateText(e.target.value);
    };

    const handleKeyDown = (e) => {
        // Handle Ctrl+B (Bold) and Ctrl+I (Italic)
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
            const key = e.key.toLowerCase();
            if (key !== 'b' && key !== 'i') return;

            e.preventDefault();
            const textarea = textareaRef.current;
            if (!textarea) return;

            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const val = textarea.value;
            const wrapper = key === 'b' ? '**' : '*';

            const newVal = val.substring(0, start) + wrapper + val.substring(start, end) + wrapper + val.substring(end);
            updateText(newVal);

            requestAnimationFrame(() => {
                textarea.selectionStart = start + wrapper.length;
                textarea.selectionEnd = end + wrapper.length;
            });
        }
    };

    const handleScroll = (e) => {
        if (backdropRef.current) {
            backdropRef.current.scrollTop = e.target.scrollTop;
        }
    };

    return (
        <div
            id="notes"
            className={`absolute flex flex-col transition-[box-shadow,border-color] duration-200
                backdrop-blur-2xl bg-black/50 border border-white/[0.14] shadow-2xl overflow-hidden rounded-xl
                ${activeDragElement === 'notes' ? 'ring-1 ring-white/50 border-white/30' : ''}
            `}
            style={{
                left: position.x,
                top: position.y,
                transform: 'translate(-50%, -50%)',
                width: '500px',
                height: '600px',
                pointerEvents: 'auto',
                zIndex: zIndex
            }}
            onMouseDown={onMouseDown}
        >
            {/* Header */}
            <div 
                className="flex items-center justify-between p-4 border-b border-white/10 bg-white/5 shrink-0 cursor-grab active:cursor-grabbing"
                data-drag-handle
            >
                <div className="flex items-center gap-3">
                    <FileText size={18} className="text-white" />
                    <span className="text-sm font-medium tracking-wider text-white/90 uppercase">{t('notes.title')}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-white/50 font-mono border border-white/5">
                        {project}
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 min-w-[60px] justify-end">
                        {status === 'saving' && (
                            <>
                                <Loader2 size={12} className="animate-spin text-white" />
                                <span className="text-[10px] text-white/40">{t('notes.saving')}</span>
                            </>
                        )}
                        {status === 'saved' && (
                            <>
                                <Check size={12} className="text-green-400" />
                                <span className="text-[10px] text-white/40">{t('notes.saved')}</span>
                            </>
                        )}
                    </div>
                    <button
                        onClick={() => setIsPreview(!isPreview)}
                        className={`p-1.5 rounded-lg transition-colors ${isPreview ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
                        title={isPreview ? "Edit" : "Preview"}
                    >
                        {isPreview ? <Edit2 size={16} /> : <Eye size={16} />}
                    </button>
                    <button
                        onClick={onClose}
                        className="p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-lg text-white/50 transition-colors"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>

            <div className="flex-1 relative group bg-black/20 overflow-hidden">
                {isPreview ? (
                    <RenderedView content={notesText} />
                ) : (
                    <>
                        {/* Backdrop (Renderer) */}
                        <div 
                            ref={backdropRef}
                            className="absolute inset-0 p-5 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words pointer-events-none overflow-y-scroll scrollbar-hide text-white/80"
                            aria-hidden="true"
                        >
                            <MarkdownOverlay content={notesText} />
                        </div>

                        {/* Textarea (Input) */}
                        <textarea
                            ref={textareaRef}
                            value={notesText}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            onScroll={handleScroll}
                            placeholder={t('notes.placeholder')}
                            className="absolute inset-0 w-full h-full bg-transparent p-5 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words outline-none placeholder:text-white/20 text-transparent caret-white resize-none overflow-y-scroll custom-scrollbar"
                            spellCheck={false}
                        />
                    </>
                )}
                
                <div className="absolute inset-0 pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] mix-blend-overlay" />
            </div>
        </div>
    );
};

export default NotesWindow;
