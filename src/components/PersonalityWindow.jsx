import React, { useEffect, useState } from 'react';
import { Heart, Activity, Moon, Zap } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

const PersonalityWindow = ({ socket }) => {
    const [state, setState] = useState({
        affection: 0.0,
        mood: 'neutral',
        energy: 0.8,
        cycle_day: 1,
        current_cycle_length: 28,
        phase: 'Normal'
    });
    const { t } = useLanguage();

    useEffect(() => {
        if (!socket) return;

        const handleStatus = (data) => {
            setState(prev => ({ ...prev, ...data }));
        };

        socket.on('personality_status', handleStatus);
        
        // Request initial status
        socket.emit('get_personality_status');

        return () => {
            socket.off('personality_status', handleStatus);
        };
    }, [socket]);

    const getMoodColor = (mood) => {
        const m = (mood || '').toLowerCase();
        if (['happy', 'excited', 'joyful', 'cheerful'].some(x => m.includes(x))) return 'text-green-400';
        if (['sad', 'tired', 'depressed', 'lonely'].some(x => m.includes(x))) return 'text-blue-400';
        if (['angry', 'annoyed', 'frustrated'].some(x => m.includes(x))) return 'text-red-400';
        if (['romantic', 'loving', 'affectionate'].some(x => m.includes(x))) return 'text-pink-400';
        return 'text-yellow-400'; // neutral
    };

    const getBorderColor = () => {
        if (state.affection > 50) return 'border-pink-500/50';
        if ((state.mood || '').includes('happy')) return 'border-green-500/50';
        return 'border-white/10';
    };

    return (
        <div className={`fixed top-12 left-4 z-40 w-64 bg-black/90 backdrop-blur-md border ${getBorderColor()} rounded-xl p-4 shadow-lg transition-colors duration-500 select-none pointer-events-none`}>
            <div className="flex items-center justify-between mb-3 border-b border-white/10 pb-2">
                <span className="text-xs font-bold tracking-widest text-white/60 uppercase">{t('personality.state')}</span>
                <div className={`w-2 h-2 rounded-full ${state.energy > 0.5 ? 'bg-green-500' : 'bg-yellow-500'} animate-pulse`} />
            </div>

            <div className="space-y-3">
                {/* Affection */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-pink-400">
                        <Heart size={14} className={state.affection > 20 ? "fill-pink-400/20" : ""} />
                        <span className="text-xs font-medium">{t('personality.affection')}</span>
                    </div>
                    <span className="text-sm font-bold text-pink-300">{state.affection.toFixed(1)}</span>
                </div>

                {/* Mood */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-yellow-400">
                        <Activity size={14} />
                        <span className="text-xs font-medium">{t('personality.mood')}</span>
                    </div>
                    <span className={`text-sm font-bold capitalize ${getMoodColor(state.mood)}`}>{state.mood}</span>
                </div>

                {/* Energy */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-blue-400">
                        <Zap size={14} />
                        <span className="text-xs font-medium">{t('personality.energy')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <div 
                                className="h-full bg-blue-400 transition-all duration-500"
                                style={{ width: `${Math.round(state.energy * 100)}%` }}
                            />
                        </div>
                        <span className="text-xs text-blue-300">{Math.round(state.energy * 100)}%</span>
                    </div>
                </div>

                {/* Cycle */}
                <div className="pt-2 border-t border-white/5">
                    <div className="flex items-center gap-2 text-purple-300 mb-1">
                        <Moon size={12} />
                        <span className="text-[10px] uppercase tracking-wider opacity-70">{t('personality.cycle')}</span>
                    </div>
                    <div className="flex justify-between items-baseline">
                        <span className="text-xs text-white/80">{t('personality.day')} {state.cycle_day} <span className="text-white/30">/ {state.current_cycle_length}</span></span>
                        <span className="text-[10px] text-white/50 italic truncate max-w-[120px] ml-2">{state.phase}</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PersonalityWindow;