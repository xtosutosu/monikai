import React from 'react';
import { Shield, Check, X, Terminal, AlertTriangle } from 'lucide-react';

const ConfirmationPopup = ({ request, onConfirm, onDeny }) => {
    if (!request) return null;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-full max-w-2xl bg-black/60 backdrop-blur-2xl border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col transform transition-all">
                
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-white/10 bg-white/5">
                    <div className="flex items-center gap-3">
                        <Shield size={18} className="text-white" />
                        <span className="text-sm font-medium tracking-wider text-white/90 uppercase">System Request</span>
                    </div>
                </div>

                {/* Content */}
                <div className="p-6 space-y-6">
                    <div className="flex items-start gap-4">
                        <div className="p-3 rounded-full bg-white/10 text-white shrink-0 border border-white/20">
                            <AlertTriangle size={24} />
                        </div>
                        <div className="space-y-1">
                            <h3 className="text-white font-medium">Permission Required</h3>
                            <p className="text-sm text-white/60 leading-relaxed">
                                Monika is requesting to use an external tool. Please review the details below.
                            </p>
                        </div>
                    </div>

                    <div className="bg-black/50 border border-white/10 rounded-lg overflow-hidden">
                        <div className="px-3 py-2 border-b border-white/5 bg-white/5 flex items-center gap-2">
                            <Terminal size={12} className="text-white/40" />
                            <span className="text-[10px] font-mono text-white/60 uppercase tracking-wider">Command Details</span>
                        </div>
                        <div className="p-3 space-y-2">
                            <div className="flex justify-between items-baseline">
                                <span className="text-xs text-white/40 font-mono">Tool:</span>
                                <span className="text-xs text-white font-mono font-bold">{request.tool}</span>
                            </div>
                            <div className="space-y-1">
                                <span className="text-xs text-white/40 font-mono block">Arguments:</span>
                                <pre className="text-[10px] text-white/70 font-mono bg-white/5 p-2 rounded border border-white/5 overflow-y-auto max-h-60 custom-scrollbar whitespace-pre-wrap break-words">
                                    {JSON.stringify(request.args, null, 2)}
                                </pre>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/10 bg-white/5 flex gap-3">
                    <button
                        onClick={onDeny}
                        className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 hover:bg-white/10 text-white/70 hover:text-white text-xs font-medium tracking-wide transition-colors flex items-center justify-center gap-2"
                    >
                        <X size={14} />
                        Deny
                    </button>
                    <button
                        onClick={onConfirm}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-white/20 hover:bg-white/30 text-white text-xs font-medium tracking-wide transition-colors flex items-center justify-center gap-2 shadow-lg shadow-white/10"
                    >
                        <Check size={14} />
                        Allow
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ConfirmationPopup;
