import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { reminderRich } from "@domain/messages";
import { renderRich } from "@/lib/richRender";

const html = (s: string) => renderToStaticMarkup(<div>{renderRich(s)}</div>);

describe("renderRich", () => {
  it("renders paragraphs, bold and line breaks", () => {
    const out = html("<p>a<br>b <b>c</b></p>");
    expect(out).toContain("<p");
    expect(out).toContain("<b>c</b>");
    expect(out).toContain("<br/>");
  });

  it("never emits script, style, img, iframe or event handlers", () => {
    const out = html('<p>safe</p><script>alert(1)</script><style>*{}</style><img src=x onerror=alert(1)><iframe src="x"></iframe><a href="javascript:alert(1)" onclick="x()">link</a>');
    expect(out).toContain("safe");
    for (const bad of ["<script", "<style", "<img", "<iframe", "onerror", "onclick", "javascript:", "alert(1)", "<a "]) {
      expect(out.toLowerCase()).not.toContain(bad);
    }
    expect(out).toContain("link"); // unknown tags keep their text
  });

  it("escapes text instead of trusting it", () => {
    const out = html("<p>&lt;b&gt;not bold&lt;/b&gt; &amp; more</p>");
    expect(out).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(out).not.toContain("<b>not bold");
  });

  it("keeps table rows, header cells and right alignment", () => {
    const out = html('<table striped compact><tr><th>Oy</th><th>Qoldiq</th></tr><tr><td>2026-09</td><td align="right">600 000</td></tr></table>');
    expect(out).toContain("<table");
    expect(out.match(/<tr/g)).toHaveLength(2);
    expect(out).toContain("<th");
    expect(out).toContain("600 000");
    expect(out).toContain("text-right");
  });

  it("turns tg-button into an inert, non-focusable look-alike", () => {
    const out = html('<tg-button-row align="center"><tg-button type="callback_data" style="success" data="p:S0005">To\'lov qildim</tg-button></tg-button-row>');
    expect(out).toContain("To&#x27;lov qildim");
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toContain("<button");
    expect(out).not.toContain("p:S0005");
  });

  it("renders the product's real reminder message", () => {
    const out = html(
      reminderRich({
        text: "Assalomu alaykum!\n\nMuddat o'tgan.",
        studentId: "S0005",
        charges: [{ month: "2026-09-01", dueDate: "2026-09-10", outstanding: 600_000 }],
        payInfo: "",
      }),
    );
    expect(out).toContain("Jami qoldiq: 600 000");
    expect(out).toContain("2026-09-10");
    expect(out).not.toContain("tg-");
  });

  it("survives broken or empty markup", () => {
    for (const s of ["", "<", "<<p>", "<p>unclosed", "</p></b>", "<p attr='x>y</p>"]) expect(() => html(s)).not.toThrow();
  });
});
