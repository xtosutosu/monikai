import React, { useEffect, useState } from 'react';
import { Heart, Activity, Moon, Zap } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

const PersonalityWindow = ({ socket }) => {
    const [state, setState] = useState({
        affection: 0.0,
        affection_hearts: '',
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
        if (state.affection > 50) return 'border-pink-500/50 shadow-[0_0_30px_rgba(236,72,153,0.15)]';
        if ((state.mood || '').includes('happy')) return 'border-green-500/50 shadow-[0_0_30px_rgba(34,197,94,0.15)]';
        return 'border-white/[0.14] shadow-2xl';
    };

    return (
        <div className={`fixed top-[64px] left-4 z-[60] w-72 bg-black/50 backdrop-blur-2xl border ${getBorderColor()} rounded-2xl p-5 transition-all duration-500 select-none pointer-events-none`}>
            <div className="flex items-center justify-between mb-4 border-b border-white/10 pb-3">
                <span className="text-xs font-bold tracking-[0.2em] text-white/60 uppercase">{t('personality.state')}</span>
                <div className={`w-2 h-2 rounded-full ${state.energy > 0.5 ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]' : 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.8)]'} animate-pulse`} />
            </div>

            <div className="space-y-4">
                {/* Affection */}
                <div className="flex items-center justify-between group">
                    <div className="flex items-center gap-3 text-pink-400/90 group-hover:text-pink-400 transition-colors">
                        <div className="p-1.5 rounded-lg bg-pink-500/10 border border-pink-500/20">
                            <Heart size={14} className={state.affection > 20 ? "fill-pink-500/50" : ""} />
                        </div>
                        <span className="text-xs font-medium tracking-wide">{t('personality.affection')}</span>
                    </div>
                    <span className="text-[10px] font-bold text-pink-300 font-mono tracking-tighter">
                        {state.affection_hearts || state.affection.toFixed(1)}
                    </span>
                </div>

                {/* Mood */}
                <div className="flex items-center justify-between group">
                    <div className="flex items-center gap-3 text-yellow-400/90 group-hover:text-yellow-400 transition-colors">
                        <div className="p-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                            <Activity size={14} />
                        </div>
                        <span className="text-xs font-medium tracking-wide">{t('personality.mood')}</span>
                    </div>
                    <span className={`text-xs font-bold uppercase tracking-wider ${getMoodColor(state.mood)}`}>{state.mood}</span>
                </div>

                {/* Energy */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-blue-400/90">
                        <div className="flex items-center gap-3">
                            <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
                                <Zap size={14} />
                            </div>
                            <span className="text-xs font-medium tracking-wide">{t('personality.energy')}</span>
                        </div>
                        <span className="text-xs font-mono text-blue-300">{Math.round(state.energy * 100)}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden border border-white/5">
                        <div 
                            className="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-500 rounded-full"
                            style={{ width: `${Math.round(state.energy * 100)}%` }}
                        />
                    </div>
                </div>

                {/* Cycle */}
                <div className="pt-3 border-t border-white/10">
                    <div className="flex items-center gap-2 text-purple-300/80 mb-2">
                        <Moon size={12} />
                        <span className="text-[10px] uppercase tracking-[0.15em] opacity-70">{t('personality.cycle')}</span>
                    </div>
                    <div className="flex justify-between items-center">
                        <div className="flex items-baseline gap-1">
                            <span className="text-sm font-bold text-white/90">{t('personality.day')} {state.cycle_day}</span>
                            <span className="text-xs text-white/30 font-mono">/ {state.current_cycle_length}</span>
                        </div>
                        <span className="text-[10px] text-white/40 italic truncate max-w-[140px] bg-white/5 px-2 py-1 rounded border border-white/5">
                            {state.phase}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PersonalityWindow;