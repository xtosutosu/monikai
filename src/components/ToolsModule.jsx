import React from 'react';
import { Mic, MicOff, Settings, Power, Video, VideoOff, Hand, Lightbulb, Globe, Monitor, FileText, CalendarDays, Heart, ClipboardList } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

const Button = ({ onClick, isActive, disabled, icon: Icon, activeIcon: ActiveIcon, title, variant = 'default', onContextMenu }) => {
    const TheIcon = (isActive && ActiveIcon) ? ActiveIcon : Icon;
    
    let baseClass = "p-3 rounded-xl transition-all duration-200 border border-transparent";
    let stateClass = "";

    if (disabled) {
        stateClass = "text-white/20 cursor-not-allowed";
    } else if (variant === 'power') {
        stateClass = isActive 
            ? "bg-green-500/20 text-green-400 border-green-500/30 shadow-[0_0_15px_rgba(34,197,94,0.2)] hover:bg-green-500/30" 
            : "text-white/40 hover:text-white hover:bg-white/10";
    } else if (variant === 'danger') {
        stateClass = isActive 
            ? "bg-red-500/20 text-red-400 border-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.2)] hover:bg-red-500/30" 
            : "text-white/60 hover:text-white hover:bg-white/10";
    } else {
        // Default cyan theme for active states
        stateClass = isActive 
            ? "bg-white/20 text-white border-white/30 shadow-[0_0_15px_rgba(255,255,255,0.15)] hover:bg-white/30" 
            : "text-white/50 hover:text-white hover:bg-white/10";
    }

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            onContextMenu={onContextMenu}
            className={`${baseClass} ${stateClass}`}
            title={title}
        >
            <TheIcon size={20} />
        </button>
    );
};

const ToolsModule = ({
    isConnected,
    isMuted,
    isVideoOn,
    isScreenCaptureOn,
    isHandTrackingEnabled,
    sessionActive,
    showSettings,
    onTogglePower,
    onToggleMute,
    onToggleVideo,
    onToggleScreenCapture,
    onToggleSettings,
    onToggleSession,
    onToggleReminders,
    showRemindersWindow,
    onToggleNotes,
    showNotesWindow,
    onToggleHand,
    onToggleKasa,
    showKasaWindow,
    onToggleBrowser,
    showBrowserWindow,
    onToggleCompanion,
    showCompanionWindow,
    onResetPosition,
    activeDragElement,

    position,
    onMouseDown,
    zIndex
}) => {
    const { t } = useLanguage();

    return (
        <div
            id="tools"
            onMouseDown={onMouseDown}
            className={`absolute px-4 py-3 transition-all duration-200 
                        backdrop-blur-2xl bg-black/50 border border-white/[0.14] shadow-2xl rounded-2xl
                        ${activeDragElement === 'tools' ? 'ring-1 ring-white/50 border-white/30' : ''}`}
            style={{
                left: Math.round(position.x),
                top: Math.round(position.y),
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'auto',
                zIndex: zIndex
            }}
        >
            {/* Drag Handle Indicator */}
            <div className="absolute top-1 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-white/10" />

            <div className="flex justify-center gap-2 relative z-10">
                <Button 
                    onClick={onTogglePower} 
                    isActive={isConnected} 
                    icon={Power} 
                    variant="power" 
                    title={t('tools.power')} 
                />
                
                <div className="w-px bg-white/10 mx-1 my-2" />

                <Button 
                    onClick={onToggleMute} 
                    isActive={!isMuted} 
                    disabled={!isConnected}
                    icon={MicOff} 
                    activeIcon={Mic}
                    title={t('tools.mute')} 
                />

                <Button 
                    onClick={onToggleVideo} 
                    isActive={isVideoOn} 
                    disabled={!isConnected || isMuted}
                    icon={VideoOff} 
                    activeIcon={Video}
                    title={t('tools.camera_preview')} 
                />

                <Button 
                    onClick={onToggleScreenCapture} 
                    isActive={isScreenCaptureOn} 
                    disabled={!isConnected || isMuted}
                    icon={Monitor} 
                    title={t('tools.screen_capture')} 
                />

                <Button 
                    onClick={onToggleHand} 
                    isActive={isHandTrackingEnabled} 
                    disabled={!isConnected || isMuted}
                    icon={Hand} 
                    title={t('tools.hand_tracking')} 
                />

                <div className="w-px bg-white/10 mx-1 my-2" />

                <Button 
                    onClick={onToggleSession} 
                    isActive={sessionActive} 
                    disabled={!isConnected}
                    icon={ClipboardList} 
                    title={t('tools.session') || "Session"} 
                />

                <div className="w-px bg-white/10 mx-1 my-2" />

                <Button 
                    onClick={onToggleCompanion} 
                    isActive={showCompanionWindow} 
                    disabled={!isConnected}
                    icon={Heart} 
                    title={t('tools.companion') || "Companion"}
                    onContextMenu={(e) => { e.preventDefault(); onResetPosition('companion'); }}
                />

                <div className="w-px bg-white/10 mx-1 my-2" />

                <Button 
                    onClick={onToggleBrowser} 
                    isActive={showBrowserWindow} 
                    disabled={!isConnected}
                    icon={Globe} 
                    title={t('tools.web_agent')}
                    onContextMenu={(e) => { e.preventDefault(); onResetPosition('browser'); }}
                />

                <Button 
                    onClick={onToggleReminders} 
                    isActive={showRemindersWindow} 
                    disabled={!isConnected}
                    icon={CalendarDays} 
                    title={t('tools.schedule')}
                    onContextMenu={(e) => { e.preventDefault(); onResetPosition('reminders'); }}
                />

                <Button 
                    onClick={onToggleNotes} 
                    isActive={showNotesWindow} 
                    disabled={!isConnected}
                    icon={FileText} 
                    title={t('tools.notes')}
                    onContextMenu={(e) => { e.preventDefault(); onResetPosition('notes'); }}
                />

                <Button 
                    onClick={onToggleKasa} 
                    isActive={showKasaWindow} 
                    disabled={!isConnected}
                    icon={Lightbulb} 
                    title={t('tools.kasa')}
                    onContextMenu={(e) => { e.preventDefault(); onResetPosition('kasa'); }}
                />

                <div className="w-px bg-white/10 mx-1 my-2" />

                <Button 
                    onClick={onToggleSettings} 
                    isActive={showSettings} 
                    icon={Settings} 
                    title={t('tools.settings')} 
                />
            </div>
        </div>
    );
};

export default ToolsModule;
