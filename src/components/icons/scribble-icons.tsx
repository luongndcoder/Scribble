import type { SVGProps } from 'react';
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  FileText,
  Info,
  Languages,
  LoaderCircle,
  Mic,
  Monitor,
  Moon,
  NotebookText,
  Paperclip,
  Pause,
  Pencil,
  PenTool,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Square,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * Scribble icon set — powered by Lucide Icons (https://lucide.dev/icons/).
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
  strokeWidth?: number | string;
}

function wrapLucide(Icon: LucideIcon, defaultFilled = false) {
  return function WrappedLucideIcon({ size = 16, strokeWidth = 1.8, fill, ...rest }: IconProps) {
    return (
      <Icon
        size={size}
        strokeWidth={strokeWidth}
        fill={fill ?? (defaultFilled ? 'currentColor' : 'none')}
        aria-hidden="true"
        {...rest}
      />
    );
  };
}

// ── Recording & audio ──────────────────────────────────────────────
export const IconMic = wrapLucide(Mic);
export const IconRecord = wrapLucide(Circle, true);
export const IconStop = wrapLucide(Square, true);
export const IconPlay = wrapLucide(Play, true);
export const IconPause = wrapLucide(Pause, true);
export const IconTranslate = wrapLucide(Languages);
export const IconSpeaker = wrapLucide(User);

// ── Navigation & chrome ────────────────────────────────────────────
export const IconSettings = wrapLucide(SlidersHorizontal);
export const IconSun = wrapLucide(Sun);
export const IconMoon = wrapLucide(Moon);
export const IconClose = wrapLucide(X);
export const IconPlus = wrapLucide(Plus);
export const IconCheck = wrapLucide(Check);
export const IconChevronDown = wrapLucide(ChevronDown);
export const IconChevronUp = wrapLucide(ChevronUp);
export const IconChevronLeft = wrapLucide(ChevronLeft);
export const IconArrowDown = wrapLucide(ArrowDown);
export const IconDots = wrapLucide(Ellipsis);
export const IconSpinner = wrapLucide(LoaderCircle);

// ── Actions ────────────────────────────────────────────────────────
export const IconDownload = wrapLucide(Download);
export const IconUpload = wrapLucide(Upload);
export const IconSearch = wrapLucide(Search);
export const IconEdit = wrapLucide(Pencil);
export const IconTrash = wrapLucide(Trash2);
export const IconCopy = wrapLucide(Copy);
export const IconPaperclip = wrapLucide(Paperclip);
export const IconEye = wrapLucide(Eye);
export const IconEyeOff = wrapLucide(EyeOff);

// ── Documents ──────────────────────────────────────────────────────
export const IconMinutes = wrapLucide(NotebookText);
export const IconNib = wrapLucide(PenTool);
export const IconPage = wrapLucide(FileText);

// ── Status ─────────────────────────────────────────────────────────
export const IconWarning = wrapLucide(TriangleAlert);
export const IconAlert = wrapLucide(CircleAlert);
export const IconInfo = wrapLucide(Info);
export const IconErrorCircle = wrapLucide(CircleX);
export const IconCheckCircle = wrapLucide(CircleCheck);
export const IconWifiOff = wrapLucide(WifiOff);
export const IconSystem = wrapLucide(Monitor);
