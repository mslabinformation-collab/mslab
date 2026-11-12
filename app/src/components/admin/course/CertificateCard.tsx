"use client";

import Link from "next/link";
import { useId } from "react";
import { CERT_LIMITS } from "@/domain/certificate";
import type { I18n } from "@/i18n/field";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { mediaUrl } from "@/lib/media";
import { ProtocolStagesEditor } from "../ProtocolStagesEditor";
import { UnpublishedTag } from "../UnpublishedTag";
import ui from "../ui.module.css";
import ed from "../editor.module.css";
import styles from "../CourseEditor.module.css";
import { Card } from "./Card";
import { CARD_ID, listChange } from "./course-view";
import { PlainField } from "./PlainField";
import type { CertificateDesignOption, PartApi } from "./types";

/** A design's sample certificate (api/admin/naidistunnistus): Seaded's sample texts drawn in that design. */
const sampleOf = (id: number) => `/api/admin/naidistunnistus?design=${id}`;

/**
 * „Tunnistus“ (an e-course's card; phase 3d, spec §6), in the Kursus board's order (UX pass 11.11 A9): its lead, the certificate's title (empty: the
 * course's, `courseName`, its placeholder), „Kujundus“ (2026-11-11 certificate designs, spec §5.2: the design its certificates are drawn in, from
 * Seaded's list, `designs`, the first first and „(vaikimisi)“; the design's picture before the select and „Vaata näidist ↗“ after it), its volume,
 * and last, under a line, its lines (none: its „Õpiväljundid“ are printed, `outcomes`). None picked shows the first design, which is the one a
 * certificate then gets, so picking the first saves none (null): a course without a pick that is set to it again equals live, with no „· avaldamata“
 * (review round 1). Lines added, moved, removed or brought back and a design picked save now (the part's commit); the title and the volume when
 * typing stops or the card is left.
 */
export function CertificateCard({
  api,
  outcomes,
  designs = [],
  courseName = "",
}: {
  api: PartApi<"certificate">;
  outcomes: readonly I18n[];
  designs?: readonly CertificateDesignOption[];
  courseName?: string;
}) {
  const t = adminEt.courseEditor;
  const f = t.fields;
  const uid = useId();
  const items = api.fields.certificateSkills;
  const picked = api.fields.certificateDesignId;
  // none picked, or one not in the list any more: the first design (what the issue takes)
  const design = designs.find((d) => d.id === picked) ?? designs[0];
  const shown = design?.id;
  const designError = api.error("certificateDesignId");
  const unpublished = api.unpublished("certificateDesignId");
  const describedBy = [unpublished ? `${uid}-design-unpublished` : "", `${uid}-design-hint`, designError ? `${uid}-design-error` : ""].filter(Boolean).join(" ");
  return (
    <Card id={CARD_ID.certificate} title={t.sections.certificate} onLeave={api.flush} conflict={api.conflict} onRestore={api.restore} data-certificate-card="">
      <p className={`${ui.hint} ${styles.certificateLead}`}>{f.certificateLead}</p>
      <div className={styles.certificate}>
        <PlainField
          name="certificateTitle"
          label={f.certificateTitle}
          value={api.fields.certificateTitle}
          onChange={(x) => api.set("certificateTitle", x)}
          hint={f.certificateTitleHint}
          error={api.error("certificateTitle")}
          maxLength={CERT_LIMITS.title}
          unpublished={api.unpublished("certificateTitle")}
          placeholder={courseName.trim() || undefined}
        />
        {design && (
          <div className={`${ui.field} ${ed.i18n}`} data-unpublished={unpublished ? "" : undefined} data-certificate-design="">
            <div className={ed.i18nHead}>
              <label htmlFor={`${uid}-design`}>{f.certificateDesign}</label>
              {unpublished && <UnpublishedTag id={`${uid}-design-unpublished`} />}
            </div>
            <div className={styles.designRow}>
              <span className={styles.designThumb} role="img" aria-label={fill(f.certificateDesignThumb, { name: design.name })} data-design-thumb="" data-tone={design.tone ?? "light"}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a 62 px picture of the design's photo, no optimisation needed */}
                {design.backgroundKey ? <img src={mediaUrl(design.backgroundKey)} alt="" /> : null}
              </span>
              <select
                id={`${uid}-design`}
                className={`${ui.input} ${ed.select} ${ed.short}`}
                value={String(shown)}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  api.commit("certificateDesignId", id === designs[0]?.id ? null : id);
                }}
                aria-invalid={designError ? true : undefined}
                aria-describedby={describedBy}
                data-field="certificateDesignId"
              >
                {designs.map((d, i) => (
                  <option key={d.id} value={String(d.id)}>
                    {i === 0 ? fill(f.certificateDesignDefault, { name: d.name }) : d.name}
                  </option>
                ))}
              </select>
              <a className={styles.designSample} href={sampleOf(design.id)} target="_blank" rel="noopener" data-design-sample="">
                {f.certificateDesignSample} <span aria-hidden="true">↗</span>
              </a>
            </div>
            <p id={`${uid}-design-hint`} className={ui.hint}>
              {f.certificateDesignHint} <Link href="/admin/seaded#tunnistus">{f.certificateDesignLink}</Link>.
            </p>
            {designError && (
              <p id={`${uid}-design-error`} className={ui.error} data-field-error="">
                {designError}
              </p>
            )}
          </div>
        )}
        <PlainField
          name="certificateVolume"
          label={f.certificateVolume}
          value={api.fields.certificateVolume}
          onChange={(x) => api.set("certificateVolume", x)}
          hint={f.certificateVolumeHint}
          error={api.error("certificateVolume")}
          maxLength={CERT_LIMITS.volume}
          unpublished={api.unpublished("certificateVolume")}
          placeholder={f.certificateVolumePlaceholder}
          short
        />
        <div className={styles.certificateSkills}>
          <ProtocolStagesEditor
            kind="skills"
            items={items}
            onChange={(v) => (listChange(items, v) === "instant" ? api.commit("certificateSkills", v) : api.set("certificateSkills", v))}
            onUpdate={(fn) => api.update("certificateSkills", fn)}
            unpublished={api.unpublished("certificateSkills")}
            error={api.error("certificateSkills")}
            outcomes={outcomes}
          />
        </div>
      </div>
    </Card>
  );
}
