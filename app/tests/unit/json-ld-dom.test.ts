// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { JsonLd } from "@/components/site/JsonLd";

// SEO G5: the structured data script cannot be broken out of by a course title, and renders nothing else.

describe("JsonLd", () => {
  test("one script whose text has no </script and parses back to the same object", () => {
    const data = { name: "</script><b>x", nested: { a: ["<!--", "&"] } };
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(JsonLd, { data }));
    expect(host.children).toHaveLength(1);
    const script = host.firstElementChild as HTMLScriptElement;
    expect(script.tagName).toBe("SCRIPT");
    expect(script.getAttribute("type")).toBe("application/ld+json");
    expect(host.innerHTML.toLowerCase().split("</script").length - 1).toBe(1); // only its own closing tag
    expect(script.textContent).not.toContain("<");
    expect(JSON.parse(script.textContent ?? "")).toEqual(data);
  });
});
