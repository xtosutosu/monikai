import React, { useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, X, Maximize2, Minimize2, FileText } from "lucide-react";
import TopAudioBar from "./TopAudioBar";

const MAX_FILES = 6;
const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB per file
const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // 30 MB total
const MAX_RENDER_MESSAGES = 800; // safety cap for very long conversations

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fileToAttachmentPayload(file) {
  const buf = await file.arrayBuffer();
  const b64 = bytesToBase64(new Uint8Array(buf));
  return {
    name: file.name,
    mime_type: file.type || "application/octet-stream",
    data: b64,
    size: file.size,
  };
}

function sanitizeUrl(url) {
  try {
    const u = new URL(url, window.location.origin);
    const ok = ["http:", "https:", "mailto:", "tel:"].includes(u.protocol);
    return ok ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseInlineMarkdown(text) {
  if (!text) return null;

  // Tokenize a small, safe subset:
  // - **bold**
  // - `code`
  // - [label](url)
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^\s)]+\))/g;
  const parts = [];
  let last = 0;
  let m;

  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });

    const tok = m[0];
    if (tok.startsWith("**") && tok.endsWith("**")) {
      parts.push({ type: "bold", value: tok.slice(2, -2) });
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      parts.push({ type: "code", value: tok.slice(1, -1) });
    } else if (tok.startsWith("[")) {
      const closeBracket = tok.indexOf("](");
      const label = tok.slice(1, closeBracket);
      const url = tok.slice(closeBracket + 2, -1);
      parts.push({ type: "link", label, url });
    } else {
      parts.push({ type: "text", value: tok });
    }

    last = m.index + tok.length;
  }

  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });

  return parts.map((p, idx) => {
    if (p.type === "bold") {
      return (
        <strong key={idx} className="font-semibold">
          {p.value}
        </strong>
      );
    }

    if (p.type === "code") {
      return (
        <code
          key={idx}
          className="px-1 py-0.5 rounded-md bg-black/30 border border-white/10 font-mono text-[0.95em]"
        >
          {p.value}
        </code>
      );
    }

    if (p.type === "link") {
      const safe = sanitizeUrl(p.url);
      if (!safe) return <span key={idx}>{`${p.label} (${p.url})`}</span>;
      return (
        <a
          key={idx}
          href={safe}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 text-white/90 hover:text-white"
        >
          {p.label}
        </a>
      );
    }

    return <span key={idx}>{p.value}</span>;
  });
}

