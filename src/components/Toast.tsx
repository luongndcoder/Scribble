import { useState, useCallback, useRef, createContext, useContext, type ReactNode } from 'react';
import { IconCheckCircle, IconClose, IconErrorCircle, IconInfo, IconWarning } from './icons/scribble-icons';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
    id: number;
    message: string;
    type: ToastType;
    exiting?: boolean;
}

interface ToastContextType {
    showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType>({ showToast: () => { } });

export const useToast = () => useContext(ToastContext);

let _nextId = 0;

const ICONS: Record<ToastType, ReactNode> = {
    success: <IconCheckCircle size={16} strokeWidth={2} />,
    error: <IconErrorCircle size={16} strokeWidth={2} />,
    info: <IconInfo size={16} strokeWidth={2} />,
    warning: <IconWarning size={16} strokeWidth={2} />,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const timersRef = useRef<Map<number, { exit: ReturnType<typeof setTimeout>; remove: ReturnType<typeof setTimeout> }>>(new Map());

    const dismissToast = useCallback((id: number) => {
        // Clear pending timers
        const timers = timersRef.current.get(id);
        if (timers) {
            clearTimeout(timers.exit);
            clearTimeout(timers.remove);
            timersRef.current.delete(id);
        }
        // Start exit animation (--toast-close: 250ms)
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 250);
    }, []);

    const showToast = useCallback((message: string, type: ToastType = 'info') => {
        const id = ++_nextId;
        setToasts((prev) => [...prev, { id, message, type }]);

        // Errors get a longer dwell time — actionable messages (budget
        // exhausted, key invalid) need reading time, not a 3.5s glance.
        const dwellMs = type === 'error' ? 7000 : 3500;
        const exitTimer = setTimeout(() => {
            setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
        }, dwellMs);
        const removeTimer = setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
            timersRef.current.delete(id);
        }, dwellMs + 250);

        timersRef.current.set(id, { exit: exitTimer, remove: removeTimer });
    }, []);

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <div className="toast-container">
                {toasts.map((t) => (
                    <div
                        key={t.id}
                        className={`toast toast-${t.type}${t.exiting ? ' toast-exit' : ''}`}
                        onClick={() => dismissToast(t.id)}
                    >
                        <span className="toast-icon">{ICONS[t.type]}</span>
                        <span className="toast-msg">{t.message}</span>
                        <button
                            className="toast-dismiss"
                            onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }}
                            aria-label="Dismiss"
                        ><IconClose size={14} /></button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}
