import { useState, useRef, useEffect } from 'react';
import { IconCheck, IconChevronDown } from './icons/scribble-icons';

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
    const [closing, setClosing] = useState(false);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    const closeDropdown = () => {
        if (!open || closing) return;
        setClosing(true);
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        closeTimerRef.current = setTimeout(() => {
            setOpen(false);
            setClosing(false);
            closeTimerRef.current = null;
        }, 150);
    };

    const openDropdown = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
        setClosing(false);
        setOpen(true);
        if (onOpen) onOpen();
    };

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) closeDropdown();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    });

    useEffect(() => {
        return () => {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        };
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

    const isExpanded = open && !closing;

    return (
        <div className={`custom-select ${className} ${isExpanded ? 'open' : ''} ${disabled ? 'disabled' : ''}`} ref={ref}>
            <button
                className="custom-select-trigger"
                onClick={() => {
                    if (!disabled) {
                        if (isExpanded) {
                            closeDropdown();
                        } else {
                            openDropdown();
                        }
                    }
                }}
                type="button"
                aria-expanded={isExpanded}
            >
                <span className="custom-select-value">{displayLabel}</span>
                <IconChevronDown size={14} className="custom-select-chevron" />
            </button>
            {open && (
                <div className={`custom-select-dropdown${closing ? ' is-closing' : ' is-open'}`}>
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
                                        closeDropdown();
                                    }
                                }}
                                type="button"
                            >
                                {isSelected && (
                                    <IconCheck size={14} strokeWidth={2.25} />
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
