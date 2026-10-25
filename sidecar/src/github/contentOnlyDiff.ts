import type { JsxAttribute, Node, SourceFile } from 'typescript';
import type { ContentPolicy } from '../repos/registry.js';

/**
 * Whether a pull request only changes content: copy, numbers and asset links
 * on pages (issue #701). Such a PR may be merged on the word of anyone who
 * could have asked for the change, without the usual review, so the check
 * errs towards "no": a file it cannot read, parse or place is not content.
 *
 * A file passes when its old and new versions are the same program once the
 * literals in content positions are masked out: page text, copy attributes
 * like `alt` or `href`, and values inside data objects and arrays. A literal
 * that is a variable's whole value, a return value, compared, passed to a
 * call or used as a key stays as it is, so changing it is a change of
 * behaviour. A masked value that changed must not look like code or markup.
 */
export type ContentOnlyVerdict =
  /** `headSha` is the commit that was read: a merge must be of that commit and no later one. */
  | { contentOnly: true; files: string[]; headSha: string }
  | {
      contentOnly: false;
      /** For the logs. */
      reason: string;
      /**
       * What kept it from counting: a file that is more than content, too many
       * files, a base other than the default branch, or a diff that could not
       * be read.
       */
      kind: 'not_content' | 'too_many_files' | 'not_default_base' | 'unreadable';
      /** The files that are more than content, when known. */
      offending?: string[];
      /** How many files the PR changes, when known. */
      fileCount?: number;
    };

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** More files than this is more than a copy edit, whatever they contain. */
export const CONTENT_ONLY_MAX_FILES = 20;
/** GitHub's compare API lists at most this many files; a list that long may be cut. */
const COMPARE_FILE_CAP = 300;
const MAX_FILE_BYTES = 200_000;

