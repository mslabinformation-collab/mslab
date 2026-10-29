"use client";

import { useEffect, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** The box's height to its text: the page keeps its place while the box is measured (see GrowingText). */
function fit(el: HTMLTextAreaElement) {
  const { scrollX, scrollY } = window;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
  if (window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
}

/**
 * A text box that grows with its text (spec §4: "a growing note box"), so a long note is read and edited without a scrollbar of its own; it
 * fits again when the window turns (a tablet rotated) and once the page's fonts are there (a line measured in the fallback font may wrap
 * differently in the site's own). Every other attribute goes to the textarea. The page keeps its place while the box is measured (its height
 * is "auto" for a moment, which would pull a page scrolled to its end up by the box's height).
 */
export function GrowingText({ value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const again = () => fit(el);
    again();
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, [value]);
  useEffect(() => {
    let on = true;
    // (document.fonts: every browser the admin runs in; none in some test environments)
    void document.fonts?.ready.then(() => {
      if (on && ref.current) fit(ref.current);
    });
    return () => void (on = false);
  }, []);
  return <textarea ref={ref} rows={3} value={value} {...props} />;
}
