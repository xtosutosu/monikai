import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, ClipboardList, HelpCircle, Info, PenTool, Sparkles, Check } from 'lucide-react';

const KIND_META = {
  exercise: { icon: ClipboardList, label: 'Exercise' },
  question: { icon: HelpCircle, label: 'Question' },
  info: { icon: Info, label: 'Info' },
  sketch: { icon: PenTool, label: 'Sketch' },
};

const normalizeField = (field, index) => {
  const type = String(field?.type || 'text').toLowerCase();
  const id = field?.key || field?.label || `field_${index + 1}`;
  const label = field?.label || field?.key || `Field ${index + 1}`;
  return {
    id,
    label,
    type,
    placeholder: field?.placeholder || '',
    min: typeof field?.min === 'number' ? field.min : undefined,
    max: typeof field?.max === 'number' ? field.max : undefined,
    options: Array.isArray(field?.options) ? field.options : [],
  };
};

const SessionPromptWindow = ({
  prompt,
  position,
  onClose,
  onSubmit,
  onSketchSave,
  zIndex = 70,
}) => {
  if (!prompt) return null;

  const kind = String(prompt.kind || 'exercise').toLowerCase();
  const meta = KIND_META[kind] || KIND_META.exercise;
  const promptKey = prompt._id || prompt.id || `${kind}-${prompt.title || 'prompt'}`;

  const rawFields = Array.isArray(prompt.fields) ? prompt.fields : [];
  const showForm = kind === 'exercise' || kind === 'question';
  const effectiveFields = useMemo(() => {
    if (!showForm) return [];
    if (rawFields.length) {
      return rawFields.map(normalizeField);
    }
    return [
      normalizeField(
        {
          key: 'response',
          label: 'Response',
          type: 'textarea',
          placeholder: 'Write your response here...',
        },
        0
      ),
    ];
  }, [showForm, rawFields, promptKey]);

  const notesEnabled =
    typeof prompt.notes_enabled === 'boolean' ? prompt.notes_enabled : showForm;

  const [values, setValues] = useState({});
  const [notes, setNotes] = useState('');
  const [hasSketch, setHasSketch] = useState(false);
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const initial = {};
    effectiveFields.forEach((field) => {
      if (field.type === 'scale') {
        initial[field.id] = typeof field.min === 'number' ? field.min : 0;
      } else if (field.type === 'select') {
        initial[field.id] = field.options[0] || '';
      } else {
        initial[field.id] = '';
      }
    });
    setValues(initial);
    setNotes('');
    setHasSketch(false);
  }, [promptKey, effectiveFields]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, promptKey]);

  useEffect(() => {
    if (kind !== 'sketch') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#e2e8f0';
      ctxRef.current = ctx;
      ctx.clearRect(0, 0, rect.width, rect.height);
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [kind, promptKey]);

  const updateValue = (id, value) => {
    setValues(prev => ({ ...prev, [id]: value }));
  };

  const handleSubmit = () => {
    if (!onSubmit) return;
    const payloadFields = {};
    effectiveFields.forEach((field) => {
      const val = values[field.id];
      if (val === undefined) return;
      payloadFields[field.label] = val;
    });
    onSubmit({
      exercise_id: prompt.exercise_id || promptKey,
      title: prompt.title || 'Session Prompt',
      fields: payloadFields,
      notes: notes || '',
    });
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    setHasSketch(false);
  };

  const getCanvasPoint = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const drawLine = (from, to) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const handlePointerDown = (event) => {
    if (kind !== 'sketch') return;
    drawingRef.current = true;
    const point = getCanvasPoint(event);
    lastPointRef.current = point;
    drawLine(point, point);
    setHasSketch(true);
  };

  const handlePointerMove = (event) => {
    if (!drawingRef.current || kind !== 'sketch') return;
    const point = getCanvasPoint(event);
    drawLine(lastPointRef.current, point);
    lastPointRef.current = point;
    setHasSketch(true);
  };

  const handlePointerUp = () => {
    drawingRef.current = false;
  };

  const handleSketchSave = () => {
    if (!onSketchSave || !canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/png');
    onSketchSave({
      image: dataUrl,
      label: prompt.sketch_label || prompt.title || 'session_sketch',
    });
  };

  const title = prompt.title || 'Session';
  const text = prompt.text || '';

  const anchorX = position?.x ?? window.innerWidth / 2;
  const anchorTop = position?.y ?? 220;
  const placeInside = position?.placement === 'inside';
  const maxWidth = Math.min(760, position?.width || 720);
  const top = placeInside ? anchorTop + 14 : anchorTop - 12;
  const transform = placeInside ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
  const maxHeight = Math.min(520, (position?.viewportH || window.innerHeight) * 0.65);

  const Icon = meta.icon || Sparkles;

  return (
    <div
      className="absolute pointer-events-auto"
      style={{
        left: Math.round(anchorX),
        top: Math.round(top),
        transform,
        width: maxWidth,
        zIndex,
      }}
    >
      <div className="bg-gradient-to-br from-[#111827]/90 via-black/85 to-[#0b0f1a]/90 border border-white/15 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/10 border border-white/20 flex items-center justify-center text-white/80">
              <Icon size={18} />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-white/50">Session</div>
              <div className="text-sm font-semibold text-white/90 flex items-center gap-2">
                {title}
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-200/80 border border-amber-200/20">
                  {meta.label}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-white/50 hover:text-white"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div
          className="px-4 py-4 space-y-4 overflow-y-auto custom-scrollbar"
          style={{ maxHeight }}
        >
          {text ? (
            <div className="text-sm text-white/80 whitespace-pre-wrap leading-relaxed">
              {text}
            </div>
          ) : null}

          {kind === 'info' && (
            <div className="flex items-center gap-2 text-xs text-white/50">
              <Check size={14} /> Acknowledge and continue
            </div>
          )}

          {showForm && (
            <div className="space-y-3">
              {effectiveFields.map((field) => {
                const value = values[field.id] ?? '';
                return (
                  <div key={field.id} className="space-y-1">
                    <label className="text-xs uppercase tracking-wider text-white/50">
                      {field.label}
                    </label>
                    {field.type === 'textarea' ? (
                      <textarea
                        value={value}
                        onChange={(e) => updateValue(field.id, e.target.value)}
                        placeholder={field.placeholder}
                        rows={3}
                        className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/85 placeholder:text-white/30 focus:outline-none focus:border-white/40 resize-none"
                      />
                    ) : field.type === 'scale' ? (
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] text-white/40">{field.min ?? 0}</span>
                        <input
                          type="range"
                          min={field.min ?? 0}
                          max={field.max ?? 10}
                          value={value}
                          onChange={(e) => updateValue(field.id, Number(e.target.value))}
                          className="flex-1"
                        />
                        <span className="text-[11px] text-white/40">{field.max ?? 10}</span>
                        <div className="text-xs text-white/80 w-10 text-right">{value}</div>
                      </div>
                    ) : field.type === 'select' ? (
                      <select
                        value={value}
                        onChange={(e) => updateValue(field.id, e.target.value)}
                        className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-white/40"
                      >
                        {field.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => updateValue(field.id, e.target.value)}
                        placeholder={field.placeholder}
                        className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/85 placeholder:text-white/30 focus:outline-none focus:border-white/40"
                      />
                    )}
                  </div>
                );
              })}

              {notesEnabled && (
                <div className="space-y-1">
                  <label className="text-xs uppercase tracking-wider text-white/50">
                    Notes
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    placeholder="Optional notes or reflections..."
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/85 placeholder:text-white/30 focus:outline-none focus:border-white/40 resize-none"
                  />
                </div>
              )}
            </div>
          )}

          {kind === 'sketch' && (
            <div className="space-y-3">
              <div className="text-xs text-white/50">
                Use the space below to sketch how you feel. Simple shapes are enough.
              </div>
              <div className="border border-white/10 rounded-xl bg-black/40 overflow-hidden">
                <canvas
                  ref={canvasRef}
                  className="w-full h-[220px] touch-none cursor-crosshair"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerUp}
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={clearCanvas}
                  className="px-3 py-1.5 rounded-lg border border-white/15 text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={handleSketchSave}
                  disabled={!hasSketch}
                  className={`ml-auto px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    hasSketch
                      ? 'bg-white/20 hover:bg-white/30 text-white'
                      : 'bg-white/5 text-white/30 cursor-not-allowed'
                  }`}
                >
                  Save Sketch
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-white/10 bg-white/5 flex items-center justify-end gap-2">
          {kind === 'info' ? (
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-colors"
            >
              Got it
            </button>
          ) : kind === 'sketch' ? (
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-white/15 text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            >
              Close
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg border border-white/15 text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                Later
              </button>
              <button
                onClick={handleSubmit}
                className="px-4 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white text-xs font-medium transition-colors"
              >
                Submit
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SessionPromptWindow;
