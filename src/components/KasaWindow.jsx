import React, { useEffect, useRef, useState } from 'react';
import { X, RefreshCw, Power, Sun, Palette } from 'lucide-react';

const KasaWindow = ({
    socket,
    onClose,
    devices,
}) => {
    const [isThinking, setIsThinking] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [loadingDevices, setLoadingDevices] = useState({}); // { ip: true/false }
    const [uiValues, setUiValues] = useState({}); // { ip: { brightness, hue } }
    const uiValuesRef = useRef(uiValues);
    const draggingRef = useRef({}); // { ip: { brightness: bool, hue: bool } }
    const brightnessTimersRef = useRef({});
    const colorTimersRef = useRef({});

    useEffect(() => {
        uiValuesRef.current = uiValues;
    }, [uiValues]);

    const listTimeoutRef = useRef(null);

    const requestList = () => {
        if (!socket) return;
        setIsLoading(true);
        socket.emit('list_kasa');
        if (listTimeoutRef.current) clearTimeout(listTimeoutRef.current);
        listTimeoutRef.current = setTimeout(() => setIsLoading(false), 1500);
    };

    useEffect(() => {
        // Listen for individual updates to clear loading state
        const onUpdate = (data) => {
            if (data && data.ip) {
                setLoadingDevices(prev => {
                    const next = { ...prev };
                    delete next[data.ip];
                    return next;
                });
            }
        };

        const onDevices = () => {
            setIsLoading(false);
            setIsThinking(false);
            if (listTimeoutRef.current) {
                clearTimeout(listTimeoutRef.current);
                listTimeoutRef.current = null;
            }
        };

        socket.on('kasa_update', onUpdate);
        socket.on('kasa_devices', onDevices);
        return () => {
            socket.off('kasa_update', onUpdate);
            socket.off('kasa_devices', onDevices);
            if (listTimeoutRef.current) clearTimeout(listTimeoutRef.current);
        };
    }, [socket]);


    const handleDiscover = () => {
        setIsThinking(true);
        socket.emit('discover_kasa');
        // Reset thinking after 5s if no response (safety)
        setTimeout(() => setIsThinking(false), 5000);
    };

    useEffect(() => {
        if (devices && devices.length > 0) {
            setIsThinking(false);
        }
    }, [devices]);

    useEffect(() => {
        if (!socket) return;
        requestList();
    }, [socket]);

    useEffect(() => {
        // Sync device values into UI state (unless user is dragging)
        setUiValues(prev => {
            const next = { ...prev };
            for (const dev of devices || []) {
                if (!next[dev.ip]) next[dev.ip] = {};
                const drag = draggingRef.current[dev.ip] || {};
                if (!drag.brightness && typeof dev.brightness === 'number') {
                    next[dev.ip] = { ...next[dev.ip], brightness: dev.brightness };
                }
                if (!drag.hue && dev.hsv && typeof dev.hsv.h === 'number') {
                    next[dev.ip] = { ...next[dev.ip], hue: dev.hsv.h };
                }
            }
            return next;
        });
    }, [devices]);

    useEffect(() => {
        return () => {
            // Cleanup any pending debounced sends
            Object.values(brightnessTimersRef.current).forEach(t => clearTimeout(t));
            Object.values(colorTimersRef.current).forEach(t => clearTimeout(t));
        };
    }, []);

    const handleToggle = (ip, currentState) => {
        setLoadingDevices(prev => ({ ...prev, [ip]: true }));
        socket.emit('control_kasa', {
            ip: ip,
            action: currentState ? 'off' : 'on'
        });
    };


    const handleBrightness = (ip, val) => {
        const value = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
        setUiValues(prev => ({
            ...prev,
            [ip]: { ...(prev[ip] || {}), brightness: value }
        }));

        // debounce to reduce spam/jitter
        if (brightnessTimersRef.current[ip]) clearTimeout(brightnessTimersRef.current[ip]);
        brightnessTimersRef.current[ip] = setTimeout(() => {
            socket.emit('control_kasa', {
                ip: ip,
                action: 'brightness',
                value
            });
        }, 120);
    };

    const handleColor = (ip, hue) => {
        const value = Math.max(0, Math.min(360, parseInt(hue, 10) || 0));
        setUiValues(prev => ({
            ...prev,
            [ip]: { ...(prev[ip] || {}), hue: value }
        }));

        if (colorTimersRef.current[ip]) clearTimeout(colorTimersRef.current[ip]);
        colorTimersRef.current[ip] = setTimeout(() => {
            socket.emit('control_kasa', {
                ip: ip,
                action: 'color',
                value: { h: value, s: 100, v: 100 }
            });
        }, 140);
    };

    const markDragging = (ip, key, val) => {
        if (!draggingRef.current[ip]) draggingRef.current[ip] = {};
        draggingRef.current[ip][key] = val;
    };

    const flushBrightness = (ip) => {
        if (brightnessTimersRef.current[ip]) {
            clearTimeout(brightnessTimersRef.current[ip]);
            brightnessTimersRef.current[ip] = null;
        }
        const v = uiValuesRef.current[ip]?.brightness;
        if (typeof v === 'number') {
            socket.emit('control_kasa', {
                ip: ip,
                action: 'brightness',
                value: v
            });
        }
    };

    const flushColor = (ip) => {
        if (colorTimersRef.current[ip]) {
            clearTimeout(colorTimersRef.current[ip]);
            colorTimersRef.current[ip] = null;
        }
        const v = uiValuesRef.current[ip]?.hue;
        if (typeof v === 'number') {
            socket.emit('control_kasa', {
                ip: ip,
                action: 'color',
                value: { h: v, s: 100, v: 100 }
            });
        }
    };

    // Color logic can be added later, keeping it simple for now as requested (Off, On, Settings)

    return (
        <div className="w-full h-full flex flex-col p-4">
            {/* Header */}
            <div data-drag-handle className="flex items-center justify-between pb-2 border-b border-white/10 mb-2 cursor-grab active:cursor-grabbing select-none">
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${devices.length > 0 ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`} />
                    <h3 className="font-bold text-cyan-400 tracking-wider text-sm">SMART CONTROL</h3>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={requestList}
                        disabled={isLoading}
                        className={`p-1 rounded hover:bg-white/10 transition-colors ${isLoading ? 'animate-spin text-white/40' : 'text-white/50 hover:text-white'}`}
                        title="Refresh"
                    >
                        <RefreshCw size={14} />
                    </button>
                    <button
                        onClick={onClose}
                        className="p-1 rounded hover:bg-white/10 transition-colors text-white/50 hover:text-white"
                        title="Close"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto scrollbar-hide select-text">

                {devices.length === 0 && isLoading && !isThinking && (
                    <div className="flex flex-col items-center justify-center p-8 gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs text-cyan-400/80">Loading devices...</span>
                    </div>
                )}

                {devices.length === 0 && !isThinking && !isLoading && (
                    <div className="flex flex-col items-center justify-center p-8 text-center opacity-50">
                        <p className="text-xs mb-4">No devices found. Ensure they are on the same network.</p>
                        <button
                            onClick={handleDiscover}
                            className="flex items-center gap-2 px-4 py-2 bg-cyan-900/30 border border-cyan-500/30 rounded-lg hover:bg-cyan-500/20 hover:border-cyan-500 transition-all text-xs font-mono text-cyan-300"
                        >
                            <RefreshCw size={14} /> DISCOVER LIGHTS
                        </button>
                    </div>
                )}

                {isThinking && (
                    <div className="flex flex-col items-center justify-center p-8 gap-3">
                        <div className="w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs text-cyan-400 animate-pulse">Scanning Network...</span>
                    </div>
                )}

                {devices.map((dev) => (
                    <div key={dev.ip} className="mb-3 p-3 bg-white/5 rounded-lg border border-white/10 hover:border-cyan-500/30 transition-all select-none">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex flex-col">
                                <span className="font-bold text-sm text-white">{dev.alias}</span>
                                <span className="text-[10px] text-white/40 font-mono">{dev.ip}</span>
                            </div>
                            <button
                                onClick={() => handleToggle(dev.ip, dev.is_on)}
                                disabled={loadingDevices[dev.ip]}
                                className={`p-2 rounded-full transition-all ${dev.is_on
                                    ? 'bg-green-500/20 text-green-400 shadow-[0_0_10px_rgba(34,197,94,0.3)]'
                                    : 'bg-white/5 text-gray-500 hover:text-white'}
                                    ${loadingDevices[dev.ip] ? 'opacity-50 cursor-not-allowed' : ''}
                                `}
                            >
                                {loadingDevices[dev.ip] ? (
                                    <div className="w-[18px] h-[18px] border-2 border-current border-t-transparent rounded-full animate-spin" />
                                ) : (
                                    <Power size={18} />
                                )}
                            </button>

                        </div>

                        {/* Controls */}
                        {dev.has_brightness && dev.is_on && (
                            <div className="flex items-center gap-2 mt-2">
                                <Sun size={14} className="text-yellow-500/70" />
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={uiValues[dev.ip]?.brightness ?? dev.brightness ?? 100}
                                    onChange={(e) => handleBrightness(dev.ip, e.target.value)}
                                    onPointerDown={() => markDragging(dev.ip, 'brightness', true)}
                                    onPointerUp={() => {
                                        markDragging(dev.ip, 'brightness', false);
                                        flushBrightness(dev.ip);
                                    }}
                                    onPointerCancel={() => markDragging(dev.ip, 'brightness', false)}
                                    className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400"
                                />
                            </div>
                        )}

                        {/* Color Control */}
                        {dev.has_color && dev.is_on && (
                            <div className="flex items-center gap-2 mt-2">
                                <Palette size={14} className="text-purple-500/70" />
                                <input
                                    type="range"
                                    min="0"
                                    max="360"
                                    value={uiValues[dev.ip]?.hue ?? (dev.hsv && dev.hsv.h) ?? 0}
                                    onChange={(e) => handleColor(dev.ip, e.target.value)}
                                    onPointerDown={() => markDragging(dev.ip, 'hue', true)}
                                    onPointerUp={() => {
                                        markDragging(dev.ip, 'hue', false);
                                        flushColor(dev.ip);
                                    }}
                                    onPointerCancel={() => markDragging(dev.ip, 'hue', false)}
                                    className="w-full h-1 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white"
                                    style={{
                                        background: 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)'
                                    }}
                                />
                            </div>
                        )}
                    </div>
                ))}

                {/* Bottom Discover (if devices exist) */}
                {devices.length > 0 && (
                    <div className="pt-2 border-t border-white/10 mt-2 flex justify-end">
                        <button
                            onClick={handleDiscover}
                            className="p-1 text-white/30 hover:text-cyan-400 transition-colors"
                            title="Rescan"
                        >
                            <RefreshCw size={14} />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default KasaWindow;
