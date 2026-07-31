/**
 * Minimal, dependency-free XML parser for NCBI E-utilities responses.
 *
 * A small ElementTree-compatible subset, written because Node.js has no
 * built-in XML parser. Supports everything PubMed/MeSH XML actually uses:
 * elements + attributes, self-closing tags, CDATA, comments, processing
 * instructions, DOCTYPE (with internal subsets), and entity decoding
 * (predefined + numeric, decoded in a single pass so `&#38;lt;` stays
 * literal `&lt;`).
 *
 * API mirrors Python's xml.etree.ElementTree for the parts pubmed.ts uses:
 *   - `find(path)` / `findall(path)` with `Child`, `A/B`, `.//Descendant`
 *   - `text`  (direct text content)
 *   - `textContent` (all descendant text, like ElementTree.itertext())
 *   - `get(attr, default)`, `children`, `name`, `attrs`, `parent`
 */

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

/** Decode XML entities in a single pass (correct nested-escape semantics). */
function decodeEntities(s: string): string {
  return s.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith("#x")) {
        return String.fromCodePoint(parseInt(body.slice(2), 16));
      }
      if (body.startsWith("#")) {
        return String.fromCodePoint(parseInt(body.slice(1), 10));
      }
      switch (body) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "amp":
          return "&";
        default:
          return match; // leave unknown entities untouched
      }
    },
  );
}

export class XmlElement {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: XmlElement[] = [];
  parent: XmlElement | null;

  /** Direct text content (text nodes between child elements), decoded. */
  private directText = "";

  constructor(name: string, attrs: Record<string, string>, parent: XmlElement | null) {
    this.name = name;
    this.attrs = attrs;
    this.parent = parent;
  }

  appendText(s: string): void {
    this.directText += s;
  }

  /** Direct text content — mirrors ElementTree `.text` for plain-text elements. */
  get text(): string {
    return this.directText;
  }

  /** All descendant text concatenated — mirrors ElementTree `.itertext()`. */
  get textContent(): string {
    let out = this.directText;
    for (const c of this.children) out += c.textContent;
    return out;
  }

  /** Attribute lookup with a default, mirrors ElementTree `.get(attr, default)`. */
  get(attr: string, def = ""): string {
    return this.attrs[attr] ?? def;
  }

  /**
   * Find the first matching descendant element.
   * Paths: `"Child"`, `"A/B"`, `".//Anywhere"`, `"A//B"`.
   */
  find(path: string): XmlElement | null {
    return this.findAll(path)[0] ?? null;
  }

  /**
   * Find all matching descendant elements.
   * Paths: `"Child"` (direct children), `"A/B"` (nested),
   * `".//Anywhere"` (any depth), `"A//B"` (B under A at any depth).
   */
  findAll(path: string): XmlElement[] {
    // Normalize: "./X" -> "X", ".//X" -> "//X"
    let p = path;
    if (p.startsWith(".//")) p = p.slice(1);
    else if (p.startsWith("./")) p = p.slice(2);
    const tokens = p.split("/");

    const results: XmlElement[] = [];

    const match = (el: XmlElement, i: number): void => {
      if (i === tokens.length) {
        results.push(el);
        return;
      }
      const tok = tokens[i];
      if (tok === "") {
        // "//" — descendant search for the next token at any depth below el
        const next = tokens[i + 1];
        if (next === undefined) {
          results.push(el);
          return;
        }
        const stack: XmlElement[] = [el];
        while (stack.length > 0) {
          const node = stack.pop()!;
          for (const c of node.children) {
            if (c.name === next) match(c, i + 2);
            stack.push(c);
          }
        }
        return;
      }
      for (const c of el.children) {
        if (c.name === tok) match(c, i + 1);
      }
    };

    match(this, 0);
    return results;
  }
}

/** Find the index of the tag-closing `>` starting after `from`, honoring quotes. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function parseTag(content: string): {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
} {
  const selfClosing = content.endsWith("/");
  const body = selfClosing ? content.slice(0, -1) : content;
  const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(body.trimStart());
  if (!nameMatch) {
    throw new XmlParseError(`Invalid tag: <${content}>`);
  }
  const name = nameMatch[0];
  const attrs: Record<string, string> = {};
  const rest = body.slice(nameMatch[0].length);
  const attrRe = /([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(rest)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return { name, attrs, selfClosing };
}

/**
 * Parse an XML document into an element tree.
 * Returns the document's root element (e.g. `PubmedArticleSet`), matching
 * Python's `xml.etree.ElementTree.fromstring()` semantics.
 */
export function parseXml(xml: string): XmlElement {
  const root = new XmlElement("__document__", {}, null);
  let current = root;
  let pos = 0;
  const len = xml.length;

  // Strip UTF-8 BOM
  if (xml.charCodeAt(0) === 0xfeff) pos = 1;

  while (pos < len) {
    const lt = xml.indexOf("<", pos);
    if (lt === -1) {
      current.appendText(decodeEntities(xml.slice(pos)));
      break;
    }
    if (lt > pos) {
      current.appendText(decodeEntities(xml.slice(pos, lt)));
    }

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlParseError("Unterminated comment");
      pos = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlParseError("Unterminated CDATA");
      current.appendText(xml.slice(lt + 9, end));
      pos = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlParseError("Unterminated processing instruction");
      pos = end + 2;
    } else if (/^<!DOCTYPE/i.test(xml.slice(lt, lt + 9))) {
      // Skip DOCTYPE, tolerating an internal subset `[...]` containing '>'
      let i = lt + 9;
      let depth = 0;
      while (i < len) {
        const c = xml[i];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
        i++;
      }
      if (i >= len) throw new XmlParseError("Unterminated DOCTYPE");
      pos = i + 1;
    } else if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) throw new XmlParseError("Unterminated closing tag");
      const name = xml.slice(lt + 2, end).trim();
      if (current.name !== name) {
        throw new XmlParseError(
          `Mismatched closing tag: expected </${current.name}> got </${name}> at offset ${lt}`,
        );
      }
      current = current.parent ?? root;
      pos = end + 1;
    } else {
      const end = findTagEnd(xml, lt + 1);
      if (end === -1) throw new XmlParseError("Unterminated opening tag");
      const { name, attrs, selfClosing } = parseTag(xml.slice(lt + 1, end));
      const el = new XmlElement(name, attrs, current);
      current.children.push(el);
      if (!selfClosing) current = el;
      pos = end + 1;
    }
  }

  if (current !== root) {
    throw new XmlParseError(`Unclosed element <${current.name}>`);
  }
  // Like ElementTree.fromstring(): return the document's root element,
  // not the virtual __document__ wrapper.
  if (root.children.length === 0) {
    throw new XmlParseError("No root element found");
  }
  return root.children[0];
}
