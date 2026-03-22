import { useState, useRef, useEffect } from 'react';

interface Option {
    value: string;
    label: string;
}

interface CustomSelectProps {
    options: Option[];
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    className?: string;
    multiple?: boolean;
    selectedValues?: Set<string>;
    onToggle?: (value: string) => void;
    onOpen?: () => void;
}

export function CustomSelect({ options, value, onChange, disabled, className = '', multiple, selectedValues, onToggle, onOpen }: CustomSelectProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const selected = options.find(o => o.value === value);

    // Multi-select display
    const displayLabel = multiple && selectedValues
        ? (selectedValues.size === 0
            ? '—'
            : selectedValues.size <= 2
                ? options.filter(o => selectedValues.has(o.value)).map(o => o.label).join(', ')
                : `${selectedValues.size} selected`)
        : (selected?.label || value);

    return (
        <div className={`custom-select ${className} ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`} ref={ref}>
            <button
                className="custom-select-trigger"
                onClick={() => {
                    if (!disabled) {
                        const opening = !open;
                        setOpen(opening);
                        if (opening && onOpen) onOpen();
                    }
                }}
                type="button"
            >
                <span className="custom-select-value">{displayLabel}</span>
                <svg className="custom-select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </button>
            {open && (
                <div className="custom-select-dropdown">
                    {options.map(opt => {
                        const isSelected = multiple && selectedValues
                            ? selectedValues.has(opt.value)
                            : opt.value === value;

                        return (
                            <button
                                key={opt.value}
                                className={`custom-select-option ${isSelected ? 'selected' : ''}`}
                                onClick={() => {
                                    if (multiple && onToggle) {
                                        onToggle(opt.value);
                                    } else {
                                        onChange(opt.value);
                                        setOpen(false);
                                    }
                                }}
                                type="button"
                            >
                                {isSelected && (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                )}
                                <span>{opt.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
