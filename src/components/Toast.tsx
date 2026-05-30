import { useState, useCallback, useRef, createContext, useContext } from 'react';

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

const ICONS: Record<ToastType, string> = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '⚠',
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
        // Start exit animation
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 300);
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
        }, dwellMs + 300);

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
                        >✕</button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}