/** `**` spans any number of folders (none included), `*` stays within one. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        pattern += '(?:.*/)?';
        i += 2;
      } else {
        pattern += '.*';
        i += 1;
      }
    } else if (char === '*') {
      pattern += '[^/]*';
    } else {
      pattern += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

const matchesAny = (globs: string[], filePath: string) => globs.some(glob => globToRegExp(glob).test(filePath));

/** Whether a path is a TypeScript file a content-only change may touch. */
export function isContentPath(filePath: string, policy: ContentPolicy): boolean {
  if (!/\.tsx?$/.test(filePath) || filePath.endsWith('.d.ts')) return false;
  return matchesAny(policy.allow, filePath) && !matchesAny(policy.deny, filePath);
}

/** Whether a path is a Markdown note that never ships, which a content-only change may edit unread. */
export function isNotePath(filePath: string, policy: ContentPolicy): boolean {
  return filePath.endsWith('.md') && matchesAny(policy.notes, filePath);
}

type Ts = typeof import('typescript');
let tsModule: Promise<Ts> | undefined;
/** Loaded on first use: the compiler is large and only a merge needs it. */
function loadTypescript(): Promise<Ts> {
  tsModule ??= import('typescript').then(module => module.default);
  return tsModule;
}

/**
 * A file that renders raw HTML or loads or runs scripts is never content
 * only: a harmless-looking value in it can end up as code.
 */
const RAW_HTML_OR_SCRIPT =
  /dangerouslySetInnerHTML|<script\b|<Script\b|<iframe\b|<embed\b|<object\b|document\.write|\beval\s*\(|\bnew\s+Function\s*\(|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML/;

/** Elements whose text and attributes are code or load code: never content. */
const CODE_ELEMENTS = new Set(['script', 'Script', 'style', 'iframe', 'link', 'object', 'embed', 'base']);

/** Copy attributes of plain HTML elements (`content` only on a describing <meta>, below). */
const HTML_COPY_ATTRIBUTES = new Set(['alt', 'title', 'placeholder', 'label', 'href', 'src', 'srcSet', 'poster']);
/** Copy props of components: exact names, and names ending in one of the suffixes. */
const COMPONENT_COPY_PROPS = new Set([
  'title',
  'subtitle',
  'heading',
  'subheading',
  'eyebrow',
  'tagline',
  'label',
  'text',
  'description',
  'caption',
  'cta',
  'alt',
  'href',
  'src',
  'image',
  'placeholder',
]);
const COMPONENT_COPY_SUFFIX = /[a-z0-9](?:Text|Label|Title|Heading|Subtitle|Description|Caption|Copy|Alt|Cta)$/;
/** <meta> tags whose `content` is words on the page or in a preview. */
const DESCRIBING_META =
  /^(?:description|keywords|title|og:title|og:description|og:image|og:image:alt|twitter:title|twitter:description|twitter:image)$/i;

/**
 * Keys and variable names whose values set behaviour, styling, tracking or
 * where data goes, not words on the page.
 */
const KNOB_NAMES = new Set([
  'classname',
  'class',
  'classes',
  'style',
  'styles',
  'id',
  'key',
  'ref',
  'type',
  'name',
  'htmlfor',
  'target',
  'rel',
  'role',
  'variant',
  'variants',
  'size',
  'color',
  'colors',
  'theme',
  'tokens',
  'as',
  'method',
  'action',
  'loading',
  'priority',
  'strategy',
  'sizes',
  'fill',
  'layout',
  'objectfit',
  'objectposition',
  'tabindex',
  'dangerouslysetinnerhtml',
  '__html',
  'iframe',
  'embed',
  'script',
  'scripts',
  'html',
  'css',
  'robots',
  'googlebot',
  'split',
  'enabled',
  'disabled',
  'weight',
  'ratio',
  'rollout',
  'traffic',
  'allocation',
  'probability',
  'cookie',
  'cookies',
  'storage',
  'media',
  'query',
  'params',
  'headers',
  'cache',
  'webhook',
  // Next.js route segment config.
  'dynamic',
  'dynamicparams',
  'revalidate',
  'runtime',
  'fetchcache',
  'preferredregion',
  'maxduration',
]);
const KNOB_WORDS =
  'ids?|keys?|events?|arms?|variants?|endpoints?|apis?|ms|delay|timeout|interval|duration|seconds|secs|threshold|urls?|uris?|cookies?|media|class|classes|classname|storage|scripts?|html|css|styles?|configs?|settings|flags?|tests?|experiments?|params?|query|regexp?|pattern|selector|attr|attribute|tokens?|secrets?|webhooks?|offset|cutoff|hours?|minutes?|limit|max|min';
/** `FORM_ID`, `lead_url`, `ENDPOINTS`: the last word of a snake or kebab name. */
const KNOB_SUFFIX_SNAKE = new RegExp(`(?:^|[_-])(?:${KNOB_WORDS})$`, 'i');
/** `formId`, `submitUrl`, `popupDelayMs`: the last word of a camel-case name. */
const KNOB_SUFFIX_CAMEL = new RegExp(
  `[a-z0-9](?:${KNOB_WORDS.split('|')
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join('|')})$`,
);
/** A link to an image or document is an asset, not where data goes. */
const ASSET_URL_NAME = /(?:image|img|photo|logo|icon|thumb|banner|video|poster|avatar|brochure|pdf)/i;

function isKnobName(name: string | undefined): boolean {
  if (!name) return true;
  if (KNOB_NAMES.has(name.toLowerCase()) || name.startsWith('data-')) return true;
  if (!KNOB_SUFFIX_SNAKE.test(name) && !KNOB_SUFFIX_CAMEL.test(name)) return false;
  // `heroImageUrl`, `brochureUrl`: an asset link, which is content.
  return !(/ur[li]s?$/i.test(name) && ASSET_URL_NAME.test(name));
}

/** Decodes the HTML character references a browser would, in JSX text and attributes. */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    colon: ':',
    tab: '\t',
    newline: '\n',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    sol: '/',
    period: '.',
    lpar: '(',
    rpar: ')',
    semi: ';',
  };
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, entity: string) => named[entity.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** A link that runs or embeds something rather than going somewhere, however it is spelled. */
export function isActiveUrl(text: string): boolean {
  // Browsers drop whitespace and control characters inside a scheme.
  const squeezed = decodeEntities(text).replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0020\u007f-\u009f\u00a0\u200b-\u200d\u2028\u2029\ufeff]/g,
    '',
  );
  return /^(?:javascript|vbscript|data):/i.test(squeezed);
}

