import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bold,
  Check,
  Edit2,
  Eye,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';

const INLINE_TOKEN_RE = /(\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|==[^=\n]+?==|`[^`\n]+?`|<u>[\s\S]+?<\/u>|<mark>[\s\S]+?<\/mark>|<span[^>]*>[\s\S]+?<\/span>)/g;
const ALIGN_OPEN_RE = /^<div\s+(?:style="text-align:\s*(left|center|right|justify)\s*"|align="(left|center|right|justify)")\s*>/i;
const ALIGN_LINE_RE = /^<div\s+style="text-align:\s*(left|center|right|justify)\s*"\s*>$/i;

const alignToClass = (align) => {
  if (align === 'center') return 'text-center';
  if (align === 'right') return 'text-right';
  if (align === 'justify') return 'text-justify';
  return '';
};

const sanitizeMarkdown = (value) => {
  if (!value) return value;
  let next = value;
  next = next.replace(/<mark>([\s\S]*?)<\/mark>/gi, '==$1==');
  next = next.replace(/<u>([\s\S]*?)<\/u>/gi, '$1');
  next = next.replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, '$1');
  next = next.replace(/<\/?div[^>]*>/gi, '');
  return next;
};

const stripSlashMarker = (line) => line.replace(/^(\s*)\/\s*/, '$1');

const normalizeTitle = (value) => {
  return (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const extractHiddenHeading = (text, expectedTitle) => {
  const lines = text.split('\n');
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim()) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return { visibleText: text, hiddenHeading: '' };
  const line = lines[firstIdx];
  const match = line.match(/^#\s+(.+)/);
  if (!match) return { visibleText: text, hiddenHeading: '' };
  const headingTitle = normalizeTitle(match[1]);
  const expected = normalizeTitle(expectedTitle);
  if (!expected || headingTitle !== expected) {
    return { visibleText: text, hiddenHeading: '' };
  }
  const nextLines = [...lines];
  nextLines.splice(firstIdx, 1);
  return { visibleText: nextLines.join('\n'), hiddenHeading: line };
};

const extractSpanStyle = (part) => {
  const inner = part.replace(/^<span[^>]*>/i, '').replace(/<\/span>$/i, '');
  const openTag = part.match(/^<span[^>]*>/i)?.[0] || '';
  const style = {};
  const styleAttrMatch = openTag.match(/style\s*=\s*["']([^"']+)["']/i) || openTag.match(/style\s*=\s*([^>]+)/i);
  const styleText = styleAttrMatch ? styleAttrMatch[1] : '';
  const colorMatch = styleText.match(/color:\s*([^;"']+)/i);
  const bgMatch = styleText.match(/background-color:\s*([^;"']+)/i);
  if (colorMatch) style.color = colorMatch[1].trim();
  if (bgMatch) style.backgroundColor = bgMatch[1].trim();
  return { inner, style };
};

const renderInline = (text, mode = 'preview') => {
  const parts = text.split(INLINE_TOKEN_RE).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      const inner = part.slice(2, -2);
      return (
        <span key={i} className="font-bold text-white/90">
          {renderInline(inner, mode)}
        </span>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      const inner = part.slice(1, -1);
      return (
        <span key={i} className="italic text-white/80">
          {renderInline(inner, mode)}
        </span>
      );
    }
    if (part.startsWith('==') && part.endsWith('==') && part.length >= 4) {
      const inner = part.slice(2, -2);
      return (
        <mark key={i} className="bg-yellow-400/40 text-white px-0.5 rounded-sm">
          {renderInline(inner, mode)}
        </mark>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code key={i} className="bg-white/10 px-1 py-0.5 rounded text-white font-mono text-xs border border-white/5">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('<u>') && part.endsWith('</u>')) {
      const inner = part.slice(3, -4);
      return (
        <span key={i} className="underline decoration-white/70">
          {renderInline(inner, mode)}
        </span>
      );
    }
    if (part.startsWith('<mark>') && part.endsWith('</mark>')) {
      const inner = part.slice(6, -7);
      return (
        <mark key={i} className="bg-yellow-400/40 text-white px-0.5 rounded-sm">
          {renderInline(inner, mode)}
        </mark>
      );
    }
    if (part.toLowerCase().startsWith('<span')) {
      const { inner, style } = extractSpanStyle(part);
      const hasBg = Boolean(style.backgroundColor);
      return (
        <span key={i} style={style} className={hasBg ? 'px-0.5 rounded-sm' : ''}>
          {renderInline(inner, mode)}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
};

const renderOverlayLine = (line, key) => {
  let inner = renderInline(line, 'overlay');
  let className = '';

  if (line.startsWith('# ')) {
    className = 'font-bold text-white';
    inner = renderInline(line.slice(2), 'overlay');
  } else if (line.startsWith('## ')) {
    className = 'font-bold text-white';
    inner = renderInline(line.slice(3), 'overlay');
  } else if (line.startsWith('### ')) {
    className = 'font-bold text-white';
    inner = renderInline(line.slice(4), 'overlay');
  } else if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
    className = 'text-white/80';
    const match = line.match(/^(\s*[-*])(\s.*)/);
    if (match) {
      inner = (
        <span className="flex items-start gap-2">
          <span className="text-white mt-1 text-[10px]">•</span>
          <span>{renderInline(match[2].trimStart(), 'overlay')}</span>
        </span>
      );
    }
  } else if (line.startsWith('> ')) {
    className = 'text-white/60 italic';
    inner = renderInline(line.slice(2), 'overlay');
  }

  return (
    <div key={key} className={`${className} min-h-[1.5em]`}>
      {inner}
      {line.length === 0 && <br />}
    </div>
  );
};

const MarkdownOverlay = ({ content }) => {
  const lines = content.split('\n');
  const elements = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const alignMatch = line.match(ALIGN_OPEN_RE);
    if (alignMatch) {
      const align = alignMatch[1] || alignMatch[2] || 'left';
      const alignClass = alignToClass(align);
      const blockLines = [];
      const remainder = line.replace(ALIGN_OPEN_RE, '').trimStart();
      if (remainder.includes('</div>')) {
        const closeIndex = remainder.indexOf('</div>');
        const beforeClose = remainder.slice(0, closeIndex);
        if (beforeClose) blockLines.push(beforeClose);
        elements.push(
          <div key={`align-${i}`} className={alignClass}>
            {blockLines.map((blockLine, idx) => renderOverlayLine(blockLine, `align-${i}-${idx}`))}
          </div>
        );
        continue;
      }
      if (remainder) blockLines.push(remainder);
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const closeIndex = nextLine.indexOf('</div>');
        if (closeIndex !== -1) {
          const beforeClose = nextLine.slice(0, closeIndex);
          if (beforeClose) blockLines.push(beforeClose);
          i += 1;
          break;
        }
        blockLines.push(nextLine);
        i += 1;
      }
      elements.push(
        <div key={`align-${i}`} className={alignClass}>
          {blockLines.map((blockLine, idx) => renderOverlayLine(blockLine, `align-${i}-${idx}`))}
        </div>
      );
      continue;
    }
    elements.push(renderOverlayLine(line, i));
  }

  return <>{elements}</>;
};

const renderPreviewLine = (line, key) => {
  if (line.startsWith('# ')) {
    return <h1 key={key} className="text-xl font-bold text-white mt-4 mb-2 border-b border-white/10 pb-1">{renderInline(line.slice(2), 'preview')}</h1>;
  }
  if (line.startsWith('## ')) {
    return <h2 key={key} className="text-lg font-bold text-white mt-3 mb-2">{renderInline(line.slice(3), 'preview')}</h2>;
  }
  if (line.startsWith('### ')) {
    return <h3 key={key} className="text-base font-bold text-white mt-2 mb-1">{renderInline(line.slice(4), 'preview')}</h3>;
  }
  if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
    return (
      <div key={key} className="flex items-start gap-2 ml-1 mb-1">
        <span className="text-white mt-1.5 text-[10px]">•</span>
        <span className="text-white/80 leading-relaxed">{renderInline(line.trim().slice(2), 'preview')}</span>
      </div>
    );
  }
  if (line.startsWith('> ')) {
    return (
      <div key={key} className="border-l-2 border-cyan-500/50 pl-3 py-1 my-2 text-white/60 italic bg-white/5 rounded-r">
        {renderInline(line.slice(2), 'preview')}
      </div>
    );
  }
  if (!line.trim()) {
    return <div key={key} className="h-2" />;
  }
  return <p key={key} className="mb-1 text-white/80 leading-relaxed">{renderInline(line, 'preview')}</p>;
};

const RenderedView = ({ content }) => {
  if (!content) return <div className="p-5 text-white/30 italic">Empty...</div>;

  const lines = content.split('\n');
  const elements = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const alignMatch = line.match(ALIGN_OPEN_RE);
    if (alignMatch) {
      const align = alignMatch[1] || alignMatch[2] || 'left';
      const alignClass = alignToClass(align);
      const blockLines = [];
      const remainder = line.replace(ALIGN_OPEN_RE, '').trimStart();
      if (remainder.includes('</div>')) {
        const closeIndex = remainder.indexOf('</div>');
        const beforeClose = remainder.slice(0, closeIndex);
        if (beforeClose) blockLines.push(beforeClose);
        elements.push(
          <div key={`align-${i}`} className={alignClass}>
            {blockLines.map((blockLine, idx) => renderPreviewLine(blockLine, `align-${i}-${idx}`))}
          </div>
        );
        continue;
      }
      if (remainder) blockLines.push(remainder);
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const closeIndex = nextLine.indexOf('</div>');
        if (closeIndex !== -1) {
          const beforeClose = nextLine.slice(0, closeIndex);
          if (beforeClose) blockLines.push(beforeClose);
          i += 1;
          break;
        }
        blockLines.push(nextLine);
        i += 1;
      }
      elements.push(
        <div key={`align-${i}`} className={alignClass}>
          {blockLines.map((blockLine, idx) => renderPreviewLine(blockLine, `align-${i}-${idx}`))}
        </div>
      );
      continue;
    }
    elements.push(renderPreviewLine(line, i));
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
  onContentChange,
  initialCategory,
  compact = false,
  hideCategories = false,
  hidePaths = false,
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
  const [contextMenu, setContextMenu] = useState(null);
  const [slashMenu, setSlashMenu] = useState(null);
  const [titleEdit, setTitleEdit] = useState(null);
  const [hiddenHeading, setHiddenHeading] = useState('');

  const textareaRef = useRef(null);
  const overlayRef = useRef(null);
  const titleInputRef = useRef(null);
  const timeoutRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isTypingRef = useRef(false);
  const notesTextRef = useRef('');
  const pagePathRef = useRef('');
  const hiddenHeadingRef = useRef('');
  const requestedPathRef = useRef('');
  const pagesRef = useRef([]);
  const hideCategoryUI = Boolean(hideCategories);
  const showPaths = !hidePaths;

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

  useEffect(() => {
    hiddenHeadingRef.current = hiddenHeading;
  }, [hiddenHeading]);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    hiddenHeadingRef.current = '';
    setHiddenHeading('');
  }, [pagePath]);

  useEffect(() => {
    if (hiddenHeadingRef.current) return;
    if (!notesTextRef.current) return;
    const pageInfo = pagesRef.current.find(p => p.path === pagePathRef.current);
    if (!pageInfo?.title) return;
    const { visibleText, hiddenHeading: extractedHeading } = extractHiddenHeading(notesTextRef.current, pageInfo.title);
    if (extractedHeading && visibleText !== notesTextRef.current) {
      setHiddenHeading(extractedHeading);
      setNotesText(visibleText);
    }
  }, [pages, pagePath]);

  const requestNotes = (pathOverride) => {
    if (!socket) return;
    const target = normalizePath(pathOverride || pagePathRef.current || defaultPath);
    requestedPathRef.current = target;
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
        const cleaned = sanitizeMarkdown(data.text);
        const normalizedPath = String(data.path || '').replace(/\\/g, '/');
        let relPath = '';
        if (normalizedPath) {
          const idx = normalizedPath.lastIndexOf('memory/pages/');
          if (idx >= 0) {
            relPath = normalizedPath.slice(idx + 'memory/pages/'.length);
          }
        }
        const currentPath = pagePathRef.current;
        const requestedPath = requestedPathRef.current;
        if (relPath && relPath !== currentPath && relPath !== requestedPath) {
          return;
        }
        const pageInfo = pagesRef.current.find(p => p.path === (relPath || normalizedPath));
        const expectedTitle = pageInfo?.title
          || (relPath || normalizedPath).split('/').pop()?.replace(/\.(md|txt)$/i, '') || '';
        const { visibleText, hiddenHeading: extractedHeading } = extractHiddenHeading(cleaned, expectedTitle);
        hiddenHeadingRef.current = extractedHeading;
        setHiddenHeading(extractedHeading);
        if (!isTypingRef.current || visibleText !== notesTextRef.current) {
          setNotesText(visibleText);
        }
        if (cleaned !== data.text) {
          scheduleSave(visibleText);
        }
      }
      if (data && data.path) {
        const base = data.path.replace(/\\/g, '/');
        const idx = base.lastIndexOf('memory/pages/');
        if (idx >= 0) {
          const rel = base.slice(idx + 'memory/pages/'.length);
          if (rel === requestedPathRef.current || rel === pagePathRef.current) {
            setPagePath(rel);
          }
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
    const payload = hiddenHeadingRef.current
      ? `${hiddenHeadingRef.current}\n${text || ''}`
      : (text || '');
    saveTimeoutRef.current = setTimeout(() => {
      const target = normalizePath(pagePathRef.current || defaultPath);
      socket.emit('memory_set_page', { path: target, content: payload });
    }, 450);
  };

  const updateText = (val) => {
    const cleaned = sanitizeMarkdown(val);
    setNotesText(cleaned);
    isTypingRef.current = true;
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
    }, 700);
    scheduleSave(cleaned);
  };

  const applyTextChange = (nextValue, selectionStart, selectionEnd) => {
    updateText(nextValue);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(selectionStart, selectionEnd);
    });
  };

  const wrapSelection = (before, after, { perLine = false } = {}) => {
    const el = textareaRef.current;
    if (!el) return;
    const value = notesTextRef.current || '';
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const selected = value.slice(start, end);

    if (!selected) {
      const nextValue = value.slice(0, start) + before + after + value.slice(end);
      applyTextChange(nextValue, start + before.length, start + before.length);
      return;
    }

    let replacement = selected;
    if (perLine && selected.includes('\n')) {
      replacement = selected
        .split('\n')
        .map((line) => {
          if (!line) return line;
          const match = line.match(/^(\s*)(.*)$/);
          const indent = match ? match[1] : '';
          const rest = match ? match[2] : line;
          const markerMatch = rest.match(/^((?:#{1,6}\s+)|(?:>\s+)|(?:[-*]\s+)|(?:\d+\.\s+))/);
          const marker = markerMatch ? markerMatch[1] : '';
          const body = markerMatch ? rest.slice(marker.length) : rest;
          if (body.startsWith(before) && body.endsWith(after)) {
            return `${indent}${marker}${body.slice(before.length, body.length - after.length)}`;
          }
          return `${indent}${marker}${before}${body}${after}`;
        })
        .join('\n');
    } else if (selected.startsWith(before) && selected.endsWith(after)) {
      replacement = selected.slice(before.length, selected.length - after.length);
    } else {
      replacement = `${before}${selected}${after}`;
    }

    const nextValue = value.slice(0, start) + replacement + value.slice(end);
    applyTextChange(nextValue, start, start + replacement.length);
  };

  const applyLineTransform = (transform) => {
    const el = textareaRef.current;
    if (!el) return;
    const value = notesTextRef.current || '';
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const blockStart = value.lastIndexOf('\n', start - 1) + 1;
    let blockEnd = value.indexOf('\n', end);
    if (blockEnd === -1) blockEnd = value.length;
    const block = value.slice(blockStart, blockEnd);
    const lines = block.split('\n');
    const nextLines = transform(lines);
    const nextBlock = nextLines.join('\n');
    const nextValue = value.slice(0, blockStart) + nextBlock + value.slice(blockEnd);
    applyTextChange(nextValue, blockStart, blockStart + nextBlock.length);
  };

  const toggleBulletList = () => {
    applyLineTransform((lines) => {
      const cleanedLines = lines.map(line => stripSlashMarker(line));
      const nonEmpty = cleanedLines.filter(line => line.trim());
      const allBulleted = nonEmpty.length > 0 && nonEmpty.every(line => /^(\s*)[-*]\s+/.test(line));
      if (allBulleted) {
        return cleanedLines.map(line => line.replace(/^(\s*)[-*]\s+/, '$1'));
      }
      return cleanedLines.map((line) => {
        if (!line.trim()) return line;
        const match = line.match(/^(\s*)(.*)$/);
        const indent = match ? match[1] : '';
        const rest = match ? match[2] : line;
        const cleaned = rest.replace(/^([-*]|\d+\.)\s+/, '');
        return `${indent}- ${cleaned}`;
      });
    });
  };

  const toggleNumberedList = () => {
    applyLineTransform((lines) => {
      const cleanedLines = lines.map(line => stripSlashMarker(line));
      const nonEmpty = cleanedLines.filter(line => line.trim());
      const allNumbered = nonEmpty.length > 0 && nonEmpty.every(line => /^\s*\d+\.\s+/.test(line));
      if (allNumbered) {
        return cleanedLines.map(line => line.replace(/^\s*\d+\.\s+/, ''));
      }
      let index = 1;
      return cleanedLines.map((line) => {
        if (!line.trim()) return line;
        const match = line.match(/^(\s*)(.*)$/);
        const indent = match ? match[1] : '';
        const rest = match ? match[2] : line;
        const cleaned = rest.replace(/^([-*]|\d+\.)\s+/, '');
        const next = `${indent}${index}. ${cleaned}`;
        index += 1;
        return next;
      });
    });
  };

  const applyBulletCommand = () => {
    applyLineTransform((lines) => {
      const cleanedLines = lines.map(line => stripSlashMarker(line));
      return cleanedLines.map((line) => {
        const match = line.match(/^(\s*)(.*)$/);
        const indent = match ? match[1] : '';
        const rest = match ? match[2] : line;
        const cleaned = rest.replace(/^([-*]|\d+\.)\s+/, '');
        return `${indent}- ${cleaned}`.trimEnd();
      });
    });
  };

  const applyNumberedCommand = () => {
    applyLineTransform((lines) => {
      const cleanedLines = lines.map(line => stripSlashMarker(line));
      let index = 1;
      return cleanedLines.map((line) => {
        const match = line.match(/^(\s*)(.*)$/);
        const indent = match ? match[1] : '';
        const rest = match ? match[2] : line;
        const cleaned = rest.replace(/^([-*]|\d+\.)\s+/, '');
        const next = `${indent}${index}. ${cleaned}`.trimEnd();
        index += 1;
        return next;
      });
    });
  };

  const applyHeading = (level) => {
    const prefix = `${'#'.repeat(level)} `;
    applyLineTransform((lines) => {
      let idx = lines.findIndex(line => line.trim());
      if (idx === -1) return lines;
      const line = stripSlashMarker(lines[idx]);
      const match = line.match(/^(\s*)(.*)$/);
      const indent = match ? match[1] : '';
      const rest = match ? match[2] : line;
      const cleaned = rest.replace(/^#{1,6}\s+/, '');
      if (rest.startsWith(prefix)) {
        lines[idx] = `${indent}${cleaned}`;
      } else {
        lines[idx] = `${indent}${prefix}${cleaned}`;
      }
      return lines;
    });
  };

  const toggleQuote = () => {
    applyLineTransform((lines) => {
      let idx = lines.findIndex(line => line.trim());
      if (idx === -1) return lines;
      const line = stripSlashMarker(lines[idx]);
      const match = line.match(/^(\s*)(.*)$/);
      const indent = match ? match[1] : '';
      const rest = match ? match[2] : line;
      if (rest.startsWith('> ')) {
        lines[idx] = `${indent}${rest.replace(/^>\s+/, '')}`;
      } else {
        lines[idx] = `${indent}> ${rest}`;
      }
      return lines;
    });
  };

  const applyHighlight = () => {
    wrapSelection('==', '==', { perLine: true });
  };

  const getCaretCoordinates = (textarea) => {
    if (!textarea || typeof window === 'undefined') return null;
    const style = window.getComputedStyle(textarea);
    const div = document.createElement('div');
    const properties = [
      'boxSizing',
      'width',
      'height',
      'overflowX',
      'overflowY',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'letterSpacing',
      'textTransform',
      'textAlign',
      'whiteSpace',
      'wordWrap',
      'lineHeight',
    ];
    properties.forEach((prop) => {
      div.style[prop] = style[prop];
    });
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordWrap = 'break-word';
    div.style.overflow = 'hidden';
    div.style.width = `${textarea.clientWidth}px`;

    const value = textarea.value || '';
    const selectionEnd = textarea.selectionEnd ?? value.length;
    div.textContent = value.substring(0, selectionEnd);
    const span = document.createElement('span');
    span.textContent = value.substring(selectionEnd) || '.';
    div.appendChild(span);
    document.body.appendChild(div);

    const rect = textarea.getBoundingClientRect();
    const left = rect.left + span.offsetLeft - textarea.scrollLeft;
    const top = rect.top + span.offsetTop - textarea.scrollTop;
    const lineHeight = parseFloat(style.lineHeight) || 16;
    document.body.removeChild(div);

    return { left, top: top + lineHeight };
  };

  const openSlashMenu = () => {
    const coords = getCaretCoordinates(textareaRef.current);
    if (!coords) return;
    setSlashMenu({ x: coords.left, y: coords.top });
  };

  const closeSlashMenu = () => setSlashMenu(null);

  const updateSlashMenuState = (value, pos) => {
    const lineStart = value.lastIndexOf('\n', Math.max(pos - 1, 0)) + 1;
    const before = value.slice(lineStart, pos);
    const trimmed = before.trim();
    if (trimmed === '/') {
      openSlashMenu();
      return;
    }
    if (!trimmed.startsWith('/')) {
      closeSlashMenu();
    }
  };

  const handleLiveKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeSlashMenu();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '/' || e.key === 'Backspace' || e.key === 'Delete')) {
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value || '';
        const pos = el.selectionStart ?? value.length;
        updateSlashMenuState(value, pos);
      });
    }
  };

  const handleLiveChange = (e) => {
    const value = e.target.value;
    updateText(value);
    const pos = e.target.selectionStart ?? value.length;
    updateSlashMenuState(value, pos);
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
    if (hideCategoryUI) {
      if (category !== 'all') setCategory('all');
      return;
    }
    if (initialCategory) {
      setCategory(initialCategory);
      return;
    }
    if (!category || category === 'all') return;
    if (categories.length && !categories.includes(category)) {
      setCategory('all');
    }
  }, [categories, category, initialCategory, hideCategoryUI]);

  const visiblePages = hideCategoryUI
    ? filteredPages
    : filteredPages.filter(p => {
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
    const catRaw = hideCategoryUI ? '' : (newCategory || category) || '';
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

  const deletePageByPath = (path) => {
    if (!socket || !path) return;
    const normalized = path.replace(/\\/g, '/');
    const title = pages.find(p => p.path === normalized)?.title || normalized.split('/').pop() || path;
    if (!window.confirm(`Delete "${title}"?`)) return;
    socket.emit('memory_delete_page', { path: normalized });
    socket.emit('memory_list_pages');
    if (normalized === pagePathRef.current) {
      setTimeout(() => requestNotes(defaultPath), 150);
    }
  };

  const buildDuplicateContent = (text, originalTitle, newTitle) => {
    const lines = (text || '').split('\n');
    let firstIdx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim()) {
        firstIdx = i;
        break;
      }
    }
    if (firstIdx === -1) {
      return `# ${newTitle}\n\n`;
    }
    const match = lines[firstIdx].match(/^#\s+(.+)/);
    if (match && normalizeTitle(match[1]) === normalizeTitle(originalTitle)) {
      lines[firstIdx] = `# ${newTitle}`;
      return lines.join('\n');
    }
    return `# ${newTitle}\n\n${text || ''}`;
  };

  const duplicatePage = (path) => {
    if (!socket || !path) return;
    const normalized = path.replace(/\\/g, '/');
    const pageInfo = pages.find(p => p.path === normalized);
    const baseTitle = pageInfo?.title || normalized.split('/').pop()?.replace(/\.(md|txt)$/i, '') || 'note';
    const extMatch = normalized.match(/\.[^/.]+$/);
    const ext = extMatch ? extMatch[0] : '.md';
    const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    const baseSlug = slugify(`${baseTitle}-kopia`);
    let candidate = dir ? `${dir}/${baseSlug}${ext}` : `${baseSlug}${ext}`;
    const existing = new Set(pages.map(p => p.path));
    let i = 2;
    while (existing.has(candidate)) {
      candidate = dir ? `${dir}/${baseSlug}-${i}${ext}` : `${baseSlug}-${i}${ext}`;
      i += 1;
    }
    const newTitle = `${baseTitle} kopia`;
    let timeoutId;
    const handler = (data) => {
      const dataPath = String(data?.path || '').replace(/\\/g, '/');
      let relPath = dataPath;
      const idx = dataPath.lastIndexOf('memory/pages/');
      if (idx >= 0) {
        relPath = dataPath.slice(idx + 'memory/pages/'.length);
      }
      if (relPath && relPath !== normalized) return;
      socket.off('memory_page', handler);
      if (timeoutId) clearTimeout(timeoutId);
      const rawText = typeof data?.text === 'string' ? data.text : '';
      const cleaned = sanitizeMarkdown(rawText);
      const content = buildDuplicateContent(cleaned, baseTitle, newTitle);
      socket.emit('memory_create_page', { path: candidate, title: newTitle });
      socket.emit('memory_set_page', { path: candidate, content });
      socket.emit('memory_list_pages');
    };
    socket.on('memory_page', handler);
    timeoutId = setTimeout(() => {
      socket.off('memory_page', handler);
    }, 3000);
    socket.emit('memory_get_page', { path: normalized });
  };

  const openContextMenu = (e, path) => {
    if (!path) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path });
  };

  const revealInFileManager = async (path) => {
    if (!path) return;
    try {
      const ipc = typeof window !== 'undefined' && window.require
        ? window.require('electron').ipcRenderer
        : null;
      if (!ipc) return;
      await ipc.invoke('reveal-memory-page', { path });
    } catch {
      // ignore
    }
  };

  const renamePage = (path, nextTitleOverride) => {
    if (!socket || !path) return;
    const normalized = path.replace(/\\/g, '/');
    const currentTitle = pages.find(p => p.path === normalized)?.title || activePage?.title || 'Untitled';
    let nextTitleRaw = nextTitleOverride;
    if (typeof nextTitleRaw !== 'string') {
      nextTitleRaw = window.prompt('Rename note', currentTitle);
    }
    if (nextTitleRaw === null || typeof nextTitleRaw === 'undefined') return;
    const nextTitle = String(nextTitleRaw).trim();
    if (!nextTitle) return;
    const titleText = nextTitle.replace(/\.(md|txt)$/i, '');
    const extMatch = normalized.match(/\.[^/.]+$/);
    const ext = extMatch ? extMatch[0] : '.md';
    const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    const slug = slugify(titleText);
    const target = dir ? `${dir}/${slug}${ext}` : `${slug}${ext}`;
    const exists = pages.some(p => p.path === target);
    if (exists && target !== normalized) {
      window.alert('A note with this name already exists.');
      return;
    }
    socket.emit('memory_rename_page', { path: normalized, new_path: target, title: titleText });
  };

  const startTitleEdit = (path) => {
    if (!path) return;
    const normalized = path.replace(/\\/g, '/');
    const currentTitle = pages.find(p => p.path === normalized)?.title || activePage?.title || 'Untitled';
    setTitleEdit({ path: normalized, value: currentTitle });
  };

  useEffect(() => {
    if (!contextMenu) return;
    const handleDismiss = () => setContextMenu(null);
    const handleKey = (e) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', handleDismiss);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('click', handleDismiss);
      window.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!slashMenu) return;
    const handleDismiss = (e) => {
      if (e.target.closest('[data-slash-menu]')) return;
      setSlashMenu(null);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setSlashMenu(null);
    };
    window.addEventListener('click', handleDismiss);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('click', handleDismiss);
      window.removeEventListener('keydown', handleKey);
    };
  }, [slashMenu]);

  useEffect(() => {
    if (!isPreview) setSlashMenu(null);
  }, [isPreview]);

  useEffect(() => {
    if (!titleEdit) return;
    requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
  }, [titleEdit?.path]);

  const toolbarButton = 'p-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-colors';
  const slashCommands = [
    { id: 'h1', label: 'Heading 1', hint: '#', action: () => applyHeading(1) },
    { id: 'h2', label: 'Heading 2', hint: '##', action: () => applyHeading(2) },
    { id: 'h3', label: 'Heading 3', hint: '###', action: () => applyHeading(3) },
    { id: 'bullet', label: 'Bulleted list', hint: '-', action: applyBulletCommand },
    { id: 'numbered', label: 'Numbered list', hint: '1.', action: applyNumberedCommand },
    { id: 'quote', label: 'Quote', hint: '>', action: toggleQuote },
  ];

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

        {!hideCategoryUI && (
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
        )}

        {showNewPage && (
          <div className="px-3 py-2 border-b border-white/10 space-y-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white/70 focus:outline-none focus:border-white/30"
              placeholder="Note title"
            />
            {!hideCategoryUI && (
              <input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white/70 focus:outline-none focus:border-white/30"
                placeholder="Category (optional)"
              />
            )}
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
                onContextMenu={(e) => openContextMenu(e, p.path)}
                className={`w-full text-left px-2 py-1.5 rounded-md transition-colors ${
                  isActive ? 'bg-white/20 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
                }`}
              >
                <div className="text-[11px] font-medium">{p.title || 'Untitled'}</div>
                {showPaths && (
                  <div className="text-[9px] text-white/35 truncate">{stripPrefix(p.path) || p.path}</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col bg-black/20">
        <div
          className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-4"
          onContextMenu={(e) => openContextMenu(e, pagePath)}
        >
          <div className="min-w-0">
            {titleEdit?.path === pagePath ? (
              <input
                ref={titleInputRef}
                value={titleEdit.value}
                onChange={(e) => setTitleEdit(prev => (prev ? { ...prev, value: e.target.value } : prev))}
                onBlur={() => {
                  if (titleEdit) renamePage(titleEdit.path, titleEdit.value);
                  setTitleEdit(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (titleEdit) renamePage(titleEdit.path, titleEdit.value);
                    setTitleEdit(null);
                  }
                  if (e.key === 'Escape') {
                    setTitleEdit(null);
                  }
                }}
                className="w-full bg-black/40 border border-white/10 rounded-md px-2 py-1 text-sm text-white/80 focus:outline-none focus:border-white/30"
              />
            ) : (
              <button
                className="text-sm font-semibold text-white truncate text-left"
                onClick={() => startTitleEdit(pagePath)}
                title="Rename note"
              >
                {activePage?.title || 'Untitled'}
              </button>
            )}
            {showPaths && (
              <div className="text-[10px] text-white/35 truncate">{stripPrefix(pagePath) || pagePath}</div>
            )}
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
            <div className="text-[10px] text-white/40 uppercase tracking-wider">
              {isPreview ? 'Live Preview' : 'Source'}
            </div>
            <button
              onClick={() => {
                setIsPreview(!isPreview);
              }}
              className={`p-1.5 rounded-lg transition-colors ${isPreview ? 'bg-white/20 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
              title={isPreview ? 'Markdown view' : 'Rich view'}
            >
              {isPreview ? <Edit2 size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div className="px-3 py-2 border-b border-white/10 bg-black/30 flex flex-wrap items-center gap-1" data-toolbar-popup>
          <button
            onClick={() => {
              wrapSelection('**', '**', { perLine: true });
            }}
            className={toolbarButton}
            title="Bold"
          >
            <Bold size={14} />
          </button>
          <button
            onClick={() => {
              wrapSelection('*', '*', { perLine: true });
            }}
            className={toolbarButton}
            title="Italic"
          >
            <Italic size={14} />
          </button>
          <button
            onClick={() => {
              applyHighlight();
            }}
            className={toolbarButton}
            title="Highlight"
          >
            <Highlighter size={14} />
          </button>

          <div className="w-px h-4 bg-white/10 mx-1" />

          <button
            onClick={() => {
              toggleBulletList();
            }}
            className={toolbarButton}
            title="Bullet list"
          >
            <List size={14} />
          </button>
          <button
            onClick={() => {
              toggleNumberedList();
            }}
            className={toolbarButton}
            title="Numbered list"
          >
            <ListOrdered size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 relative group bg-black/10 overflow-hidden">
          {isPreview ? (
            <>
              <div
                ref={overlayRef}
                className="absolute inset-0 p-5 text-[13px] leading-relaxed whitespace-pre-wrap break-words pointer-events-none overflow-y-scroll scrollbar-hide text-white/85"
                aria-hidden="true"
              >
                <MarkdownOverlay content={notesText} />
              </div>
              <textarea
                ref={textareaRef}
                value={notesText}
                onChange={handleLiveChange}
                onScroll={handleScroll}
                onKeyDown={handleLiveKeyDown}
                placeholder="Write your notes here..."
                className="absolute inset-0 w-full h-full bg-transparent p-5 text-[13px] leading-relaxed whitespace-pre-wrap break-words outline-none placeholder:text-white/20 text-transparent caret-white resize-none overflow-y-scroll custom-scrollbar selection:bg-white/20 selection:text-transparent"
                spellCheck={false}
              />
            </>
          ) : (
            <textarea
              ref={textareaRef}
              value={notesText}
              onChange={(e) => updateText(e.target.value)}
              onScroll={handleScroll}
              placeholder="Write your notes here..."
              className="absolute inset-0 w-full h-full bg-transparent p-5 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words outline-none placeholder:text-white/20 text-white/80 caret-white resize-none overflow-y-scroll custom-scrollbar"
              spellCheck={false}
            />
          )}
          <div className="absolute inset-0 pointer-events-none bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] mix-blend-overlay" />
        </div>

      </div>

      {slashMenu && typeof document !== 'undefined' && createPortal(
        <div
          data-slash-menu
          className="fixed z-[220] w-[220px] rounded-lg border border-white/10 bg-black/95 shadow-xl p-1"
          style={{ left: slashMenu.x, top: slashMenu.y }}
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-white/40">Commands</div>
          {slashCommands.map((cmd) => (
            <button
              key={cmd.id}
              className="w-full px-2 py-1.5 text-left text-[12px] text-white/80 hover:bg-white/10 rounded-md flex items-center justify-between"
              onClick={() => {
                cmd.action();
                closeSlashMenu();
              }}
            >
              <span>{cmd.label}</span>
              <span className="text-[10px] text-white/40">{cmd.hint}</span>
            </button>
          ))}
        </div>,
        document.body
      )}

      {contextMenu && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[200] min-w-[220px] rounded-lg border border-white/10 bg-black/90 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10 rounded-lg"
            onClick={() => {
              const target = contextMenu.path;
              setPagePath(target);
              requestNotes(target);
              startTitleEdit(target);
              setContextMenu(null);
            }}
          >
            Zmień nazwę
          </button>
          <button
            className="w-full px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10 rounded-lg"
            onClick={() => {
              duplicatePage(contextMenu.path);
              setContextMenu(null);
            }}
          >
            Duplikuj notatkę
          </button>
          <button
            className="w-full px-3 py-2 text-left text-[12px] text-red-200/80 hover:bg-red-500/20 rounded-lg"
            onClick={() => {
              deletePageByPath(contextMenu.path);
              setContextMenu(null);
            }}
          >
            Usuń notatkę
          </button>
          <button
            className="w-full px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10 rounded-lg"
            onClick={() => {
              revealInFileManager(contextMenu.path);
              setContextMenu(null);
            }}
          >
            Wyświetl w menedżerze plików
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};

export default NoteWorkspace;
