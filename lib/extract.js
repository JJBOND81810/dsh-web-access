/**
 * Page-side extraction helpers.
 *
 * Upstream web-access documented two DOM facts that shaped this module:
 * a page holds far more content than it shows (collapsed sections, carousel
 * frames, lazy placeholders), and selector APIs cannot cross shadow roots or
 * iframes. So extraction walks nodes directly, pierces both boundaries, and
 * deliberately does not filter on visibility.
 *
 * The expression is built as a string because it runs inside the page.
 *
 * @module dsh-web-access/extract
 */

/**
 * Tags whose contents are never readable prose.
 *
 * TEXTAREA is here because real pages park large non-prose payloads in hidden
 * form controls: baidu.com stores a 224 KB CSS blob inside a `<textarea>`, and
 * harvesting it both drowns the page text and burns the character budget.
 * Form controls are reported structurally instead (see `out.fields`), so the
 * agent still learns they exist and can read a specific value with web_eval.
 */
const SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'HEAD', 'TEXTAREA']

/**
 * Build the expression that renders one page (or one subtree) as readable text
 * plus the evidence an agent needs to plan its next move.
 * @param options - selector, character budget, and link/heading caps.
 * @returns a self-contained JavaScript expression.
 */
export function extractExpression(options = {}) {
  const selector = options.selector ?? null
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(1000, Math.floor(options.maxChars)) : 60_000
  const maxLinks = Number.isFinite(options.maxLinks) ? Math.max(1, Math.floor(options.maxLinks)) : 200
  const maxHeadings = Number.isFinite(options.maxHeadings) ? Math.max(1, Math.floor(options.maxHeadings)) : 80
  const includeLinks = options.includeLinks !== false
  const includeHeadings = options.includeHeadings !== false

  return `(() => {
  const SELECTOR = ${JSON.stringify(selector)};
  const MAX_CHARS = ${maxChars};
  const MAX_LINKS = ${maxLinks};
  const MAX_HEADINGS = ${maxHeadings};
  const INCLUDE_LINKS = ${includeLinks};
  const INCLUDE_HEADINGS = ${includeHeadings};
  const SKIP = new Set(${JSON.stringify(SKIP_TAGS)});

  const root = SELECTOR ? document.querySelector(SELECTOR) : document.documentElement;
  if (!root) return { error: 'no element matches ' + SELECTOR };

  const out = {
    title: document.title || '',
    url: location.href,
    ready: document.readyState,
    scope: SELECTOR || 'document',
    text: '',
    truncated: false,
    nodes: 0,
    links: [],
    headings: [],
    fields: [],
    meta: {},
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
    jsonLdBlocks: document.querySelectorAll('script[type="application/ld+json"]').length,
  };

  for (const m of document.querySelectorAll('meta')) {
    const key = m.getAttribute('property') || m.getAttribute('name');
    if (!key) continue;
    if (!/^(description|keywords|author|robots|og:|twitter:|article:|product:)/i.test(key)) continue;
    const content = m.getAttribute('content');
    if (content) out.meta[key] = content.slice(0, 400);
  }

  const linkSeen = new Set();
  const parts = [];
  let length = 0;

  // The budget is enforced per pushed piece, not per node: one text node can
  // hold hundreds of kilobytes, and stopping after it is already too late.
  const push = (value) => {
    if (out.truncated) return;
    const piece = value.replace(/\\s+/g, ' ').trim();
    if (!piece) return;
    const remaining = MAX_CHARS - length;
    if (remaining <= 0) { out.truncated = true; return; }
    const kept = piece.length > remaining ? piece.slice(0, remaining) : piece;
    parts.push(kept);
    length += kept.length + 1;
    if (kept.length < piece.length) out.truncated = true;
  };

  // Iterative walk so a deep document cannot overflow the stack, and so a
  // shadow root or same-origin iframe is entered like any other subtree.
  //
  // ELEMENT/TEXT/DOCUMENT/FRAGMENT are distinguished because the two boundaries
  // this module exists to pierce are NOT elements: a shadow root is a
  // DocumentFragment (11) and an iframe's contentDocument is a Document (9).
  // Treating "anything that is not an element" as unreadable therefore dropped
  // both subtrees silently — the frame was counted and never read.
  const ELEMENT = 1; const TEXT = 3; const DOCUMENT = 9; const FRAGMENT = 11;
  const stack = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame.depth > 24 || out.truncated) continue;
    const node = frame.node;
    out.nodes++;
    const kind = node.nodeType;
    if (kind === TEXT) { push(node.nodeValue || ''); continue; }
    if (kind !== ELEMENT && kind !== DOCUMENT && kind !== FRAGMENT) continue;
    const tag = kind === ELEMENT ? node.tagName : '';
    if (kind === ELEMENT && SKIP.has(tag)) continue;

    if (kind === ELEMENT && tag === 'A' && INCLUDE_LINKS) {
      const href = node.href;
      const label = (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160);
      if (href && !href.startsWith('javascript:') && !linkSeen.has(href) && out.links.length < MAX_LINKS) {
        linkSeen.add(href);
        out.links.push({ text: label, url: href });
      }
    }
    if (INCLUDE_HEADINGS && /^H[1-4]$/.test(tag) && out.headings.length < MAX_HEADINGS) {
      const heading = (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      if (heading) out.headings.push(tag + ': ' + heading);
    }
    if (tag === 'IMG' && node.alt) push('[img alt] ' + node.alt);

    // Form controls are reported as structure, never as bulk text: a field's
    // presence and identity help the agent plan an interaction, while its
    // payload is usually a template or a secret.
    if ((tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') && out.fields.length < 25
      && !(tag === 'INPUT' && (node.getAttribute('type') || 'text') === 'hidden')) {
      const type = tag === 'INPUT' ? (node.getAttribute('type') || 'text') : tag.toLowerCase();
      let raw = '';
      if (tag === 'SELECT') raw = node.selectedOptions && node.selectedOptions[0] ? node.selectedOptions[0].textContent || '' : '';
      else if (tag === 'INPUT') raw = type === 'password' || type === 'file' ? '' : node.value || '';
      else raw = node.textContent || '';
      out.fields.push({
        tag,
        type,
        name: node.getAttribute('name') || node.id || '',
        placeholder: node.getAttribute('placeholder') || '',
        required: node.hasAttribute('required'),
        valueLength: String(raw).length,
        value: type === 'password' || type === 'file'
          ? '(redacted)'
          : String(raw).replace(/\\s+/g, ' ').trim().slice(0, 60),
      });
    }

    // Children are pushed in reverse so document order is preserved on pop.
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: frame.depth + 1 });
    if (kind !== ELEMENT) continue;
    if (node.shadowRoot) stack.push({ node: node.shadowRoot, depth: frame.depth + 1 });
    if (tag === 'IFRAME') {
      try {
        const inner = node.contentDocument;
        if (inner) {
          out.iframes = (out.iframes || 0) + 1;
          stack.push({ node: inner, depth: frame.depth + 1 });
        }
      } catch (e) { /* cross-origin frame: not reachable by design */ }
    }
  }

  out.text = parts.join('\\n');
  out.chars = out.text.length;
  out.linkCount = out.links.length;
  return out;
})()`
}

