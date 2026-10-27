import * as React from "react";
// animate-ui：拇指位移由 motion 弹簧驱动（按 translate 类算出的位置做 FLIP），按下时拉伸
import { Switch as SwitchPrimitive } from "@animate-ui/react/primitives/radix-ui";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root data-slot="switch"
      className={cn("peer inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/80 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80", className)}
      {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-background ring-0 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
