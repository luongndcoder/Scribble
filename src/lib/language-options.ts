/**
 * Shared language option lists used across language selectors.
 *
 * Canonical pattern across the app:
 *   - Label = English language name (Vietnamese, Japanese, Chinese …)
 *   - Value = ISO 639-1 two-letter code (vi, en, ja …)
 *
 * Use NVIDIA_STT_LANGUAGES for STT pickers (Recording, Upload, Settings).
 * SonioxLanguages covers a wider set when Soniox is the chosen provider.
 *
 * Importing the same constant in every component keeps the visible labels +
 * supported set in sync — previously each component inlined its own array
 * and they drifted (some used native scripts like "Tiếng Việt", others used
 * "Vietnamese"; some lists missed Russian/Hindi/Arabic).
 */

export interface LanguageOption {
    value: string;
    label: string;
}

/** STT languages supported by Nvidia Riva — mirrors SettingsPanel.nvidiaLanguages.
 *  Not declared `readonly` so it can be passed straight to CustomSelect's
 *  `options: Option[]` prop without a cast. Treat as immutable in practice. */
export const NVIDIA_STT_LANGUAGES: LanguageOption[] = [
    { value: 'vi', label: 'Vietnamese' },
    { value: 'en', label: 'English' },
    { value: 'zh', label: 'Chinese' },
    { value: 'ja', label: 'Japanese' },
    { value: 'ko', label: 'Korean' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
    { value: 'es', label: 'Spanish' },
    { value: 'it', label: 'Italian' },
    { value: 'pt', label: 'Portuguese' },
    { value: 'ru', label: 'Russian' },
    { value: 'hi', label: 'Hindi' },
    { value: 'ar', label: 'Arabic' },
];
