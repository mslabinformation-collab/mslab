import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContactBlock } from "@/components/site/ContactBlock";
import { trainerSettings } from "@/components/site/settings";
import { isHttpsUrl } from "@/domain/site-editor";
import ui from "@/components/site/ui.module.css";
import { getSiteSettings } from "@/server/site-data";
import { getDict, isLocale } from "@/i18n/locales";
import { mediaUrl } from "@/lib/media";
import styles from "./contact.module.css";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const d = getDict(locale);
  return { title: `${d.footer.contact} — ${d.common.siteName}`, description: d.forms.contactPageLead };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** "+372 5555 5555" → "tel:+37255555555" */
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

/**
 * Contact (Task 9): the footer's "Kontakt ja koostöö" / "Võta ühendust" target. Page head with the contact details from
 * the settings (e-mail, phone, address, social links — only those that are filled in), then prototype D's contact
 * block with the message form (submitContact: stored as a contact request, then Maria is notified).
 */
export default async function ContactPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const d = getDict(locale);
  const settings = await getSiteSettings();
  const c = (settings.contact && typeof settings.contact === "object" ? settings.contact : {}) as Record<string, unknown>;
  const email = str(c.email);
  const phone = str(c.phone);
  const address = str(c.address);
  const social = [
    ["Instagram", str(c.instagram)],
    ["Facebook", str(c.facebook)],
  ].filter(([, url]) => isHttpsUrl(url)); // the admin stores https addresses only; anything else is not linked
  const trainer = trainerSettings(settings, locale);

  return (
    <>
      <div className={`${ui.wrap} ${styles.head}`}>
        <div>
          <p className={ui.caps}>{d.footer.contact}</p>
          <h1 className={styles.title}>{d.forms.contactPageTitle}</h1>
          <p className={styles.lead}>{d.forms.contactPageLead}</p>
        </div>
        <section className={styles.details} aria-labelledby="contact-details" data-contact-details="">
          <h2 id="contact-details" className={styles.detailsTitle}>
            {d.forms.contactDetails}
          </h2>
          <dl className={styles.list}>
            {email && (
              <div>
                <dt>{d.forms.email}</dt>
                <dd>
                  <a href={`mailto:${email}`}>{email}</a>
                </dd>
              </div>
            )}
            {phone && (
              <div>
                <dt>{d.forms.phone}</dt>
                <dd>
                  <a href={telHref(phone)}>{phone}</a>
                </dd>
              </div>
            )}
            {address && (
              <div>
                <dt>{d.forms.address}</dt>
                <dd>{address}</dd>
              </div>
            )}
            {social.map(([label, url]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")} ↗
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <ContactBlock
        locale={locale}
        person={{ name: trainer.name, photo: mediaUrl(trainer.contactPhotoKey), crop: trainer.contactPhotoCrop }}
        t={{
          eyebrow: d.home.contactEyebrow,
          title: d.forms.contactBlockTitle,
          lead: d.forms.contactBlockLead,
          name: d.forms.name,
          email: d.forms.email,
          message: d.forms.message,
          messagePlaceholder: d.forms.messagePlaceholder,
          submit: d.forms.submit,
          sending: d.forms.sending,
          sent: d.forms.contactSent,
          errorRequired: d.forms.errorRequired,
          errorEmail: d.forms.errorEmail,
          errorTooMany: d.forms.errorTooMany,
          errorGeneric: d.forms.errorGeneric,
        }}
      />
    </>
  );
}
