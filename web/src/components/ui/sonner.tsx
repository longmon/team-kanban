import { Toaster as Sonner, type ToasterProps } from "sonner";

/** theme 由外层传入（App 自管亮/暗色，不用 next-themes） */
function Toaster(props: ToasterProps) {
  return (
    <Sonner className="toaster group"
      style={{ "--normal-bg": "var(--popover)", "--normal-text": "var(--popover-foreground)", "--normal-border": "var(--border)" } as React.CSSProperties}
      {...props} />
  );
}

export { Toaster };
