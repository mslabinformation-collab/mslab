"use client";

import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/**
 * A text box that grows with its text (spec §4: "a growing note box"), so a long note is read and edited without a scrollbar of its own; it
 * fits again when the window turns (a tablet rotated). Every other attribute goes to the textarea. The page keeps its place while the box is
 * measured (its height is "auto" for a moment, which would pull a page scrolled to its end up by the box's height).
 */
export function GrowingText({ value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const { scrollX, scrollY } = window;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
      if (window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [value]);
  return <textarea ref={ref} rows={3} value={value} {...props} />;
}
