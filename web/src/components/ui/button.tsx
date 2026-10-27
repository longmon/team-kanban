import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// 胶囊按钮（方向 B）。反馈：悬停轻微提亮，按下缩到 .97 并下沉 1px（主按钮阴影换成按下态），减少动态时 index.css 去掉位移/缩放
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,filter,opacity,translate,scale] outline-none select-none active:translate-y-px active:scale-[.97] active:duration-75 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/80 disabled:pointer-events-none disabled:opacity-50 aria-busy:opacity-80 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-primary hover:brightness-[1.04] active:shadow-primary-press",
        destructive: "bg-destructive text-white hover:brightness-[1.06] dark:text-primary-foreground focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline: "border bg-card hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        "ghost-destructive": "text-destructive hover:bg-destructive/10 focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-full px-3 has-[>svg]:px-2.5",
        xs: "h-7 gap-1 rounded-full px-2.5 text-xs has-[>svg]:px-2",
        lg: "h-10 rounded-full px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

/** loading：显示小 spinner 并禁用，防止重复提交 */
function Button({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }:
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean; loading?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {asChild ? children : <>{loading && <Loader2 className="animate-spin" aria-hidden="true" />}{children}</>}
    </Comp>
  );
}

export { Button, buttonVariants };
