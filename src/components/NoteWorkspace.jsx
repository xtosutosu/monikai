import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Edit2, Eye, Loader2, Plus, Trash2, Pin } from 'lucide-react';

const parseLine = (text) => {
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
  const lines = content.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        let inner = parseLine(line);
        let className = '';

        if (line.startsWith('# ')) {
          className = 'font-bold text-white';
        } else if (line.startsWith('## ')) {
          className = 'font-bold text-white';
        } else if (line.startsWith('### ')) {
          className = 'font-bold text-white';
        } else if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
          className = 'text-white/80';
          const match = line.match(/^(\s*[-*])(\s.*)/);
          if (match) {
            inner = <><span className="text-white font-bold">{match[1]}</span>{parseLine(match[2])}</>;
          }
        } else if (line.startsWith('> ')) {
          className = 'text-white/60 italic';
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

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
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

const slugify = (val) => {
  const cleaned = (val || '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || `note-${Date.now()}`;
};

const NoteWorkspace = ({
  socket,
  defaultPath = 'notes.md',
  basePath = '',
  filterPrefix = '',
  pageLabel = '',
  onContentChange,
  initialCategory,
  compact = false,
}) => {
  const [notesText, setNotesText] = useState('');
  const [pagePath, setPagePath] = useState(defaultPath);
  const [isPreview, setIsPreview] = useState(true);
  const [status, setStatus] = useState('idle'); // idle, saving, saved
  const [pages, setPages] = useState([]);
  const [category, setCategory] = useState(initialCategory || 'all');
  const [showNewPage, setShowNewPage] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('');

  const textareaRef = useRef(null);
  const overlayRef = useRef(null);
  const timeoutRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isTypingRef = useRef(false);
  const notesTextRef = useRef('');
  const pagePathRef = useRef('');

  const normalizedBase = useMemo(() => (basePath || '').replace(/\\/g, '/').replace(/\/+$/, ''), [basePath]);
  const normalizedFilter = useMemo(() => (filterPrefix || '').replace(/\\/g, '/').replace(/\/+$/, ''), [filterPrefix]);

  const normalizePath = (val) => {
    let next = (val || '').trim().replace(/\\/g, '/');
    if (!next) return 'notes.md';
    if (!/\.(md|txt)$/i.test(next)) {
      next = `${next}.md`;
    }
    return next;
  };

  const stripPrefix = (path) => {
    if (!normalizedFilter) return path;
    if (path === normalizedFilter) return '';
    if (path.startsWith(`${normalizedFilter}/`)) {
      return path.slice(normalizedFilter.length + 1);
    }
    return path;
  };

  const deriveCategory = (path) => {
    const rel = stripPrefix(path);
    if (!rel) return 'root';
    if (!rel.includes('/')) return 'root';
    return rel.split('/')[0];
  };

  useEffect(() => {
    notesTextRef.current = notesText;
  }, [notesText]);

  useEffect(() => {
    pagePathRef.current = pagePath;
  }, [pagePath]);

  const requestNotes = (pathOverride) => {
    if (!socket) return;
    const target = normalizePath(pathOverride || pagePathRef.current || defaultPath);
    if (target !== pagePathRef.current) {
      setPagePath(target);
    }
    socket.emit('memory_get_page', { path: target });
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setStatus('idle'), 1200);
  };

  useEffect(() => {
    if (!socket) return;
    requestNotes();
    socket.emit('memory_list_pages');

    const onNotes = (data) => {
      if (data && typeof data.text === 'string') {
        if (!isTypingRef.current || data.text !== notesTextRef.current) {
          setNotesText(data.text);
        }
      }
      if (data && data.path) {
        const base = data.path.replace(/\\/g, '/');
        const idx = base.lastIndexOf('memory/pages/');
        if (idx >= 0) {
          const rel = base.slice(idx + 'memory/pages/'.length);
          setPagePath(rel);
        }
      }
      setStatus('saved');
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setStatus('idle'), 1200);
    };

    const onPages = (data) => {
      const list = Array.isArray(data?.pages) ? data.pages : [];
      const mapped = list.map((p) => {
        if (typeof p === 'string') {
          const normalized = p.replace(/\\/g, '/');
          return { path: normalized, title: normalized.replace(/.*\//, '').replace(/\.(md|txt)$/i, ''), category: deriveCategory(normalized) };
        }
        const normalized = String(p.path || '').replace(/\\/g, '/');
        return {
          path: normalized,
          title: p.title || normalized.replace(/.*\//, '').replace(/\.(md|txt)$/i, ''),
          category: p.category || deriveCategory(normalized),
        };
      });
      setPages(mapped);
    };

    socket.on('memory_page', onNotes);
    socket.on('memory_pages', onPages);
    return () => {
      socket.off('memory_page', onNotes);
      socket.off('memory_pages', onPages);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  useEffect(() => {
    if (!onContentChange) return;
    onContentChange({ text: notesText, path: pagePath });
  }, [notesText, pagePath, onContentChange]);

  const scheduleSave = (text) => {
    if (!socket) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setStatus('saving');
    saveTimeoutRef.current = setTimeout(() => {
      const target = normalizePath(pagePathRef.current || defaultPath);
      socket.emit('memory_set_page', { path: target, content: text || '' });
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

  const handleScroll = (e) => {
    if (overlayRef.current) {
      overlayRef.current.scrollTop = e.target.scrollTop;
    }
  };

  const filteredPages = pages
    .filter(p => (!normalizedFilter ? true : p.path.startsWith(`${normalizedFilter}/`) || p.path === normalizedFilter))
    .map(p => ({ ...p, category: deriveCategory(p.path) }));

  const categories = Array.from(new Set(
    filteredPages.map(p => p.category || 'root')
  )).sort((a, b) => a.localeCompare(b));

  useEffect(() => {
    if (initialCategory) {
      setCategory(initialCategory);
      return;
    }
    if (!category || category === 'all') return;
    if (categories.length && !categories.includes(category)) {
      setCategory('all');
    }
  }, [categories, category, initialCategory]);

  const visiblePages = filteredPages.filter(p => {
    if (category === 'all') return true;
    if (category === 'root') return p.category === 'root';
    return p.category === category;
  });

  const activePage = visiblePages.find(p => p.path === pagePath)
    || filteredPages.find(p => p.path === pagePath)
    || null;

  const createPage = () => {
    if (!socket) return;
    const title = newTitle.trim();
    if (!title) return;
    const catRaw = (newCategory || category) || '';
    const cat = catRaw === 'all' ? '' : catRaw;
    const slug = slugify(title);
    const prefix = normalizedFilter || normalizedBase;
    const rel = cat && cat !== 'root' ? `${cat}/${slug}.md` : `${slug}.md`;
    let candidate = prefix ? `${prefix}/${rel}` : rel;

    const existing = new Set(pages.map(p => p.path));
    let i = 2;
    while (existing.has(candidate)) {
      const withSuffix = cat && cat !== 'root' ? `${cat}/${slug}-${i}.md` : `${slug}-${i}.md`;
      candidate = prefix ? `${prefix}/${withSuffix}` : withSuffix;
      i += 1;
    }

    setPagePath(candidate);
    socket.emit('memory_create_page', { path: candidate, title });
    socket.emit('memory_list_pages');
    setNewTitle('');
    setNewCategory('');
    setShowNewPage(false);
    requestNotes(candidate);
  };

  const deletePage = () => {
    if (!socket || !pagePath) return;
    if (!window.confirm(`Delete "${activePage?.title || pagePath}"?`)) return;
    socket.emit('memory_delete_page', { path: pagePath });
    socket.emit('memory_list_pages');
    setTimeout(() => requestNotes(defaultPath), 150);
  };

  const usePage = () => {
    if (!pageLabel) return;
    const title = `Page ${pageLabel}`;
    const slug = slugify(`page-${pageLabel}`);
    const prefix = normalizedFilter || normalizedBase;
    const candidate = prefix ? `${prefix}/${slug}.md` : `${slug}.md`;
    const exists = pages.some(p => p.path === candidate);
    setPagePath(candidate);
    if (!exists) {
      socket.emit('memory_create_page', { path: candidate, title });
      socket.emit('memory_list_pages');
    }
    requestNotes(candidate);
  };

  return (
    <div className={`flex h-full min-h-0 ${compact ? 'text-[11px]' : 'text-sm'}`}>
      <div className={`shrink-0 border-r border-white/10 bg-white/5 ${compact ? 'w-44' : 'w-56'} flex flex-col`}>
        <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
          <div className="text-[10px] text-white/60 uppercase tracking-wider">Notes</div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowNewPage(v => !v)}
              className="p-1 rounded-md bg-white/10 hover:bg-white/20 text-white/70"
              title="New page"
            >
              <Plus size={12} />
            </button>
            <button
              onClick={deletePage}
              className="p-1 rounded-md bg-white/10 hover:bg-red-500/20 text-white/70 hover:text-red-300"
              title="Delete page"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>

        <div className="px-3 py-2 border-b border-white/10">
          <div className="text-[9px] text-white/40 uppercase tracking-wider mb-1">Category</div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white/70 focus:outline-none focus:border-white/30"
          >
            <option value="all">All</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        {showNewPage && (
          <div className="px-3 py-2 border-b border-white/10 space-y-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white/70 focus:outline-none focus:border-white/30"
              placeholder="Note title"
            />
            <input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white/70 focus:outline-none focus:border-white/30"
              placeholder="Category (optional)"
            />
            <button
              onClick={createPage}
              className="w-full px-2 py-1 rounded-md bg-white/15 hover:bg-white/25 text-white/80 text-[11px]"
            >
              Create
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto custom-scrollbar px-2 py-2 space-y-1">
          {visiblePages.length === 0 && (
            <div className="text-[10px] text-white/30 px-2 py-1">No pages yet.</div>
          )}
          {visiblePages.map(p => {
            const isActive = p.path === pagePath;
            return (
              <button
                key={p.path}
                onClick={() => {
                  setPagePath(p.path);
                  requestNotes(p.path);
                }}
                className={`w-full text-left px-2 py-1.5 rounded-md transition-colors ${
                  isActive ? 'bg-white/20 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
                }`}
              >
                <div className="text-[11px] font-medium">{p.title || 'Untitled'}</div>
                <div className="text-[9px] text-white/35 truncate">{stripPrefix(p.path) || p.path}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col bg-black/20">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white truncate">{activePage?.title || 'Untitled'}</div>
            <div className="text-[10px] text-white/35 truncate">{stripPrefix(pagePath) || pagePath}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {status === 'saving' && (
              <div className="flex items-center gap-1 text-[10px] text-white/40">
                <Loader2 size={12} className="animate-spin" />
                Saving
              </div>
            )}
            {status === 'saved' && (
              <div className="flex items-center gap-1 text-[10px] text-white/40">
                <Check size={12} className="text-green-400" />
                Saved
              </div>
            )}
            {pageLabel && (
              <button
                onClick={usePage}
                className="px-2 py-1 rounded-md bg-white/10 hover:bg-white/20 text-white/70 text-[10px] flex items-center gap-1"
                title="Attach to current page"
              >
                <Pin size={12} />
                Use page
              </button>
            )}
            <button
              onClick={() => setIsPreview(!isPreview)}
              className={`p-1.5 rounded-lg transition-colors ${isPreview ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
              title={isPreview ? 'Edit' : 'Preview'}
            >
              {isPreview ? <Edit2 size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 relative group bg-black/10 overflow-hidden">
          {isPreview ? (
            <RenderedView content={notesText} />
          ) : (
            <>
              <div
                ref={overlayRef}
                className="absolute inset-0 p-5 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words pointer-events-none overflow-y-scroll scrollbar-hide text-white/80"
                aria-hidden="true"
              >
                <MarkdownOverlay content={notesText} />
              </div>
              <textarea
                ref={textareaRef}
                value={notesText}
                onChange={(e) => updateText(e.target.value)}
                onScroll={handleScroll}
                placeholder="Write your notes here..."
                className="absolute inset-0 w-full h-full bg-transparent p-5 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words outline-none placeholder:text-white/20 text-transparent caret-white resize-none overflow-y-scroll custom-scrollbar"
                spellCheck={false}
              />
            </>
          )}
          <div className="absolute inset-0 pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] mix-blend-overlay" />
        </div>
      </div>
    </div>
  );
};

export default NoteWorkspace;
