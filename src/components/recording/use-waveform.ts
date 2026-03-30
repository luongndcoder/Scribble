import { useRef, useCallback } from "react";

/**
 * Hook for audio waveform visualization.
 * Uses refs instead of state to avoid unnecessary re-renders on every animation frame.
 */
export function useWaveform() {
    const analyserRef = useRef<AnalyserNode | null>(null);
    const animFrameRef = useRef<number>(0);
    const barHeightsRef = useRef<[string, string, string]>(["4px", "4px", "4px"]);
    // A state-setter callback injected from the parent to sync bar heights when needed
    const setBarHeightsFn = useRef<(h: string[]) => void>(() => {});

    const startDrawing = useCallback(() => {
        const analyser = analyserRef.current;
        if (!analyser) return;
        const bufLen = analyser.fftSize;
        const data = new Float32Array(bufLen);
        const draw = () => {
            animFrameRef.current = requestAnimationFrame(draw);
            analyser.getFloatTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < bufLen; i++) sum += data[i] * data[i];
            const rms = Math.sqrt(sum / bufLen);
            const level = Math.min(rms * 8, 1);
            const heights: [string, string, string] = [
                `${Math.max(4, level * 20 + Math.random() * 6)}px`,
                `${Math.max(4, level * 24 + Math.random() * 4)}px`,
                `${Math.max(4, level * 18 + Math.random() * 8)}px`,
            ];
            barHeightsRef.current = heights;
            setBarHeightsFn.current(heights);
        };
        draw();
    }, []);

    const stopDrawing = useCallback(() => {
        cancelAnimationFrame(animFrameRef.current);
        barHeightsRef.current = ["4px", "4px", "4px"];
        setBarHeightsFn.current(["4px", "4px", "4px"]);
    }, []);

    return { analyserRef, animFrameRef, barHeightsRef, startDrawing, stopDrawing, setBarHeightsFn };
}