function renderMarkdown(text) {
  const lines = String(text || "").split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {parseInlineMarkdown(line)}
          {i < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}

const ChatModule = ({
  messages,
  inputValue,
  setInputValue,
  handleSend,
  socket,
  isModularMode,
  activeDragElement,
  position,
  width = 720,
  height = 420,
  onMouseDown,
  zIndex = 50,
  userSpeaking,
  micAudioData,
}) => {
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const [attachments, setAttachments] = useState([]); // [{ id, file, previewUrl? }]
  const [attachError, setAttachError] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, historyExpanded]);

  useEffect(() => {
    if (!historyExpanded) return;
    const onKey = (e) => {
      if (e.key === "Escape") setHistoryExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyExpanded]);

  const isActive = isModularMode && activeDragElement === "chat";

  // VN layout tuning
  const PAD_Y = 16;
  const PAD_X = 18;
  const NAMEPLATE_H = 30;
  const INPUT_H = 110; // trochę większe na attachments
  const GAP = 12;

  const lastSpeaker = useMemo(() => {
    if (!messages?.length) return "";
    return String(messages[messages.length - 1]?.sender || "");
  }, [messages]);

  const visibleMessages = useMemo(() => {
    const list = Array.isArray(messages) ? messages : [];
    if (historyExpanded) {
      return list.slice(Math.max(0, list.length - MAX_RENDER_MESSAGES));
    }
    return list.slice(-18);
  }, [messages, historyExpanded]);

  const canSend = Boolean((inputValue || "").trim().length) || attachments.length > 0;
  const canNote = Boolean((inputValue || "").trim().length) && !attachments.length;

  const totalAttachBytes = useMemo(
    () => attachments.reduce((sum, a) => sum + (a?.file?.size || 0), 0),
    [attachments]
  );

  const addFiles = (fileList) => {
    setAttachError("");

    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    setAttachments((prev) => {
      const next = [...prev];

      for (const f of incoming) {
        if (next.length >= MAX_FILES) {
          setAttachError(`Limit załączników: max ${MAX_FILES} plików.`);
          break;
        }

        if (f.size > MAX_FILE_BYTES) {
          setAttachError(`Plik "${f.name}" jest za duży (max 12 MB).`);
          continue;
        }

        const already = next.some(
          (x) =>
            x.file &&
            x.file.name === f.name &&
            x.file.size === f.size &&
            x.file.lastModified === f.lastModified
        );
        if (already) continue;

        const isImage = (f.type || "").startsWith("image/");
        const previewUrl = isImage ? URL.createObjectURL(f) : null;

        next.push({
          id: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(16).slice(2)}`,
          file: f,
          previewUrl,
        });
      }

      const nextTotal = next.reduce((sum, a) => sum + (a?.file?.size || 0), 0);
      if (nextTotal > MAX_TOTAL_BYTES) {
        setAttachError("Łączny rozmiar załączników przekracza 30 MB.");
        // cofamy dodawanie: zostawiamy poprzedni stan
        next.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
        return prev;
      }

      return next;
    });
  };

  const removeAttachment = (id) => {
    setAttachments((prev) => {
      const item = prev.find((x) => x.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const clearAttachments = () => {
    setAttachments((prev) => {
      prev.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
      return [];
    });
    setAttachError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onPickFiles = () => fileInputRef.current?.click();

  const sendMessage = async () => {
    if (!canSend) return;

    let payloadAttachments = [];
    if (attachments.length) {
      try {
        payloadAttachments = await Promise.all(attachments.map((a) => fileToAttachmentPayload(a.file)));
      } catch {
        setAttachError("Nie udało się przygotować załączników do wysyłki.");
        return;
      }
    }

    // handleSend w App.jsx może czytać event.attachments
    handleSend({ key: "Enter", attachments: payloadAttachments });

    // UX
    clearAttachments();
    textareaRef.current?.focus();
  };

  const onKeyDown = async (e) => {
    // Enter = wyślij, Shift+Enter = nowa linia
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      await sendMessage();
    }
  };

  const onClickSend = async () => {
    await sendMessage();
  };

  const onClickNote = () => {
    if (!socket) return;
    const text = (inputValue || "").trim();
    if (!text) return;
    socket.emit("notes_append", { content: text });
    setInputValue("");
    textareaRef.current?.focus();
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // History expansion: grow UPWARDS (anchor bottom)
  const baseHeight = height;
  const expandedHeight = useMemo(() => {
    const vh = typeof window !== "undefined" ? window.innerHeight : 900;
    const maxH = Math.max(baseHeight, Math.floor(vh * 0.84));
    // keep some headroom for OS chrome; cap to avoid ridiculous windows
    return Math.min(maxH, 980);
  }, [baseHeight]);

  const effectiveHeight = historyExpanded ? expandedHeight : baseHeight;
  const baseTop = position?.y ?? 200;
  const deltaH = effectiveHeight - baseHeight;
  const topWhenExpanded = Math.max(14, baseTop - deltaH);
  const effectiveTop = historyExpanded ? topWhenExpanded : baseTop;

  return (
    <div
      id="chat"
      onDrop={onDrop}
      onDragOver={onDragOver}
      className={[
        "absolute pointer-events-auto select-none",
        "transition-all duration-200",
        "rounded-2xl",
        "backdrop-blur-xl bg-white/[0.06]",
        "border border-white/[0.14]",
        "shadow-[0_20px_80px_rgba(0,0,0,0.45)]",
        isModularMode ? (isActive ? "ring-2 ring-white/30" : "ring-1 ring-white/10") : "",
      ].join(" ")}
      style={{
        left: position?.x ?? window.innerWidth / 2,
        top: effectiveTop,
        transform: "translate(-50%, 0)",
        width,
        height: effectiveHeight,
        padding: `${PAD_Y}px ${PAD_X}px`,
        zIndex: historyExpanded ? Math.max(zIndex, 90) : zIndex,
      }}
    >
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.06] pointer-events-none mix-blend-overlay rounded-2xl" />

      <div className="relative z-10 h-full w-full flex flex-col">
        {/* Header: the only draggable area (prevents accidental drag while selecting text) */}
        <div
          className="flex items-center justify-between"
          style={{ height: NAMEPLATE_H }}
          onMouseDown={onMouseDown}
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-xl bg-black/35 border border-white/15">
            <span className="text-[11px] tracking-[0.22em] uppercase text-white/70">
              {lastSpeaker || "…"}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-[11px] text-white/35">
              {messages?.length ? `${messages.length} msgs` : "0 msgs"}
            </div>

            <button
              type="button"
              onClick={() => setHistoryExpanded((v) => !v)}
              className={[
                "px-3 py-1.5 rounded-xl",
                "border border-white/15",
                "text-[12px] tracking-[0.18em] uppercase",
                "transition-all",
                historyExpanded
                  ? "bg-white/[0.10] hover:bg-white/[0.14] text-white/85"
                  : "bg-white/[0.04] hover:bg-white/[0.08] text-white/70",
              ].join(" ")}
              title={historyExpanded ? "Zwiń historię" : "Rozwiń historię"}
            >
              <span className="inline-flex items-center gap-2">
                {historyExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                Historia
              </span>
            </button>
          </div>
        </div>

        <div style={{ height: GAP }} />

        <div
          className={[
            "relative",
            "flex-1 min-h-0",
            "rounded-2xl",
            "border border-white/[0.14]",
            "bg-black/35",
            "backdrop-blur-sm",
            "overflow-hidden",
          ].join(" ")}
        >
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-white/25 to-transparent opacity-70 pointer-events-none" />

          <div
            className={[
              "h-full w-full",
              "overflow-y-auto",
              "px-4 py-3",
              "scrollbar-thin scrollbar-thumb-white/15 scrollbar-track-white/5",
              "hover:scrollbar-thumb-white/25",
              "select-text",
            ].join(" ")}
          >
            {visibleMessages.map((msg, i) => {
              const sender = String(msg?.sender || "");
              const lower = sender.toLowerCase();
              const isUser = lower === "ty" || lower === "you";

              const age = visibleMessages.length - 1 - i;
              const opacity = Math.max(0.35, 1 - age * 0.06);

              return (
                <div key={i} className="mb-3 last:mb-0" style={{ opacity }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={[
                        "inline-flex items-center px-2.5 py-0.5 rounded-lg",
                        "border text-[11px] tracking-[0.18em] uppercase",
                        isUser
                          ? "bg-white/[0.06] border-white/[0.18] text-white/75"
                          : "bg-white/[0.04] border-white/[0.14] text-white/65",
                      ].join(" ")}
                    >
                      {sender || "…"}
                    </span>

                    {msg?.time ? (
                      <span className="text-[10px] text-white/25 font-mono">{msg.time}</span>
                    ) : null}
                  </div>

                  <div className="text-[15px] leading-relaxed text-white/88 whitespace-pre-wrap break-words select-text">
                    {renderMarkdown(msg?.text)}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_50%_35%,transparent_35%,rgba(0,0,0,0.45)_100%)]" />
        </div>

        <div style={{ height: GAP }} />

        <div
          className={[
            "rounded-2xl border border-white/[0.14]",
            "bg-black/35 backdrop-blur-sm",
            "px-4 py-3",
            "relative",
          ].join(" ")}
          style={{ minHeight: INPUT_H }}
        >
          {/* Background Visualizer - always visible when speaking */}
          {userSpeaking && (
            <div className="absolute inset-0 flex justify-center items-center py-2 pointer-events-none opacity-60">
              <TopAudioBar audioData={micAudioData} />
            </div>
          )}

          {/* Foreground Content - always visible */}
          <div className="relative z-10">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Napisz do mnie…"
              rows={2}
              className={[
                "w-full resize-none",
                "bg-transparent outline-none",
                "text-[15px] text-white/90",
                "placeholder:text-white/35",
                "leading-relaxed",
              ].join(" ")}
            />

            {/* Attachments preview */}
            {attachments.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {attachments.map((a) => {
                  const isImage = (a.file?.type || "").startsWith("image/");
                  return (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border border-white/12 bg-white/[0.05]"
                      title={`${a.file?.name} (${Math.round((a.file?.size || 0) / 1024)} KB)`}
                    >
                      {isImage && a.previewUrl ? (
                        <img
                          src={a.previewUrl}
                          alt={a.file?.name}
                          className="h-7 w-7 rounded-lg object-cover border border-white/10"
                        />
                      ) : (
                        <div className="h-7 w-7 rounded-lg bg-black/30 border border-white/10 flex items-center justify-center text-[10px] text-white/50">
                          FILE
                        </div>
                      )}
                      <div className="max-w-[240px] truncate text-[12px] text-white/75">
                        {a.file?.name}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        className="text-white/35 hover:text-white/70 transition"
                        title="Usuń"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {attachError ? <div className="mt-2 text-[11px] text-red-300/80">{attachError}</div> : null}

            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="text-[11px] text-white/35">
                Shift+Enter: Nowa linia
                {attachments.length ? (
                  <span className="ml-2 text-white/25">
                    · Załączniki: {attachments.length}/{MAX_FILES} · {Math.round(totalAttachBytes / 1024)} KB
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.txt,.md,.json,.csv,.log,.pdf"
                  onChange={(e) => addFiles(e.target.files)}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={onPickFiles}
                  className={[
                    "px-3 py-1.5 rounded-xl",
                    "border border-white/15",
                    "text-[12px] tracking-[0.18em] uppercase",
                    "transition-all",
                    "bg-white/[0.04] hover:bg-white/[0.08] text-white/70",
                  ].join(" ")}
                  title="Dodaj załącznik"
                >
                  <span className="inline-flex items-center gap-2">
                    <Paperclip size={14} />
                    Załącz
                  </span>
                </button>

                <button
                  type="button"
                  onClick={onClickSend}
                  disabled={!canSend}
                  className={[
                    "px-4 py-1.5 rounded-xl",
                    "border border-white/15",
                    "text-[12px] tracking-[0.18em] uppercase",
                    "transition-all",
                    canSend
                      ? "bg-white/[0.08] hover:bg-white/[0.12] text-white/80"
                      : "bg-white/[0.04] text-white/30 cursor-not-allowed",
                  ].join(" ")}
                  title={canSend ? "Wyślij" : "Wpisz wiadomość lub dodaj załącznik"}
                >
                  Wyślij
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatModule;
