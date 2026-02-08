import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, X, Send, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import NoteWorkspace from './NoteWorkspace';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = workerSrc;

const StudyWindow = ({
  socket,
  onClose,
  position,
  width = 980,
  height = 720,
  onMouseDown,
  zIndex = 60,
  activeDragElement,
  catalog,
  selection,
  onSelectStudy,
  onRefreshCatalog,
  shareRef,
}) => {
  const [selectedFolder, setSelectedFolder] = useState(selection?.folder || '');
  const [selectedFile, setSelectedFile] = useState(selection?.file || '');
  const [fields, setFields] = useState([]);
  const [page, setPage] = useState(1);
  const [fieldsTitle, setFieldsTitle] = useState('');
  const suppressEmitRef = useRef(false);
  const viewerRef = useRef(null);
  const pageCanvasRef = useRef(null);
  const aiCanvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const pdfDocRef = useRef(null);
  const lastSentRef = useRef({ page: 0, ts: 0 });
  const pageTextCacheRef = useRef({});
  const renderSeqRef = useRef(0);
  const lastRenderedPageRef = useRef(0);
  const syncTimerRef = useRef(null);
  const [pageCount, setPageCount] = useState(0);
  const [scratchText, setScratchText] = useState("");
  const [scratchPath, setScratchPath] = useState("");
  const [viewerWidth, setViewerWidth] = useState(0);
  const [viewerHeight, setViewerHeight] = useState(0);
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [pageLabels, setPageLabels] = useState(null);
  const [outlineItems, setOutlineItems] = useState([]);
  const [chapterJump, setChapterJump] = useState('');
  const [pageInput, setPageInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [shareNotice, setShareNotice] = useState('');
  const [showSpinner, setShowSpinner] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const pageLabel = pageLabels && pageLabels[page - 1] ? String(pageLabels[page - 1]) : "";
  const lastImageSentRef = useRef({ page: 0, ts: 0 });
  const lastHiResPageRef = useRef(0);
  const manualShareOnly = true;
  const docLoadTaskRef = useRef(null);
  const shareNoticeTimerRef = useRef(null);
  const spinnerTimerRef = useRef(null);
  const spinnerStartRef = useRef(0);
  const panStateRef = useRef({ active: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });

  useEffect(() => {
    if (selection?.folder) setSelectedFolder(selection.folder);
    if (selection?.file) setSelectedFile(selection.file);
  }, [selection?.folder, selection?.file]);

  const scratchBase = useMemo(() => 'study/shared', []);

  const defaultScratchPath = `${scratchBase}/scratchpad.md`;

  useEffect(() => {
    if (!socket) return;
    const onFields = (payload) => {
      const incoming = Array.isArray(payload?.fields) ? payload.fields : [];
      setFieldsTitle(String(payload?.title || ''));
      const mapped = incoming.map((f, idx) => ({
        id: f.key || `f_${idx}_${Date.now()}`,
        key: f.key || `field_${idx + 1}`,
        label: f.label || f.key || `Field ${idx + 1}`,
        type: (f.type === 'textarea') ? 'textarea' : 'text',
        placeholder: f.placeholder || '',
        value: f.value || '',
      }));
      setFields(mapped);
    };
    socket.on('study_fields', onFields);
    return () => socket.off('study_fields', onFields);
  }, [socket]);

  useEffect(() => {
    if (!socket) return;
    const onNotes = (payload) => {
      const text = String(payload?.text || "");
      const mode = payload?.mode === "append" ? "append" : "replace";
      const idxRaw = payload?.page_index;
      const targetIndex = Number.isFinite(idxRaw) ? Math.max(0, Number(idxRaw)) : null;
      const basePath = scratchBase || 'study/shared';
      const targetPath = targetIndex !== null
        ? `${basePath}/page-${targetIndex + 1}.md`
        : (scratchPath || `${basePath}/scratchpad.md`);

      if (targetIndex !== null) {
        setScratchPath(targetPath);
      }

      if (mode === "append") {
        socket.emit('memory_append_page', { path: targetPath, content: text });
      } else {
        socket.emit('memory_set_page', { path: targetPath, content: text });
      }
      socket.emit('memory_get_page', { path: targetPath });
      socket.emit('memory_list_pages');
    };
    socket.on('study_notes', onNotes);
    return () => socket.off('study_notes', onNotes);
  }, [socket, scratchBase, scratchPath]);

  useEffect(() => {
    if (!socket) return;
    const onPage = (payload) => {
      const next = Number(payload?.page || 1);
      if (Number.isFinite(next) && next > 0) {
        suppressEmitRef.current = true;
        setPage(next);
      }
    };
    socket.on('study_page', onPage);
    return () => socket.off('study_page', onPage);
  }, [socket]);

  const folders = Array.isArray(catalog?.folders) ? catalog.folders : [];
  const activeFolder = folders.find(f => f.name === selectedFolder) || folders[0];
  const visibleFiles = activeFolder
    ? (activeFolder.files || []).filter(f => !f.is_answer_key)
    : [];

  useEffect(() => {
    if (!selectedFolder && activeFolder) {
      setSelectedFolder(activeFolder.name);
    }
  }, [activeFolder, selectedFolder]);

  const activeFile = useMemo(() => {
    if (!activeFolder) return null;
    const exact = (activeFolder.files || []).find(f => f.name === selectedFile);
    if (exact && !exact.is_answer_key) return exact;
    return visibleFiles[0] || null;
  }, [activeFolder, selectedFile, visibleFiles]);

  useEffect(() => {
    if (activeFile && (activeFile.name !== selectedFile || activeFolder?.name !== selectedFolder)) {
      const folderName = activeFolder?.name || selectedFolder || '';
      setSelectedFolder(folderName);
      setSelectedFile(activeFile.name);
      setPage(1);
      setPageCount(0);
      pdfDocRef.current = null;
      setPageLabels(null);
      setOutlineItems([]);
      setLoadError('');
      setZoom(1);
      pageTextCacheRef.current = {};
      if (onSelectStudy) {
        onSelectStudy({
          folder: folderName,
          file: activeFile.name,
          path: activeFile.path,
        });
      }
    }
  }, [activeFile, selectedFile, activeFolder, selectedFolder, onSelectStudy]);

  const buildOutlineItems = useCallback(async (doc) => {
    if (!doc?.getOutline) return [];
    try {
      const outline = await doc.getOutline();
      if (!Array.isArray(outline) || outline.length === 0) return [];
      const items = [];
      const walk = async (nodes, depth = 0) => {
        for (const node of nodes) {
          const titleRaw = String(node?.title || '').trim();
          let pageIndex = null;
          try {
            let dest = node?.dest;
            if (typeof dest === 'string') {
              dest = await doc.getDestination(dest);
            }
            if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
              if (typeof dest[0] === 'number') {
                pageIndex = dest[0];
              } else {
                pageIndex = await doc.getPageIndex(dest[0]);
              }
            }
          } catch {
            pageIndex = null;
          }
          if (Number.isFinite(pageIndex)) {
            const indent = depth > 0 ? `${'-'.repeat(Math.min(depth, 3))} ` : '';
            items.push({
              title: `${indent}${titleRaw || `Section ${pageIndex + 1}`}`.trim(),
              page: pageIndex + 1,
            });
          }
          if (Array.isArray(node?.items) && node.items.length) {
            await walk(node.items, depth + 1);
          }
        }
      };
      await walk(outline, 0);
      return items;
    } catch {
      return [];
    }
  }, []);

  const startSpinner = () => {
    spinnerStartRef.current = Date.now();
    if (spinnerTimerRef.current) {
      clearTimeout(spinnerTimerRef.current);
      spinnerTimerRef.current = null;
    }
    setShowSpinner(true);
  };

  const stopSpinner = () => {
    const elapsed = Date.now() - spinnerStartRef.current;
    const minMs = 420;
    const delay = elapsed < minMs ? (minMs - elapsed) : 0;
    if (spinnerTimerRef.current) {
      clearTimeout(spinnerTimerRef.current);
    }
    spinnerTimerRef.current = setTimeout(() => {
      setShowSpinner(false);
      spinnerTimerRef.current = null;
    }, delay);
  };

  useEffect(() => {
    if (!activeFile?.path) {
      setIsLoading(false);
      setLoadError('');
      if (spinnerTimerRef.current) {
        clearTimeout(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
      setShowSpinner(false);
      return;
    }
    setIsLoading(true);
    setLoadError('');
    startSpinner();
    const backendBase = import.meta.env?.DEV ? '' : 'http://localhost:8000';
    const url = `${backendBase}/study/file?path=${encodeURIComponent(activeFile.path)}`;
    let cancelled = false;
    const loadFromDoc = (doc) => {
      if (cancelled) return;
      pdfDocRef.current = doc;
      setPageCount(doc.numPages || 0);
      lastSentRef.current = { page: 0, ts: 0 };
      setRenderEpoch(e => e + 1);
      setIsLoading(false);
      stopSpinner();
      doc.getPageLabels().then(labels => {
        if (Array.isArray(labels) && labels.length) {
          setPageLabels(labels);
        } else {
          setPageLabels(null);
        }
      }).catch(() => {
        setPageLabels(null);
      });
      buildOutlineItems(doc).then(items => {
        if (!cancelled) setOutlineItems(items);
      }).catch(() => {
        if (!cancelled) setOutlineItems([]);
      });
    };

    const task = getDocument({
      url,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
    });
    docLoadTaskRef.current = task;
    task.promise.then(doc => {
      loadFromDoc(doc);
    }).catch(async () => {
      if (cancelled) return;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        const task2 = getDocument({ data: new Uint8Array(buffer) });
        docLoadTaskRef.current = task2;
        const doc = await task2.promise;
        loadFromDoc(doc);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load PDF', err);
          pdfDocRef.current = null;
          setPageCount(0);
          setOutlineItems([]);
          setIsLoading(false);
          stopSpinner();
          setLoadError(err?.message || 'Failed to load PDF');
        }
      }
    });
    return () => {
      cancelled = true;
      try { docLoadTaskRef.current?.destroy?.(); } catch {}
    };
  }, [activeFile?.path, buildOutlineItems]);

  useEffect(() => {
    if (!viewerRef.current) return;
    const resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      const width = Math.max(0, Math.floor(rect?.width || 0));
      const height = Math.max(0, Math.floor(rect?.height || 0));
      if (width) setViewerWidth(prev => (prev === width ? prev : width));
      if (height) setViewerHeight(prev => (prev === height ? prev : height));
    });
    resizeObserver.observe(viewerRef.current);
    return () => resizeObserver.disconnect();
  }, [pageCount]);

  useEffect(() => {
    if (viewerWidth > 0 && viewerHeight > 0) {
      setRenderEpoch(e => e + 1);
    }
  }, [viewerWidth, viewerHeight]);

  useEffect(() => {
    setRenderEpoch(e => e + 1);
  }, [zoom]);

  useEffect(() => {
    if (zoom <= 1 && viewerRef.current) {
      viewerRef.current.scrollLeft = 0;
      viewerRef.current.scrollTop = 0;
    }
  }, [zoom]);

  const emitStudyPageUser = useCallback((pageNumber) => {
    if (!socket || !activeFile?.path || pageNumber <= 0) return;
    const now = Date.now();
    if (lastSentRef.current.page === pageNumber && now - lastSentRef.current.ts < 1500) {
      return;
    }
    lastSentRef.current = { page: pageNumber, ts: now };
    const cached = pageTextCacheRef.current[pageNumber];
    if (cached) {
      socket.emit('study_page_user', {
        folder: selectedFolder,
        file: selectedFile,
        page: pageNumber,
        page_label: pageLabels && pageLabels[pageNumber - 1] ? String(pageLabels[pageNumber - 1]) : "",
        text: cached
      });
      return;
    }
    const doc = pdfDocRef.current;
    if (!doc) {
      socket.emit('study_page_user', {
        folder: selectedFolder,
        file: selectedFile,
        page: pageNumber,
        page_label: pageLabels && pageLabels[pageNumber - 1] ? String(pageLabels[pageNumber - 1]) : ""
      });
      return;
    }
    doc.getPage(pageNumber).then(pg => pg.getTextContent()).then(content => {
      const text = (content?.items || []).map(it => it.str).join(" ");
      const cleaned = text.replace(/\s+/g, " ").trim();
      const clipped = cleaned.length > 2000 ? cleaned.slice(0, 2000) : cleaned;
      pageTextCacheRef.current[pageNumber] = clipped;
      socket.emit('study_page_user', {
        folder: selectedFolder,
        file: selectedFile,
        page: pageNumber,
        page_label: pageLabels && pageLabels[pageNumber - 1] ? String(pageLabels[pageNumber - 1]) : "",
        text: clipped
      });
    }).catch(() => {
      socket.emit('study_page_user', {
        folder: selectedFolder,
        file: selectedFile,
        page: pageNumber,
        page_label: pageLabels && pageLabels[pageNumber - 1] ? String(pageLabels[pageNumber - 1]) : ""
      });
    });
  }, [socket, activeFile?.path, selectedFolder, selectedFile, pageLabels]);

  const emitStudyPageImage = useCallback((pageNumber) => {
    if (!socket || !selectedFile) return;
    const canvas = pageCanvasRef.current;
    if (!canvas || lastRenderedPageRef.current !== pageNumber) return;
    const now = Date.now();
    const last = lastImageSentRef.current;
    if (last.page === pageNumber && (now - last.ts) < 1200) return;
    lastImageSentRef.current = { page: pageNumber, ts: now };
    const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) return;
    const labelForPage = pageLabels && pageLabels[pageNumber - 1]
      ? String(pageLabels[pageNumber - 1])
      : "";
    socket.emit('study_page_image', {
      folder: selectedFolder,
      file: selectedFile,
      page: pageNumber,
      page_label: labelForPage,
      mime_type: 'image/jpeg',
      data: base64
    });
  }, [socket, selectedFolder, selectedFile, pageLabels]);

  const scheduleStudySync = useCallback((pageNumber) => {
    if (!socket || !selectedFile) return;
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = setTimeout(() => {
      const shouldSendText = !suppressEmitRef.current;
      if (suppressEmitRef.current) {
        suppressEmitRef.current = false;
      }
      emitStudyPageImage(pageNumber);
      if (shouldSendText) {
        emitStudyPageUser(pageNumber);
      }
    }, 450);
  }, [socket, selectedFile, emitStudyPageImage, emitStudyPageUser]);

  const renderPage = useCallback(async (pageNumber) => {
    const doc = pdfDocRef.current;
    const canvas = pageCanvasRef.current;
    if (!doc || !canvas || viewerWidth <= 0 || viewerHeight <= 0) return;
    const seq = renderSeqRef.current + 1;
    renderSeqRef.current = seq;
    try {
      const pageObj = await doc.getPage(pageNumber);
      const viewport = pageObj.getViewport({ scale: 1 });
      const targetWidth = Math.max(280, viewerWidth - 24);
      const targetHeight = Math.max(240, viewerHeight - 24);
      const baseScale = Math.min(targetWidth / viewport.width, targetHeight / viewport.height);
      const scale = baseScale * zoom;
      const scaled = pageObj.getViewport({ scale });
      const context = canvas.getContext('2d');
      canvas.width = Math.floor(scaled.width);
      canvas.height = Math.floor(scaled.height);
      canvas.style.width = `${Math.floor(scaled.width)}px`;
      canvas.style.height = `${Math.floor(scaled.height)}px`;
      if (renderTaskRef.current?.cancel) {
        try { renderTaskRef.current.cancel(); } catch {}
      }
      const task = pageObj.render({ canvasContext: context, viewport: scaled });
      renderTaskRef.current = task;
      await task.promise;
      if (seq !== renderSeqRef.current) return;
      if (pageNumber !== page) return;
      lastRenderedPageRef.current = pageNumber;
      if (!manualShareOnly) {
        scheduleStudySync(pageNumber);
      }
    } catch {
      // ignore render errors (e.g., rapid page changes)
    }
  }, [viewerWidth, renderEpoch, page, scheduleStudySync, manualShareOnly]);

  useEffect(() => {
    if (!socket) return;
    const onConnect = () => {
      if (page > 0 && selectedFile) {
        renderPage(page);
        if (!manualShareOnly) {
          socket.emit('study_page_user', {
            folder: selectedFolder,
            file: selectedFile,
            page,
            page_label: pageLabel,
            text: pageTextCacheRef.current[page] || ''
          });
        }
      }
    };
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [socket, page, selectedFolder, selectedFile, pageLabel, renderPage, manualShareOnly]);

  useEffect(() => {
    if (!pageCount || viewerWidth <= 0) return;
    const current = Math.min(pageCount, Math.max(1, page));
    renderPage(current);
  }, [page, pageCount, viewerWidth, renderEpoch, renderPage]);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, []);

  const hasDocument = Boolean(activeFile?.path && pageCount > 0 && !loadError);

  const clampZoom = (val) => Math.max(0.6, Math.min(val, 2.4));
  const handleWheelZoom = (e) => {
    if (!hasDocument) return;
    e.preventDefault();
    e.stopPropagation();
    const direction = e.deltaY > 0 ? -1 : 1;
    setZoom(prev => clampZoom(prev * (direction > 0 ? 1.08 : 0.92)));
  };

  const handlePanStart = (e) => {
    if (!hasDocument || zoom <= 1) return;
    if (e.button !== 0) return;
    const el = viewerRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    panStateRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    setIsPanning(true);
  };

  const handlePanMove = (e) => {
    if (!panStateRef.current.active) return;
    const el = viewerRef.current;
    if (!el) return;
    const dx = e.clientX - panStateRef.current.startX;
    const dy = e.clientY - panStateRef.current.startY;
    el.scrollLeft = panStateRef.current.scrollLeft - dx;
    el.scrollTop = panStateRef.current.scrollTop - dy;
  };

  const handlePanEnd = () => {
    if (!panStateRef.current.active) return;
    panStateRef.current.active = false;
    setIsPanning(false);
  };

  useEffect(() => {
    if (!isPanning) return;
    window.addEventListener('mousemove', handlePanMove);
    window.addEventListener('mouseup', handlePanEnd);
    window.addEventListener('mouseleave', handlePanEnd);
    return () => {
      window.removeEventListener('mousemove', handlePanMove);
      window.removeEventListener('mouseup', handlePanEnd);
      window.removeEventListener('mouseleave', handlePanEnd);
    };
  }, [isPanning]);

  const prettifyTitle = (name) => {
    const base = String(name || '')
      .replace(/\.pdf$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return base
      .replace(/\s+-\s+(\d+(st|nd|rd|th)\s+Edition)$/i, ' ($1)')
      .replace(/\s+Answer\s+Key$/i, ' (Answer Key)');
  };

  const updateField = (id, value) => {
    setFields(prev => prev.map(f => (f.id === id ? { ...f, value } : f)));
  };

  const submitAnswers = () => {
    if (!socket) return;
    const payload = {
      folder: selectedFolder,
      file: selectedFile,
      fields: fields.reduce((acc, f) => {
        acc[f.label || f.key] = f.value || '';
        return acc;
      }, {}),
      notes: (scratchText || '').trim(),
    };
    socket.emit('study_answers_submit', payload);
  };

  const handleScratchChange = (payload) => {
    setScratchText(payload.text || '');
    if (payload.path) {
      setScratchPath(payload.path);
    }
  };

  const changePage = (nextPage) => {
    if (!pageCount) return;
    const clamped = Math.min(pageCount, Math.max(1, Number(nextPage) || 1));
    setPage(clamped);
  };

  const resolvePageInput = (raw) => {
    const value = String(raw || '').trim();
    if (!value) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    if (Array.isArray(pageLabels) && pageLabels.length) {
      const idx = pageLabels.findIndex(label => String(label).toLowerCase() === value.toLowerCase());
      if (idx >= 0) return idx + 1;
    }
    return null;
  };

  const applyPageInput = () => {
    const target = resolvePageInput(pageInput);
    if (!target) return;
    changePage(target);
    setPageInput('');
  };

  const ensureHiResPage = async (targetWidthOverride) => {
    const doc = pdfDocRef.current;
    if (!doc) return null;
    let canvas = aiCanvasRef.current;
    if (!canvas || lastHiResPageRef.current !== page) {
      const pageObj = await doc.getPage(page);
      const viewport = pageObj.getViewport({ scale: 1 });
      const baseWidth = Math.max(1600, Math.min(3000, viewerWidth * 3.2));
      const aiTargetWidth = targetWidthOverride || baseWidth;
      const aiScale = aiTargetWidth / viewport.width;
      const aiViewport = pageObj.getViewport({ scale: aiScale });
      canvas = aiCanvasRef.current || document.createElement('canvas');
      aiCanvasRef.current = canvas;
      const ctx = canvas.getContext('2d');
      canvas.width = Math.floor(aiViewport.width);
      canvas.height = Math.floor(aiViewport.height);
      await pageObj.render({ canvasContext: ctx, viewport: aiViewport }).promise;
      lastHiResPageRef.current = page;
    }
    return canvas;
  };

  const shareWithMonika = async () => {
    if (!socket || !selectedFile) return;
    try {
      if (shareNoticeTimerRef.current) {
        clearTimeout(shareNoticeTimerRef.current);
        shareNoticeTimerRef.current = null;
      }
      setShareNotice('Let me review this page');
      shareNoticeTimerRef.current = setTimeout(() => {
        setShareNotice('');
        shareNoticeTimerRef.current = null;
      }, 2200);
      const canvas = await ensureHiResPage(Math.max(2200, Math.min(3800, viewerWidth * 4.0)));
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      const base64 = dataUrl.split(',')[1] || '';
      if (!base64) return;
      socket.emit('study_page_share', {
        folder: selectedFolder,
        file: selectedFile,
        page,
        page_label: pageLabel,
        mime_type: 'image/jpeg',
        data: base64,
      });
      // Zoom tiles are optional; use the Zoom button if needed.
    } catch {
      // ignore share failures
    }
  };

  useEffect(() => {
    if (pageCount > 0 && page > pageCount) {
      setPage(1);
    }
  }, [pageCount, page]);

  useEffect(() => {
    return () => {
      if (shareNoticeTimerRef.current) {
        clearTimeout(shareNoticeTimerRef.current);
        shareNoticeTimerRef.current = null;
      }
      if (spinnerTimerRef.current) {
        clearTimeout(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!shareRef) return;
    shareRef.current = shareWithMonika;
    return () => {
      if (shareRef.current === shareWithMonika) {
        shareRef.current = null;
      }
    };
  }, [shareRef, shareWithMonika]);

  const refreshCatalog = () => {
    if (onRefreshCatalog) onRefreshCatalog();
  };

  return (
    <div
      id="study"
      className={`absolute flex flex-col bg-black/85 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden transition-shadow duration-300 ${
        activeDragElement === 'study' ? 'shadow-[0_0_30px_rgba(255,255,255,0.15)] border-white/30' : ''
      }`}
      style={{
        width,
        height,
        left: position?.x ?? 420,
        top: position?.y ?? window.innerHeight / 2,
        transform: 'translate(-50%, -50%)',
        zIndex,
      }}
      onMouseDown={onMouseDown}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/5 handle cursor-grab active:cursor-grabbing" data-drag-handle>
        <div className="flex items-center gap-2 text-white/90 font-medium">
          <BookOpen size={16} className="text-cyan-300" />
          <span>Japanese Study</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshCatalog}
            className="p-1 hover:bg-white/10 rounded-lg transition-colors text-white/50 hover:text-white"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-lg transition-colors text-white/50 hover:text-white">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[0.95fr_1.05fr] gap-0 flex-1 min-h-0">
        {/* PDF Viewer */}
        <div className="flex flex-col border-r border-white/10 min-h-0 min-w-0">
          <div className="flex-1 min-h-0 bg-black/60 relative group min-w-0 overflow-hidden">
            <div className="absolute top-3 left-3 right-3 z-10 flex items-center gap-2 px-2 py-2 rounded-lg bg-black/70 border border-white/10 opacity-0 pointer-events-none transition-opacity duration-200 group-hover:opacity-100 group-hover:pointer-events-auto">
              <select
                value={selectedFolder}
                onChange={(e) => setSelectedFolder(e.target.value)}
                className="bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white/80"
              >
                {folders.map(f => (
                  <option key={f.name} value={f.name}>{prettifyTitle(f.name)}</option>
                ))}
              </select>
              <select
                value={selectedFile}
                onChange={(e) => {
                  const name = e.target.value;
                  setSelectedFile(name);
                  const f = visibleFiles.find(v => v.name === name);
                  if (f && onSelectStudy) {
                    onSelectStudy({ folder: selectedFolder, file: f.name, path: f.path });
                  }
                }}
                className="bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white/80 flex-1"
                title={selectedFile}
              >
                {visibleFiles.map(f => (
                  <option key={f.name} value={f.name}>{prettifyTitle(f.name)}</option>
                ))}
              </select>
              {outlineItems.length > 0 && (
                <select
                  value={chapterJump}
                  onChange={(e) => {
                    const target = Number(e.target.value);
                    if (Number.isFinite(target) && target > 0) {
                      changePage(target);
                    }
                    setChapterJump('');
                  }}
                  className="bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white/80 max-w-[180px]"
                  title="Chapters"
                >
                  <option value="">Chapters</option>
                  {outlineItems.map((item, idx) => (
                    <option key={`${item.page}-${idx}`} value={item.page}>
                      {item.title} · p. {item.page}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {hasDocument ? (
              <div
                ref={viewerRef}
                className={[
                  "w-full h-full overflow-auto p-2 flex items-center justify-center relative scrollbar-hide",
                  zoom > 1 ? (isPanning ? "cursor-grabbing" : "cursor-grab") : "cursor-default"
                ].join(" ")}
                onMouseDown={handlePanStart}
              >
                <canvas
                  ref={pageCanvasRef}
                  className="bg-white shadow-[0_8px_24px_rgba(0,0,0,0.45)] rounded"
                  onWheel={handleWheelZoom}
                />
                {shareNotice ? (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/70 border border-white/15 text-xs text-white/85 shadow-lg">
                    {shareNotice}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="h-full w-full flex items-center justify-center text-white/40 text-sm">
                {loadError ? 'Failed to load PDF.' : (isLoading && activeFile?.path ? 'Loading PDF…' : 'No PDF selected.')}
              </div>
            )}
            {hasDocument && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 px-3 py-2 rounded-full bg-black/70 border border-white/15 flex items-center gap-2 text-[11px] text-white/80 shadow-lg">
                <button
                  onClick={() => changePage(page - 1)}
                  disabled={page <= 1}
                  className="px-1.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-30 disabled:hover:bg-white/5"
                  title="Previous page"
                >
                  <ChevronLeft size={12} />
                </button>
                <input
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyPageInput();
                    }
                  }}
                  onBlur={() => applyPageInput()}
                  placeholder="Go to"
                  className="w-16 bg-black/40 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white/80"
                  title="Go to page (number or label)"
                />
                <button
                  onClick={() => changePage(page + 1)}
                  disabled={pageCount > 0 ? page >= pageCount : false}
                  className="px-1.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-30 disabled:hover:bg-white/5"
                  title="Next page"
                >
                  <ChevronRight size={12} />
                </button>
                <div className="ml-1 text-[11px] text-white/50">
                  {pageCount > 0 ? `Page ${page} / ${pageCount}` : `Page ${page}`}
                  {pageLabel ? ` • Book ${pageLabel}` : ''}
                </div>
                <button
                  onClick={() => setZoom(1)}
                  className={`ml-2 px-2 py-1 rounded-md text-[10px] ${
                    zoom === 1
                      ? "bg-white/5 text-white/45"
                      : "bg-white/10 hover:bg-white/15 text-white/75"
                  }`}
                  title="Reset zoom to 100%"
                >
                  {Math.round(zoom * 100)}%
                </button>
              </div>
            )}
            {showSpinner ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
                <div className="w-10 h-10 rounded-full border-2 border-white/20 border-t-white/80 animate-spin" />
              </div>
            ) : null}
          </div>
        </div>

        {/* Notes + Answers */}
        <div className="flex flex-col min-h-0 min-w-0">
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 custom-scrollbar">
            <div className="min-h-[360px] h-full">
              <NoteWorkspace
                socket={socket}
                defaultPath={defaultScratchPath}
                basePath={scratchBase}
                filterPrefix={scratchBase}
                onContentChange={handleScratchChange}
                compact
                hideCategories
                hidePaths
              />
            </div>

            {fields.length > 0 && (
              <div className="pt-1">
                <div className="text-[11px] text-white/60 mb-2 uppercase tracking-wider">
                  {fieldsTitle ? fieldsTitle : 'Tasks / Answers'}
                </div>
                <div className="space-y-3">
                  {fields.map(f => (
                    <div key={f.id} className="flex flex-col gap-1">
                      <label className="text-[11px] text-white/60">{f.label}</label>
                      {f.type === 'textarea' ? (
                        <textarea
                          value={f.value}
                          onChange={(e) => updateField(f.id, e.target.value)}
                          placeholder={f.placeholder}
                          className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-2 text-xs text-white/80 min-h-[64px]"
                        />
                      ) : (
                        <input
                          value={f.value}
                          onChange={(e) => updateField(f.id, e.target.value)}
                          placeholder={f.placeholder}
                          className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/80"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {fields.length > 0 && (
            <div className="p-3 border-t border-white/10">
              <button
                onClick={submitAnswers}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-white/15 hover:bg-white/25 text-white/90 rounded-lg text-sm"
              >
                <Send size={14} /> Submit answers to Monika
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StudyWindow;
