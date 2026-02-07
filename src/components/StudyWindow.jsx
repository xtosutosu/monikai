import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, X, Send, RefreshCw, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react';
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
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [pageLabels, setPageLabels] = useState(null);
  const pageLabel = pageLabels && pageLabels[page - 1] ? String(pageLabels[page - 1]) : "";
  const lastImageSentRef = useRef({ page: 0, ts: 0 });
  const lastHiResPageRef = useRef(0);
  const manualShareOnly = true;

  useEffect(() => {
    if (selection?.folder) setSelectedFolder(selection.folder);
    if (selection?.file) setSelectedFile(selection.file);
  }, [selection?.folder, selection?.file]);

  const scratchBase = useMemo(() => {
    const baseFolder = selectedFolder || 'study';
    const baseFile = (selectedFile || 'notes').replace(/\.pdf$/i, '').trim() || 'notes';
    return `study/${baseFolder}/${baseFile}`;
  }, [selectedFolder, selectedFile]);

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
      const baseFolder = selectedFolder || 'study';
      const baseFile = (selectedFile || 'notes').replace(/\.pdf$/i, '').trim() || 'notes';
      const basePath = `study/${baseFolder}/${baseFile}`;
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
  }, [socket, selectedFolder, selectedFile, scratchPath]);

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

  useEffect(() => {
    if (!activeFile?.path) return;
    const url = `http://localhost:8000/study/file?path=${encodeURIComponent(activeFile.path)}`;
    let cancelled = false;
    const task = getDocument(url);
    task.promise.then(doc => {
      if (cancelled) return;
      pdfDocRef.current = doc;
      setPageCount(doc.numPages || 0);
      lastSentRef.current = { page: 0, ts: 0 };
      setRenderEpoch(e => e + 1);
      doc.getPageLabels().then(labels => {
        if (Array.isArray(labels) && labels.length) {
          setPageLabels(labels);
        } else {
          setPageLabels(null);
        }
      }).catch(() => {
        setPageLabels(null);
      });
    }).catch(() => {
      if (!cancelled) {
        pdfDocRef.current = null;
        setPageCount(0);
      }
    });
    return () => {
      cancelled = true;
      try { task.destroy(); } catch {}
    };
  }, [activeFile?.path]);

  useEffect(() => {
    if (!viewerRef.current) return;
    const resizeObserver = new ResizeObserver(entries => {
      const width = Math.max(0, Math.floor(entries[0]?.contentRect?.width || 0));
      if (width) {
        setViewerWidth(prev => (prev === width ? prev : width));
      }
    });
    resizeObserver.observe(viewerRef.current);
    return () => resizeObserver.disconnect();
  }, [pageCount]);

  useEffect(() => {
    if (viewerWidth > 0) {
      setRenderEpoch(e => e + 1);
    }
  }, [viewerWidth]);

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
    if (!doc || !canvas || viewerWidth <= 0) return;
    const seq = renderSeqRef.current + 1;
    renderSeqRef.current = seq;
    try {
      const pageObj = await doc.getPage(pageNumber);
      const viewport = pageObj.getViewport({ scale: 1 });
      const targetWidth = Math.max(280, viewerWidth - 24);
      const scale = targetWidth / viewport.width;
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

  const hasDocument = Boolean(activeFile?.path && pageCount > 0);

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

  const sendZoomTiles = async () => {
    if (!socket || !selectedFile) return;
    const canvas = await ensureHiResPage();
    if (!canvas) return;
    const cols = 2;
    const rows = 2;
    const tileW = Math.floor(canvas.width / cols);
    const tileH = Math.floor(canvas.height / rows);
    const tiles = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const tileCanvas = document.createElement('canvas');
        tileCanvas.width = tileW;
        tileCanvas.height = tileH;
        const ctx = tileCanvas.getContext('2d');
        ctx.drawImage(
          canvas,
          c * tileW,
          r * tileH,
          tileW,
          tileH,
          0,
          0,
          tileW,
          tileH
        );
        const dataUrl = tileCanvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1] || '';
        if (base64) {
          tiles.push({ mime_type: 'image/png', data: base64 });
        }
      }
    }
    if (!tiles.length) return;
    socket.emit('study_page_tiles', {
      folder: selectedFolder,
      file: selectedFile,
      page,
      page_label: pageLabel,
      tiles,
    });
  };

  useEffect(() => {
    if (pageCount > 0 && page > pageCount) {
      setPage(1);
    }
  }, [pageCount, page]);

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
        <div className="flex flex-col border-r border-white/10 min-h-0">
          <div className="p-3 border-b border-white/10 flex items-center gap-2">
            <select
              value={selectedFolder}
              onChange={(e) => setSelectedFolder(e.target.value)}
              className="bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white/80"
            >
              {folders.map(f => (
                <option key={f.name} value={f.name}>{f.name}</option>
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
            >
              {visibleFiles.map(f => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
            <div className="ml-2 flex items-center gap-1">
              <button
                onClick={shareWithMonika}
                className="px-2 py-1 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100"
                title="Share with Monika (hi-res + OCR)"
              >
                <Send size={12} />
              </button>
              <button
                onClick={sendZoomTiles}
                className="px-1.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70"
                title="Send zoomed tiles to Monika"
              >
                <ZoomIn size={12} />
              </button>
              <button
                onClick={() => changePage(page - 1)}
                disabled={page <= 1}
                className="px-1.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-30 disabled:hover:bg-white/5"
                title="Previous page"
              >
                <ChevronLeft size={12} />
              </button>
              <button
                onClick={() => changePage(page + 1)}
                disabled={pageCount > 0 ? page >= pageCount : false}
                className="px-1.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-30 disabled:hover:bg-white/5"
                title="Next page"
              >
                <ChevronRight size={12} />
              </button>
              <div className="ml-2 text-[11px] text-white/50">
                {pageCount > 0 ? `Page ${page} / ${pageCount}` : `Page ${page}`}
                {pageLabel ? ` • Book ${pageLabel}` : ''}
              </div>
            </div>
          </div>
          <div className="flex-1 min-h-0 bg-black/60">
            {hasDocument ? (
              <div
                ref={viewerRef}
                className="w-full h-full overflow-hidden p-4 flex items-start justify-center"
              >
                <canvas
                  ref={pageCanvasRef}
                  className="bg-white shadow-[0_8px_24px_rgba(0,0,0,0.45)] rounded"
                />
              </div>
            ) : (
              <div className="h-full w-full flex items-center justify-center text-white/40 text-sm">
                No PDF selected.
              </div>
            )}
          </div>
        </div>

        {/* Notes + Answers */}
        <div className="flex flex-col min-h-0">
          <div className="p-3 border-b border-white/10">
            <div className="text-xs text-white/50 uppercase tracking-wider">Workspace</div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 custom-scrollbar">
            <div className="min-h-[360px] h-full">
              <NoteWorkspace
                socket={socket}
                defaultPath={defaultScratchPath}
                basePath={scratchBase}
                filterPrefix={scratchBase}
                pageLabel={pageLabel || String(page)}
                onContentChange={handleScratchChange}
                compact
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
