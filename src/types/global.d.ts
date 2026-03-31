/** Global window extensions used by the recording subsystem. */
interface ScribbleWindowExtensions {
    __TAURI_INTERNALS__?: unknown;
    __vadInterval?: ReturnType<typeof setInterval>;
    __systemBarInterval?: ReturnType<typeof setInterval>;
    __systemAudioUnlisten?: (() => void) | null;
    __systemUnlistenTimeout?: ReturnType<typeof setTimeout>;
}

interface Window extends ScribbleWindowExtensions {}
