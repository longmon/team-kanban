// 经典主题（Windows 98）用的 16×16 像素图标：内联 SVG 路径（来自设计稿 win98.js），不外链任何图片；只在 data-skin="classic" 下使用
import type { Tone } from "./ui";

/** 图标名 → SVG 内部路径（静态常量，非用户输入） */
const PATHS = {
  "folder": `<path fill="#000" d="M1 3h5l1 1h7v10H1z"/><path fill="#ffff9c" d="M2 4h4l1 1h6v8H2z"/><path fill="#cece63" d="M2 12h11v1H2z"/>`,
  "folder-open": `<path fill="#000" d="M1 3h5l1 1h6v2h2l-2 8H1z"/><path fill="#cece63" d="M2 4h4l1 1h5v1H4l-2 6z"/><path fill="#ffff9c" d="M4 7h10l-2 6H2z"/>`,
  "desk": `<path fill="#000" d="M1 2h14v9H1zM5 12h6v1h2v1H3v-1h2z"/><path fill="#008080" d="M2 3h12v7H2z"/><path fill="#c0c0c0" d="M6 12h4v1H6z"/>`,
  "org": `<path fill="#000" d="M2 1h8v14H2zM10 5h4v10h-4z"/><path fill="#c0c0c0" d="M3 2h6v12H3zM11 6h2v8h-2z"/><path fill="#000080" d="M4 3h1v1H4zM7 3h1v1H7zM4 6h1v1H4zM7 6h1v1H7zM4 9h1v1H4zM7 9h1v1H7zM5 12h2v2H5zM11 7h1v1h-1zM11 10h1v1h-1z"/>`,
  "logo": `<path fill="#000" d="M0 1h16v14H0z"/><path fill="#fff" d="M1 2h14v12H1z"/><path fill="#000080" d="M1 2h14v2H1z"/><path fill="#ff0000" d="M2 5h3v2H2z"/><path fill="#ffcc00" d="M2 8h3v2H2zM7 5h3v2H7z"/><path fill="#00a000" d="M12 5h2v2h-2zM12 8h2v2h-2zM12 11h2v2h-2z"/><path fill="#808080" d="M6 4h1v10H6zM11 4h1v10h-1z"/>`,
  "vote": `<path fill="#000" d="M1 7h14v8H1zM5 1h7v7H5z"/><path fill="#fff" d="M6 2h5v5H6z"/><path fill="#c00000" d="M7 4h1v1H7zM8 5h1v1H8zM9 3h1v2H9z"/><path fill="#5a7edc" d="M2 8h12v6H2z"/><path fill="#000" d="M4 9h8v1H4z"/><path fill="#9cb6f0" d="M2 8h12v1H2z"/>`,
  "report": `<path fill="#000" d="M2 0h9l3 3v13H2z"/><path fill="#fff" d="M3 1h7v3h3v11H3z"/><path fill="#c00000" d="M4 10h2v4H4z"/><path fill="#000080" d="M7 7h2v7H7z"/><path fill="#008000" d="M10 9h2v5h-2z"/>`,
  "flow": `<path fill="#000" d="M1 1h6v4H1zM9 6h6v4H9zM1 11h6v4H1zM4 5h1v6H4zM5 8h4v1H5z"/><path fill="#ffff9c" d="M2 2h4v2H2z"/><path fill="#9cceff" d="M10 7h4v2h-4z"/><path fill="#ff9c9c" d="M2 12h4v2H2z"/>`,
  "arch": `<path fill="#000" d="M3 1h10v4H3zM1 6h14v4H1zM1 11h14v4H1z"/><path fill="#ce9cff" d="M4 2h8v2H4z"/><path fill="#9cceff" d="M2 7h3v2H2zM6 7h4v2H6zM11 7h3v2h-3z"/><path fill="#c0c0c0" d="M2 12h12v2H2z"/>`,
  "kb": `<path fill="#000" d="M2 1h11v14H2z"/><path fill="#008080" d="M3 2h9v12H3z"/><path fill="#fff" d="M5 4h5v2H5z"/><path fill="#004040" d="M3 2h1v12H3z"/><path fill="#fff" d="M13 2h1v13H3v-1h10z"/>`,
  "api": `<path fill="#000" d="M2 0h9l3 3v13H2z"/><path fill="#fff" d="M3 1h7v3h3v11H3z"/><path fill="#000080" d="M6 6h1v1H5v1H4v1h1v1h1v1h1v-1H6V9H5V8h1V7h1zM9 6h1v1h1v1h1v1h-1v1h-1v1H9v-1h1V9h1V8h-1V7H9z"/>`,
  "form": `<path fill="#000" d="M2 2h12v14H2zM5 0h6v4H5z"/><path fill="#fff" d="M3 3h10v12H3z"/><path fill="#c0c0c0" d="M6 1h4v2H6z"/><path fill="#000" d="M4 6h2v2H4zM4 10h2v2H4z"/><path fill="#808080" d="M7 6h5v1H7zM7 10h5v1H7z"/><path fill="#fff" d="M5 7h0v0z"/>`,
  "tasks": `<path fill="#000" d="M1 1h14v14H1z"/><path fill="#fff" d="M2 2h12v12H2z"/><path fill="#008000" d="M3 4h1v1h1V4h1V3h1v1H6v1H5v1H4V5H3z"/><path fill="#000" d="M8 4h5v1H8zM5 7h8v1H5zM5 10h8v1H5zM3 7h1v1H3zM3 10h1v1H3z"/><path fill="#808080" d="M8 13h5v0z"/>`,
  "inbox": `<path fill="#000" d="M1 7h4v2h6V7h4v8H1zM3 1h10v6h-1V2H4v5H3z"/><path fill="#ffff9c" d="M2 8h2v2h8V8h2v6H2z"/><path fill="#fff" d="M4 2h8v5h-1v1H5V7H4z"/><path fill="#808080" d="M5 3h6v1H5zM5 5h6v1H5z"/>`,
  "send": `<path fill="#000" d="M1 7L15 1 11 15 8 10z"/><path fill="#fff" d="M3 7l10-4-6 6z"/><path fill="#c0c0c0" d="M8 10l5-7-2 10z"/>`,
  "lock": `<path fill="#000" d="M4 1h8v1h1v5h1v8H2V7h1V2h1zM5 3v4h6V3z"/><path fill="#ffcc00" d="M3 8h10v6H3z"/><path fill="#000" d="M7 10h2v3H7z"/>`,
  "back": `<path fill="#008000" d="M7 2v3h7v6H7v3L1 8z"/><path fill="#000" d="M7 2h1v3h6v1H7zM1 8l6 6v-1L2 8z"/><path fill="#80ff80" d="M7 4v2h6V5H8V3z"/>`,
  "fwd": `<path fill="#008000" d="M9 2v3H2v6h7v3l6-6z"/><path fill="#000" d="M9 2h-1v3H2v1h7zM15 8l-6 6v-1l5-5z"/>`,
  "up": `<path fill="#000" d="M1 3h5l1 1h7v10H1z"/><path fill="#ffff9c" d="M2 4h4l1 1h6v8H2z"/><path fill="#000" d="M7 6h1v1h1v1h1v1H9v3H6V9H5V8h1V7h1z"/>`,
  "publish": `<path fill="#000" d="M2 0h8l3 3v8H2z"/><path fill="#fff" d="M3 1h6v3h3v6H3z"/><path fill="#000" d="M9 9h6v6H9z"/><path fill="#ffcc00" d="M10 10h4v4h-4z"/><path fill="#000" d="M11 11h2v2h-2z"/><path fill="#c00000" d="M11 10h2v1h-2zM11 13h2v1h-2zM10 11h1v2h-1zM13 11h1v2h-1z"/>`,
  "refresh": `<path fill="#000080" d="M8 1h3v1h1v1h1V1h1v5H9V5h2V4h-1V3H6v1H4v2H3v4h1v2h2v1h4v-1h2v-2h1v-1h1v2h-1v2h-2v1H6v-1H4v-1H3v-1H2V5h1V3h1V2h2V1z"/>`,
  "views": `<path fill="#000" d="M1 2h6v5H1zM9 2h6v5H9zM1 9h6v5H1zM9 9h6v5H9z"/><path fill="#9cceff" d="M2 3h4v3H2zM10 3h4v3h-4zM2 10h4v3H2zM10 10h4v3h-4z"/>`,
  "find": `<path fill="#000" d="M3 1h5v1h1v1h1v5H9v1h1v1h1v1h1v1h1v1h1v2h-2v-1h-1v-1h-1v-1h-1V9H8v1H3V9H2V8H1V3h1V2h1z"/><path fill="#9cceff" d="M3 3h5v5H3z"/><path fill="#fff" d="M4 4h1v1H4z"/>`,
  "props": `<path fill="#000" d="M1 1h14v14H1z"/><path fill="#c0c0c0" d="M2 2h12v12H2z"/><path fill="#000080" d="M2 2h12v2H2z"/><path fill="#fff" d="M4 6h8v1H4zM4 9h8v1H4zM4 12h5v1H4z"/>`,
  "msg": `<path fill="#000" d="M1 2h14v9H7l-3 3v-3H1z"/><path fill="#ffffe1" d="M2 3h12v7H6l-1 1v-1H2z"/><path fill="#808080" d="M4 5h8v1H4zM4 7h6v1H4z"/>`,
  "speaker": `<path fill="#000" d="M2 5h3l4-3v12l-4-3H2z"/><path fill="#c0c0c0" d="M3 6h2l3-2v8l-3-2H3z"/><path fill="#000" d="M11 5h1v6h-1zM13 3h1v10h-1z"/>`,
  "net": `<path fill="#000" d="M1 3h7v6H1zM8 8h7v6H8zM4 9h1v2h4v1H4z"/><path fill="#008080" d="M2 4h5v4H2zM9 9h5v4H9z"/>`,
  "run": `<path fill="#000" d="M1 3h14v11H1z"/><path fill="#fff" d="M2 6h12v7H2z"/><path fill="#000080" d="M2 4h12v2H2z"/><path fill="#000" d="M3 8h1v1h1v1H4v1H3zM6 10h4v1H6z"/>`,
  "gear": `<path fill="#000" d="M7 1h2v2h1V2h2v2h-1v1h1v1h2v2h-2v1h-1v1h1v2h-2v-1H9v2H7v-2H6v1H4v-2h1V9H4V8H2V6h2V5h1V4H4V2h2v1h1z"/><path fill="#c0c0c0" d="M6 4h4v1h1v4h-1v1H6V9H5V5h1z"/><path fill="#000" d="M7 6h2v2H7z"/>`,
  "shut": `<path fill="#000" d="M1 2h14v10H1zM5 13h6v1H5z"/><path fill="#000080" d="M2 3h12v8H2z"/><path fill="#ffff00" d="M7 4h2v4H7z"/><path fill="#c00000" d="M4 5h1v4h1v1h4V9h1V5h1v5h-1v1H5v-1H4z"/>`,
  "user": `<path fill="#000" d="M5 1h6v6H5zM2 9h12v6H2z"/><path fill="#ffcc99" d="M6 2h4v4H6z"/><path fill="#000080" d="M3 10h10v4H3z"/>`,
  "help": `<path fill="#000" d="M3 0h10v16H3z"/><path fill="#ffff9c" d="M4 1h8v14H4z"/><path fill="#000080" d="M6 3h4v1h1v3h-1v1H9v2H7V7h1V6h1V4H7v1H6zM7 11h2v2H7z"/>`,
  "min": `<path fill="#000" d="M4 10h6v2H4z"/>`,
  "max": `<path fill="#000" d="M3 2h9v9H3zM4 5v5h7V5z"/>`,
  "res": `<path fill="#000" d="M5 1h7v6h-2V3H5zM3 5h7v6H3zM4 7v3h5V7z"/><path fill="#c0c0c0" d="M6 3h5v3h-1V3z"/>`,
  "x": `<path fill="#000" d="M3 3h2v1h1v1h2V4h1V3h2v1h-1v1H9v1H8v1h1v1h1v1h1v1H9V9H8V8H6v1H5v1H3V9h1V8h1V7h1V6H5V5H4V4H3z"/>`,  "key": `<path fill="#000" d="M3 3h5v1h1v4H8v1H6v5H5v-1H3v-1h2v-1H3v-1h2V9H3V8H2V4h1z"/><path fill="#ffcc00" d="M3 4h5v4H3z"/><path fill="#000" d="M4 5h2v2H4z"/><path fill="#ffcc00" d="M10 7h4v1h1v4h-1v1h-4v-1H9V8h1z"/><path fill="#000" d="M11 9h2v2h-2z"/>`,
} as const;
export type PixelName = keyof typeof PATHS;

/** 像素图标：size 16 原尺寸，32 为 2 倍放大（crispEdges 保持锐利） */
export function PixelIcon({ name, size = 16, className }: { name: PixelName; size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" className={className ? `cl-ico ${className}` : "cl-ico"}
      dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
  );
}

/** 页面类型 → 像素图标 */
export const TONE_PIXEL: Record<Tone, PixelName> = {
  vote: "vote", form: "form", report: "report", flow: "flow", arch: "arch", book: "kb", api: "api", task: "tasks",
};