/**
 * Build the expression that samples a <video> element's state, used before
 * seeking and screenshotting individual frames.
 * @param selector - CSS selector for the video element.
 * @returns a self-contained JavaScript expression.
 */
export function videoProbeExpression(selector) {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { error: 'no element matches the selector' };
  if (!(el instanceof HTMLVideoElement)) return { error: 'element is not a <video>' };
  return {
    src: el.currentSrc || el.src || null,
    duration: Number.isFinite(el.duration) ? el.duration : null,
    currentTime: el.currentTime,
    paused: el.paused,
    readyState: el.readyState,
    width: el.videoWidth,
    height: el.videoHeight,
  };
})()`
}

/**
 * Build the expression that seeks one <video> element to a timestamp.
 * @param selector - CSS selector for the video element.
 * @param seconds - target position.
 * @returns a self-contained JavaScript expression.
 */
export function videoSeekExpression(selector, seconds) {
  return `(async () => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { error: 'no element matches the selector' };
  if (!(el instanceof HTMLVideoElement)) return { error: 'element is not a <video>' };
  const target = ${JSON.stringify(Number(seconds) || 0)};
  if (Number.isFinite(el.duration)) el.currentTime = Math.min(target, Math.max(0, el.duration - 0.05));
  else el.currentTime = Math.max(0, target);
  await new Promise((resolve) => {
    if (el.readyState >= 2 && !el.seeking) { resolve(); return; }
    const done = () => { el.removeEventListener('seeked', done); resolve(); };
    el.addEventListener('seeked', done);
    setTimeout(done, 5000);
  });
  return { currentTime: el.currentTime, paused: el.paused, readyState: el.readyState };
})()`
}
