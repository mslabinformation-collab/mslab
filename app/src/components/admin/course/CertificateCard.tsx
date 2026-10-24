"use client";

import { CERT_LIMITS } from "@/domain/certificate";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { ProtocolStagesEditor } from "../ProtocolStagesEditor";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import { PlainField } from "./PlainField";
import type { PartApi } from "./types";

/**
 * „Tunnistus“ (an e-course's card; phase 3d, spec §6): the certificate's lines (none: its „Õpiväljundid“ are printed, `outcomes`) and its volume.
 * Lines added, removed or moved save now; the volume when typing stops or the card is left.
 */
export function CertificateCard({ api, outcomes }: { api: PartApi<"certificate">; outcomes: readonly I18n[] }) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const items = api.fields.certificateSkills;
  return (
    <Card id={CARD_ID.certificate} title={t.sections.certificate} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore} data-certificate-card="">
      <div className={styles.certificate}>
        <p className={ui.muted}>{f.certificateLead}</p>
        <ProtocolStagesEditor
          kind="skills"
          items={items}
          onChange={(v) => (listChange(items, v) === "instant" ? api.commit("certificateSkills", v) : api.set("certificateSkills", v))}
          error={api.error("certificateSkills")}
          outcomes={outcomes}
        />
        <PlainField
          name="certificateVolume"
          label={f.certificateVolume}
          value={api.fields.certificateVolume}
          onChange={(x) => api.set("certificateVolume", x)}
          hint={f.certificateVolumeHint}
          error={api.error("certificateVolume")}
          maxLength={CERT_LIMITS.volume}
          unpublished={api.unpublished("certificateVolume")}
        />
      </div>
    </Card>
  );
}
