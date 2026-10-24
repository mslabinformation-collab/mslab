import type { CourseType } from "@/domain/course-editor";
import type { EditorPart, EditorParts, PartValues } from "@/domain/course-parts";

// The course editor's shapes (admin UX pass piece 3a, Task 7; README B2): what the page hands over for a saved course, and the one way every card works
// on its part, whether the part autosaves (a saved course, course/useCoursePart.ts) or waits in the page for „Lisa koolitus“ (a new course,
// course/useLocalParts.ts). Types only.

/** Another course, for „Soovitused“. */
export type OtherCourse = { id: number; title: string; type: CourseType; published: boolean };

/** A saved course as its editor starts (page.tsx; server/course-parts.ts readCourseEditor). */
export type CourseEditorData = {
  id: number;
  /** The course's live address: „Vaata lehel ↗“ and the preview (a drafted address is live only after „Avalda muudatused“). */
  slug: string;
  published: boolean;
  isSample: boolean;
  /** Sessions, registrations, lessons or access: the type cannot change (the server refuses it too). */
  typeLocked: boolean;
  /** The type the course has live: with the lock, the other type's radio is disabled. */
  liveType: CourseType;
  /** Every card's part: its version, its value (the draft's, else live's) and live's value. */
  parts: EditorParts;
  /** The PublishBar's labels of the modules' and lessons' changes (their own card's; courseChanges). */
  outline: string[];
};

export type PartField<P extends EditorPart> = keyof PartValues[P] & string;

/** A card's way to its part: what it shows and how it changes it. */
export type PartApi<P extends EditorPart> = {
  fields: PartValues[P];
  /** A typed change: saved 1.5 s after the last one, or when the card is left (its blur). */
  set: <K extends PartField<P>>(name: K, value: PartValues[P][K]) => void;
  /** An instant change (a radio, a switch, a select, a row added, moved or removed, a picture uploaded): saved now (README §1.3). */
  commit: <K extends PartField<P>>(name: K, value: PartValues[P][K]) => void;
  /**
   * A change worked out from the field as it is when it lands (`fn` gets it then: an upload that ends after other changes adds to the list as it is
   * by then); a list's rows added, removed or moved save now, a text typed in a row waits.
   */
  update: <K extends PartField<P>>(name: K, fn: (current: PartValues[P][K]) => PartValues[P][K]) => void;
  /** Saves now: the card's blur. */
  flush: () => void;
  /** The words of a field's refusal (its check), or undefined. */
  error: (name: string) => string | undefined;
  /** The field's value waits for „Avalda muudatused“: a published course's draft differs from live there (README §1.8, „· avaldamata“). */
  unpublished: (name: string) => boolean;
  /** Another tab or device saved this part meanwhile: „Taasta minu tekst“ (`restore`) saves this card's text over it (README §1.3, B13). */
  conflict: boolean;
  restore: () => void;
  /** The part needs a look (a field held back, a conflict, gone): its section map entry says „Kontrolli“. */
  attention: boolean;
};

export type CourseParts = { [P in EditorPart]: PartApi<P> };
