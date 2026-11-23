import { Fragment, type ReactNode } from "react";

/**
 * Renders the small HTML subset of Telegram rich messages (as produced by sheets/src/domain/messages.ts) as React
 * elements. It never uses innerHTML: unknown tags keep their text but lose the tag and every attribute, and
 * script/style content is dropped. Buttons are inert look-alikes.
 */

interface El {
  tag: string;
  attrs: string;
  children: Node[];
}
type Node = string | El;

const VOID = new Set(["br", "hr"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template"]);
const TOKEN = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)|</g;

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
}

function parse(html: string): Node[] {
  const root: El = { tag: "#root", attrs: "", children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1]!;
  for (const m of html.matchAll(TOKEN)) {
    const [, close, name, attrs, text] = m;
    if (text !== undefined) {
      top().children.push(decode(text));
    } else if (name === undefined) {
      top().children.push("<");
    } else if (close) {
      const tag = name.toLowerCase();
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
    } else {
      const el: El = { tag: name.toLowerCase(), attrs: attrs ?? "", children: [] };
      top().children.push(el);
      if (!VOID.has(el.tag) && !/\/\s*$/.test(el.attrs)) stack.push(el);
    }
  }
  return root.children;
}

const align = (attrs: string): string => (/align=["']?right/i.test(attrs) ? "text-right" : /align=["']?center/i.test(attrs) ? "text-center" : "text-left");

function renderNode(n: Node, key: number): ReactNode {
  if (typeof n === "string") return n;
  const kids = n.children.map((c, i) => renderNode(c, i));
  switch (n.tag) {
    case "p":
      return <p key={key} className="mb-1.5">{kids}</p>;
    case "h3":
      return <h4 key={key} className="mb-1 mt-1 text-[0.95rem] font-semibold">{kids}</h4>;
    case "b":
      return <b key={key}>{kids}</b>;
    case "i":
      return <i key={key}>{kids}</i>;
    case "br":
      return <br key={key} />;
    case "table":
      return (
        <table key={key} className="my-1.5 w-full border-collapse text-[0.8rem]">
          <tbody>{kids}</tbody>
        </table>
      );
    case "tr":
      return <tr key={key} className="odd:bg-white/5">{kids}</tr>;
    case "th":
      return <th key={key} className={`px-1.5 py-1 font-semibold ${align(n.attrs)}`}>{kids}</th>;
    case "td":
      return <td key={key} className={`px-1.5 py-1 ${align(n.attrs)}`}>{kids}</td>;
    case "tg-time":
      return <span key={key}>{kids}</span>;
    case "tg-button-row":
      return <div key={key} className="mt-2 flex flex-wrap justify-center gap-2">{kids}</div>;
    case "tg-button":
      return (
        <span key={key} role="button" aria-disabled="true" tabIndex={-1} className="rounded-lg bg-white/10 px-3 py-1.5 text-[0.8rem] font-medium">
          {kids}
        </span>
      );
    default:
      return DROP.has(n.tag) ? null : <Fragment key={key}>{kids}</Fragment>;
  }
}

export function renderRich(html: string): ReactNode {
  return parse(html).map((n, i) => renderNode(n, i));
}
