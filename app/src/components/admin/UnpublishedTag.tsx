import { adminEt } from "@/i18n/dict/admin";
import ed from "./editor.module.css";

/**
 * „· avaldamata“ after a field's label (README §1.8, the B2 frame „Lühikirjeldus · avaldamata“): a published thing's field whose value waits for
 * „Avalda muudatused“, in 400 12px #6b4f5c (--warn). Give its `id` to the field's aria-describedby: it describes the field and is no part of its name.
 * `hidden`: it stands inside a legend (a group's name), so it is hidden from the name and read only as the description.
 */
export function UnpublishedTag({ id, hidden }: { id: string; hidden?: boolean }) {
  return (
    <span id={id} className={ed.unpublished} data-unpublished-tag="" aria-hidden={hidden || undefined}>
      · {adminEt.publish.fieldTag}
    </span>
  );
}
