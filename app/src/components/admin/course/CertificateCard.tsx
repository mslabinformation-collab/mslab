"use client";

import { useId } from "react";
import { CERT_LIMITS } from "@/domain/certificate";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { ProtocolStagesEditor } from "../ProtocolStagesEditor";
import { UnpublishedTag } from "../UnpublishedTag";
import ui from "../ui.module.css";
import ed from "../editor.module.css";
import styles from "../CourseEditor.module.css";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import { PlainField } from "./PlainField";
import type { CertificateDesignOption, PartApi } from "./types";

/**
 * „Tunnistus“ (an e-course's card; phase 3d, spec §6): the certificate's title (empty: the course's), its lines (none: its „Õpiväljundid“ are printed, `outcomes`) and its volume,
 * and „Kujundus“ (2026-11-11 certificate designs, spec §5.2): the design its certificates are drawn in, from Seaded's list (`designs`, the first
 * first); none picked shows the first design, which is the one a certificate then gets. Lines added, moved, removed or brought back and a design
 * picked save now (the part's commit); the title and the volume when typing stops or the card is left.
 */
export function CertificateCard({ api, outcomes, designs = [] }: { api: PartApi<"certificate">; outcomes: readonly I18n[]; designs?: readonly CertificateDesignOption[] }) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const uid = useId();
  const items = api.fields.certificateSkills;
  const picked = api.fields.certificateDesignId;
  // none picked, or one not in the list any more: the first design (what the issue takes)
  const shown = designs.find((d) => d.id === picked)?.id ?? designs[0]?.id;
  const designError = api.error("certificateDesignId");
  const unpublished = api.unpublished("certificateDesignId");
  const describedBy = [unpublished ? `${uid}-design-unpublished` : "", `${uid}-design-hint`, designError ? `${uid}-design-error` : ""].filter(Boolean).join(" ");
  return (
    <Card id={CARD_ID.certificate} title={t.sections.certificate} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore} data-certificate-card="">
      <div className={styles.certificate}>
        <p className={ui.muted}>{f.certificateLead}</p>
        <PlainField
          name="certificateTitle"
          label={f.certificateTitle}
          value={api.fields.certificateTitle}
          onChange={(x) => api.set("certificateTitle", x)}
          hint={f.certificateTitleHint}
          error={api.error("certificateTitle")}
          maxLength={CERT_LIMITS.title}
          unpublished={api.unpublished("certificateTitle")}
        />
        <ProtocolStagesEditor
          kind="skills"
          items={items}
          onChange={(v) => (listChange(items, v) === "instant" ? api.commit("certificateSkills", v) : api.set("certificateSkills", v))}
          onUpdate={(fn) => api.update("certificateSkills", fn)}
          unpublished={api.unpublished("certificateSkills")}
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
        {designs.length > 0 && (
          <div className={`${ui.field} ${ed.i18n}`} data-unpublished={unpublished ? "" : undefined} data-certificate-design="">
            <div className={ed.i18nHead}>
              <label htmlFor={`${uid}-design`}>{f.certificateDesign}</label>
              {unpublished && <UnpublishedTag id={`${uid}-design-unpublished`} />}
            </div>
            <select
              id={`${uid}-design`}
              className={`${ui.input} ${ed.select}`}
              value={shown === undefined ? "" : String(shown)}
              onChange={(e) => api.commit("certificateDesignId", Number(e.target.value))}
              aria-invalid={designError ? true : undefined}
              aria-describedby={describedBy}
              data-field="certificateDesignId"
            >
              {designs.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.name}
                </option>
              ))}
            </select>
            <p id={`${uid}-design-hint`} className={ui.hint}>
              {f.certificateDesignHint}
            </p>
            {designError && (
              <p id={`${uid}-design-error`} className={ui.error} data-field-error="">
                {designError}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
