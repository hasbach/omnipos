import React from 'react';
import { Minus, Square, X } from 'lucide-react';

interface WindowFrameProps {
  children: React.ReactNode;
  title: string;
  icon?: React.ReactNode;
}

export default function WindowFrame({ children, title, icon }: WindowFrameProps) {
  const handleMinimize = () => {
    if (window.electronAPI) {
      window.electronAPI.minimize();
    } else {
      console.log('Minimize (Browser Fallback)');
    }
  };
  const handleMaximize = () => {
    if (window.electronAPI) {
      window.electronAPI.maximize();
    } else {
      console.log('Maximize (Browser Fallback)');
    }
  };
  const handleClose = () => {
    if (window.electronAPI) {
      window.electronAPI.close();
    } else {
      if (confirm('Close application?')) {
        window.close();
      }
    }
  };

  return (
    <div className="h-screen bg-app-bg p-4 flex flex-col transition-colors duration-300">
      <div className="flex-1 flex flex-col bg-app-surface border-2 border-app-ink rounded-xl shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] dark:shadow-[8px_8px_0px_0px_rgba(245,245,245,0.2)] overflow-hidden transition-all duration-300">
        {/* Title Bar */}
        <div 
          className="h-10 bg-app-ink text-app-bg flex items-center justify-between px-4 select-none"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="flex items-center gap-2">
            {icon && <div className="opacity-80">{icon}</div>}
            <span className="text-[10px] font-black uppercase tracking-widest">{title}</span>
          </div>
          
          <div className="flex items-center gap-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <div className="flex items-center gap-2">
              <button 
                onClick={handleMinimize}
                className="p-1 hover:bg-white/10 rounded transition-colors"
              >
                <Minus size={14} strokeWidth={3} />
              </button>
              <button 
                onClick={handleMaximize}
                className="p-1 hover:bg-white/10 rounded transition-colors"
              >
                <Square size={10} strokeWidth={3} />
              </button>
              <button 
                onClick={handleClose}
                className="p-1 hover:bg-red-500 rounded transition-colors"
              >
                <X size={14} strokeWidth={3} />
              </button>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
