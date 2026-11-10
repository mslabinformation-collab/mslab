"use client";

import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Lightbox, type LightboxImage, type LightboxTexts } from "./Lightbox";
import styles from "./WorksGallery.module.css";

export type WorksTexts = LightboxTexts & { title: string; open: string };

/**
 * "Koolitaja tööd" under the trainer's portrait (Maria C29 / T2): a small carousel of her works — three per view on
 * desktop, tablets and phones alike (Maria 10.11: "kas saaks telefoni ja tahvlisse ka kolm panna"). Arrows move one image; swipe is the native
 * scroll with snap. Clicking an image opens it full size in the shared Lightbox.
 */
export function WorksGallery({ images, t }: { images: LightboxImage[]; t: WorksTexts }) {
  const id = useId();
  const track = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const [open, setOpen] = useState<number | null>(null);

  // Arrow state from the scroll position; runs on scroll and whenever the track resizes (also right after mount).
  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const start = el.scrollLeft < 4;
    const end = el.scrollLeft + el.clientWidth > el.scrollWidth - 4;
    setEnds((p) => (p.start === start && p.end === end ? p : { start, end }));
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure]);

  // The arrows stay focusable at the ends (aria-disabled, not disabled), so keyboard focus is never dropped to the page.
  const scroll = (dir: 1 | -1) => {
    if (dir === -1 ? ends.start : ends.end) return;
    const el = track.current;
    const item = el?.firstElementChild as HTMLElement | null;
    if (!el || !item) return;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * (item.getBoundingClientRect().width + gap), behavior: reduce ? "auto" : "smooth" });
  };

  if (images.length === 0) return null;
  const scrolls = !(ends.start && ends.end);

  return (
    <section className={styles.works} data-works="" aria-labelledby={`${id}-title`}>
      <div className={styles.head}>
        <h2 id={`${id}-title`} className={styles.title}>
          {t.title}
        </h2>
        {scrolls && (
          <div className={styles.arrows} data-fab-avoid="">
            <button type="button" className={styles.arrow} onClick={() => scroll(-1)} aria-disabled={ends.start || undefined} aria-label={t.previous}>
              <Icon name="chevronLeft" size={18} />
            </button>
            <button type="button" className={styles.arrow} onClick={() => scroll(1)} aria-disabled={ends.end || undefined} aria-label={t.next}>
              <Icon name="chevronRight" size={18} />
            </button>
          </div>
        )}
      </div>
      <ul ref={track} className={styles.track} data-works-track="">
        {images.map((img, i) => (
          <li key={img.src + i} className={styles.item} data-work="">
            <button type="button" className={styles.thumb} onClick={() => setOpen(i)} aria-label={img.alt ? `${t.open}: ${img.alt}` : t.open}>
              <Image className={styles.image} src={img.src} alt="" fill unoptimized sizes="(max-width: 860px) 50vw, 15vw" />
            </button>
          </li>
        ))}
      </ul>
      {open !== null && <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} t={t} />}
    </section>
  );
}