/** A changed value that reads like code or markup is not a copy edit. */
export function looksLikeCode(text: string): boolean {
  const plain = decodeEntities(text);
  return (
    /<\/?[a-z!]|[{};]|=>|\bfunction\s*\(/i.test(plain) ||
    /\b(?:document|window|localStorage|sessionStorage|navigator)\s*\.|\b(?:eval|fetch|alert|setTimeout)\s*\(/.test(
      plain,
    ) ||
    isActiveUrl(text)
  );
}

function nameText(ts: Ts, name: Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

function tagNameOf(ts: Ts, element: Node | undefined): string | undefined {
  if (!element) return undefined;
  if (ts.isJsxElement(element)) return element.openingElement.tagName.getText();
  if (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) return element.tagName.getText();
  return undefined;
}

/** The literal value of another attribute on the same element, when it is a plain string. */
function siblingAttributeText(ts: Ts, attribute: JsxAttribute, wanted: string): string | undefined {
  for (const other of attribute.parent.properties) {
    if (!ts.isJsxAttribute(other) || nameText(ts, other.name) !== wanted) continue;
    return other.initializer && ts.isStringLiteral(other.initializer) ? other.initializer.text : undefined;
  }
  return undefined;
}

/**
 * Whether an attribute is copy, by an allow list: on a plain element only
 * the attributes that hold words, links or images; on a component only props
 * whose names say they hold words.
 */
function isCopyAttribute(ts: Ts, attribute: JsxAttribute): boolean {
  const name = nameText(ts, attribute.name);
  const tag = tagNameOf(ts, attribute.parent.parent);
  if (!name || !tag || CODE_ELEMENTS.has(tag)) return false;
  if (name.startsWith('aria-')) return true;
  const plainElement = /^[a-z]/.test(tag) && !tag.includes('.');
  if (!plainElement) return COMPONENT_COPY_PROPS.has(name) || COMPONENT_COPY_SUFFIX.test(name);
  if (HTML_COPY_ATTRIBUTES.has(name)) return true;
  if (name !== 'content' || tag !== 'meta') return false;
  if (siblingAttributeText(ts, attribute, 'httpEquiv') !== undefined) return false;
  const described = siblingAttributeText(ts, attribute, 'name') ?? siblingAttributeText(ts, attribute, 'property');
  return described !== undefined && DESCRIBING_META.test(described);
}

/**
 * Whether a literal sits where its value is content: text in JSX, a copy
 * attribute, or a value inside an object or array that is assigned to a
 * variable, exported, or passed as a copy prop. A literal that is a
 * variable's whole value, a return value or an arrow's body is compared as
 * written: such a constant is as likely a delay, a URL or a key as words. A
 * template with `${}` is content only as JSX text or a copy attribute.
 */
function isContentPosition(ts: Ts, node: Node, template = false): boolean {
  let child: Node = node;
  let parent: Node | undefined = node.parent;
  let inContainer = false;
  while (parent) {
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      if (parent.expression !== child) return false;
    } else if (ts.isConditionalExpression(parent)) {
      if (parent.condition === child) return false;
    } else if (ts.isArrayLiteralExpression(parent)) {
      if (template) return false;
      inContainer = true;
    } else if (ts.isPropertyAssignment(parent)) {
      if (template || parent.initializer !== child || isKnobName(nameText(ts, parent.name))) return false;
      inContainer = true;
      // Up to the object literal holding this property.
      parent = parent.parent;
    } else if (ts.isJsxAttribute(parent)) {
      return parent.initializer === child && isCopyAttribute(ts, parent);
    } else if (ts.isJsxExpression(parent)) {
      const holder = parent.parent;
      if (ts.isJsxAttribute(holder)) return isCopyAttribute(ts, holder);
      if (ts.isJsxFragment(holder)) return true;
      return ts.isJsxElement(holder) && !CODE_ELEMENTS.has(tagNameOf(ts, holder) ?? '');
    } else if (ts.isVariableDeclaration(parent)) {
      return inContainer && parent.initializer === child && !isKnobName(nameText(ts, parent.name));
    } else if (ts.isExportAssignment(parent)) {
      return inContainer;
    } else {
      return false;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function isSignedNumber(ts: Ts, node: Node): boolean {
  return (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    (ts.isNumericLiteral(node.operand) || ts.isBigIntLiteral(node.operand))
  );
}

function isJsxNode(ts: Ts, node: Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

const CLOSERS = new Set(['}', ']', ')', '>']);

/**
 * The file as tokens, comments and whitespace dropped and content literals
 * replaced by their kind, with the masked values alongside in order; or
 * undefined when it does not parse.
 */
export async function contentMasked(
  source: string,
  fileName: string,
): Promise<{ tokens: string[]; values: string[] } | undefined> {
  const ts = await loadTypescript();
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file: SourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  // Not in the public typings, but set on every parsed file.
  const diagnostics = (file as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) return undefined;

  const tokens: string[] = [];
  const values: string[] = [];
  const mask = (token: string, value: string) => {
    tokens.push(token);
    values.push(value);
  };
  const visit = (node: Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isJsxText(node)) {
      if (node.containsOnlyTriviaWhiteSpaces) return;
      // The body of a <script> or <style> is code, compared as written.
      if (CODE_ELEMENTS.has(tagNameOf(ts, node.parent) ?? '')) tokens.push(node.text.replace(/\s+/g, ' ').trim());
      else mask('<text>', node.text.replace(/\s+/g, ' ').trim());
      return;
    }
    // What a formatter adds when a longer text no longer fits on one line:
    // parentheses around JSX and `{' '}` between words and tags.
    if (ts.isParenthesizedExpression(node) && isJsxNode(ts, node.expression)) {
      visit(node.expression);
      return;
    }
    if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      node.expression &&
      (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) &&
      node.expression.text.trim() === ''
    ) {
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isActiveUrl(node.text) && isContentPosition(ts, node)) {
        mask('<string>', node.text);
        return;
      }
    } else if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      // A signed number is masked whole, as the unary expression.
      if (!isSignedNumber(ts, node.parent) && isContentPosition(ts, node)) {
        mask('<number>', node.getText(file));
        return;
      }
    } else if (isSignedNumber(ts, node)) {
      if (isContentPosition(ts, node)) {
        mask('<number>', node.getText(file));
        return;
      }
    } else if (ts.isTemplateExpression(node)) {
      const pieces = [node.head.text, ...node.templateSpans.map(span => span.literal.text)];
      if (!isActiveUrl(node.head.text) && isContentPosition(ts, node, true)) {
        // The text around each `${}` is content; the expressions are not.
        mask('<template>', pieces.join('${}'));
        for (const span of node.templateSpans) {
          tokens.push('${');
          visit(span.expression);
          tokens.push('}');
        }
        tokens.push('</template>');
        return;
      }
    }
    const children = node.getChildren(file);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(node.getText(file));
      return;
    }
    for (const childNode of children) visit(childNode);
  };
  visit(file);
  // A trailing comma, which a formatter adds when a list breaks over lines, changes nothing.
  return { tokens: tokens.filter((token, index) => token !== ',' || !CLOSERS.has(tokens[index + 1] ?? '')), values };
}

/**
 * Whether two versions of a file differ only in content: the same program
 * once content literals are masked, with no changed value that reads like
 * code or markup, in a file that renders no raw HTML and loads no scripts.
 * Undefined when either version does not parse.
 */
export async function differsOnlyInContent(base: string, head: string, fileName: string): Promise<boolean | undefined> {
  const [before, after] = await Promise.all([contentMasked(base, fileName), contentMasked(head, fileName)]);
  if (!before || !after) return undefined;
  if (RAW_HTML_OR_SCRIPT.test(base) || RAW_HTML_OR_SCRIPT.test(head)) return false;
  if (before.tokens.length !== after.tokens.length) return false;
  if (!before.tokens.every((token, index) => token === after.tokens[index])) return false;
  return before.values.every((value, index) => {
    const next = after.values[index];
    return value === next || (!looksLikeCode(value) && !looksLikeCode(next));
  });
}

function encodePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

/** Reads whether a pull request is content-only under a repo's policy. Never throws. */
export async function checkContentOnlyPr(params: {
  owner: string;
  repo: string;
  number: number;
  githubToken: string;
  policy: ContentPolicy;
  fetcher?: Fetcher;
  /** Stops the reads: a cancelled run reads no more of GitHub. */
  signal?: AbortSignal;
}): Promise<ContentOnlyVerdict> {
  const { owner, repo, number, githubToken, policy, signal } = params;
  const fetcher = params.fetcher ?? fetch;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const get = (url: string, accept = 'application/vnd.github+json') => {
    if (signal?.aborted) throw new Error('cancelled');
    const timeout = AbortSignal.timeout(15_000);
    return fetcher(url, {
      headers: { Accept: accept, Authorization: `Bearer ${githubToken}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  };
  const unreadable = (reason: string, fileCount?: number): ContentOnlyVerdict => ({
    contentOnly: false,
    kind: 'unreadable',
    reason,
    ...(fileCount !== undefined ? { fileCount } : {}),
  });

  try {
    const prResponse = await get(`${api}/pulls/${number}`);
    if (!prResponse.ok) return unreadable(`GitHub answered ${prResponse.status} for the pull request.`);
    const pr = (await prResponse.json()) as {
      state?: string;
      head?: { sha?: string };
      base?: { ref?: string; repo?: { default_branch?: string } };
    };
    const headSha = pr.head?.sha;
    const baseRef = pr.base?.ref;
    const defaultBranch = pr.base?.repo?.default_branch;
    if (pr.state !== 'open' || !headSha || !baseRef) return unreadable('The pull request is not open.');
    if (!defaultBranch || baseRef !== defaultBranch) {
      return {
        contentOnly: false,
        kind: 'not_default_base',
        reason: `It merges into ${baseRef}, not the default branch ${defaultBranch ?? '(unknown)'}.`,
      };
    }

    // The files and merge base of the exact commit that would be merged.
    const compareResponse = await get(`${api}/compare/${encodePath(baseRef)}...${headSha}`);
    if (!compareResponse.ok) return unreadable(`GitHub answered ${compareResponse.status} for the comparison.`);
    const compare = (await compareResponse.json()) as {
      merge_base_commit?: { sha?: string };
      files?: Array<{ filename?: string; status?: string }>;
    };
    const mergeBase = compare.merge_base_commit?.sha;
    const files = compare.files;
    if (!mergeBase || !Array.isArray(files) || files.length === 0) return unreadable('GitHub gave no comparison.');
    if (files.length > CONTENT_ONLY_MAX_FILES) {
      return {
        contentOnly: false,
        kind: 'too_many_files',
        reason: `It changes ${files.length >= COMPARE_FILE_CAP ? `${COMPARE_FILE_CAP} or more` : files.length} files.`,
        fileCount: files.length,
      };
    }

    const allowed = (filePath: string) => isContentPath(filePath, policy) || isNotePath(filePath, policy);
    const misplaced = files
      .filter(file => !file.filename || file.status !== 'modified' || !allowed(file.filename))
      .map(file => file.filename ?? '(unnamed file)');
    if (misplaced.length > 0) {
      return {
        contentOnly: false,
        kind: 'not_content',
        reason: 'It adds, removes or renames files, or changes files outside content.',
        offending: misplaced,
        fileCount: files.length,
      };
    }

    const readAt = async (filePath: string, ref: string): Promise<string | undefined> => {
      const response = await get(
        `${api}/contents/${encodePath(filePath)}?ref=${ref}`,
        'application/vnd.github.raw+json',
      );
      if (!response.ok) return undefined;
      const text = await response.text();
      return Buffer.byteLength(text) > MAX_FILE_BYTES ? undefined : text;
    };

    const changed: string[] = [];
    const names = files.map(file => file.filename as string);
    // Notes never reach the site, so only the code files are read.
    for (const filePath of names.filter(name => !isNotePath(name, policy))) {
      const [before, after] = await Promise.all([readAt(filePath, mergeBase), readAt(filePath, headSha)]);
      if (before === undefined || after === undefined) {
        return unreadable(`Couldn't read ${filePath} (missing, unreadable or too large).`, files.length);
      }
      const same = await differsOnlyInContent(before, after, filePath);
      if (same === undefined) return unreadable(`Couldn't parse ${filePath}.`, files.length);
      if (!same) changed.push(filePath);
    }
    if (changed.length > 0) {
      return {
        contentOnly: false,
        kind: 'not_content',
        reason: 'It changes code, not only text, numbers or links.',
        offending: changed,
        fileCount: files.length,
      };
    }
    return { contentOnly: true, files: names, headSha };
  } catch (error) {
    if (signal?.aborted) return unreadable('The run was cancelled.');
    return unreadable(`Couldn't read the diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}
