// SEO G5: one structured data script (JSON-LD). It renders nothing on the page. `<` is written as < so that no text in the data (a course title
// with "</script>") can end the script early; the JSON means the same.
export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
